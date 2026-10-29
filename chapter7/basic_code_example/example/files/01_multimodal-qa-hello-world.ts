/**
 * multimodal-qa-hello-world.ts
 *
 * Minimal closed-loop visual QA against PhotoCraft via MCP.
 *
 * Flow:
 *   1.  Spawn `photocraft-cli mcp` over stdio.
 *   2.  Create a fresh 1024x768 RGB document.
 *   3.  Apply one initial edit (a curves adjustment layer).
 *   4.  Render a preview as a PNG, hand it to a vision model.
 *   5.  Parse the model's JSON verdict with Zod.
 *   6.  If actionable, dispatch corrections via command_batch.
 *   7.  Repeat, bounded by MAX_ITERATIONS.
 *   8.  Save to a .pcraft file and close the session.
 *
 * The vision model is injected, so the loop can be driven by GPT-4o in
 * production and by a scripted auditor in tests and offline demos.
 *
 * Requires (for the default auditor): OPENAI_API_KEY in the environment.
 */

import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import OpenAI from "openai";
import { z } from "zod";

// ─────────────────────────────────────────────────────────────
// Configuration
// ─────────────────────────────────────────────────────────────

/** Hard ceiling on the number of critique→correct cycles. */
const MAX_ITERATIONS = 3;

/** A correction must carry at least this confidence to be dispatched. */
const CONFIDENCE_FLOOR = 0.6;

/** Long edge (px) of the preview handed to the vision model. */
const PREVIEW_MAX_SIDE = 768;

/** Output file — the .pcraft native format keeps every layer intact. */
const OUTPUT_PATH = "output/qa-result.pcraft";

/**
 * Commands the model is allowed to ask for. Every entry creates a new,
 * non-destructive adjustment layer, so a correction never depends on
 * which layer happens to be active when the batch runs.
 */
const ALLOWED_COMMANDS = new Set([
  "layer.newAdjustmentLayer.levels",
  "layer.newAdjustmentLayer.curves",
  "layer.newAdjustmentLayer.brightnessContrast",
  "layer.newAdjustmentLayer.hueSaturation",
]);

// ─────────────────────────────────────────────────────────────
// Schema: the contract between PhotoCraft and the LLM
// ─────────────────────────────────────────────────────────────

/**
 * A single corrective action. `command` MUST be a registered PhotoCraft
 * command id (see the `command_list` meta-tool for the full registry),
 * and `params` MUST match that command's documented JSON shape.
 */
const CorrectionSchema = z.object({
  command: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  confidence: z.number().min(0).max(1).default(1),
});

/**
 * The top-level verdict the vision model is obliged to return.
 *
 * - `ok`               — no further editing is warranted; the loop exits.
 * - `needs_correction` — at least one actionable correction is present.
 */
const VaResultSchema = z.object({
  status: z.enum(["ok", "needs_correction"]),
  reasoning: z.string().max(2000).default(""),
  corrections: z.array(CorrectionSchema).max(8).default([]),
});

export type VaResult = z.infer<typeof VaResultSchema>;
export type Correction = z.infer<typeof CorrectionSchema>;

/** One argument of a `command_batch` step. */
interface BatchStep {
  id: string;
  params: Record<string, unknown>;
}

/**
 * Shape of the `command_batch` payload. The engine is explicit about
 * partial success: `completed` counts the steps that landed, `failed`
 * the ones that did not, and `results` carries one entry per step that
 * the batch attempted.
 */
const BatchResultSchema = z.object({
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  results: z
    .array(
      z.object({
        ok: z.boolean(),
        result: z.unknown().optional(),
        error: z.string().nullable().optional(),
      }),
    )
    .default([]),
});

type BatchResult = z.infer<typeof BatchResultSchema>;

// ─────────────────────────────────────────────────────────────
// Prompt: the system message that shapes the model's output
// ─────────────────────────────────────────────────────────────

/**
 * The system prompt teaches the model (a) what it is looking at,
 * (b) which command IDs it may use, and (c) the exact JSON shape
 * expected. Keeping this short is fine for a Hello World; in
 * production you would inject the live `command_list` output here.
 */
export const SYSTEM_PROMPT = `
You are a senior retoucher auditing a photograph edited in PhotoCraft.
Inspect the rendered preview for: exposure clipping, colour casts,
flat or oversaturated tone curves, and general compositional balance.

Reply ONLY with JSON matching this shape:
{
  "status": "ok" | "needs_correction",
  "reasoning": "one short paragraph",
  "corrections": [
    {
      "command": "<PhotoCraft command id>",
      "params": { /* that command's parameters */ },
      "confidence": 0.0..1.0
    }
  ]
}

Allowed command ids (each one adds a new adjustment layer):
  - layer.newAdjustmentLayer.levels
      params: { inBlack, gamma, inWhite, outBlack, outWhite }
  - layer.newAdjustmentLayer.curves
      params: { points: [[in,out], ...] }   // 2..19 anchors, 0..255
  - layer.newAdjustmentLayer.brightnessContrast
      params: { brightness: -150..150, contrast: -50..100 }
  - layer.newAdjustmentLayer.hueSaturation
      params: { hue: -180..180, saturation: -100..100, lightness: -100..100 }

If the image already looks correct, return "ok" with an empty corrections array.
`.trim();

// ─────────────────────────────────────────────────────────────
// MCP helpers
// ─────────────────────────────────────────────────────────────

/**
 * Runs an ArtCraft engine command through the MCP `command_run` meta-tool.
 */
async function runCommand(
  mcp: Client,
  id: string,
  params: Record<string, unknown> = {},
): Promise<unknown> {
  const res = await mcp.callTool({
    name: "command_run",
    arguments: { id, params },
  });
  return extractText(res);
}

/**
 * Extracts the first text block from an MCP tool result. PhotoCraft
 * returns JSON payloads encoded as text blocks. For image outputs
 * (doc_render_preview) the payload is a separate `image` content block.
 *
 * A refused tool call arrives with `isError: true` and a diagnostic
 * text block; turning that into an exception keeps the call sites
 * free of silent `null` values.
 */
function extractText(res: unknown): unknown {
  const reply = (res ?? {}) as { content?: unknown; isError?: boolean };
  const content = (reply.content ?? []) as Array<
    | { type: "text"; text: string }
    | { type: "image"; data: string; mimeType: string }
  >;
  const textBlock = content.find((c) => c.type === "text") as
    | { type: "text"; text: string }
    | undefined;
  const text = textBlock?.text ?? "";
  if (reply.isError) {
    throw new Error(`MCP tool call failed: ${text || "no diagnostic"}`);
  }
  if (!textBlock) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Pulls the base64-encoded PNG out of a `doc_render_preview` result.
 */
function extractPngBase64(res: unknown): string {
  const reply = (res ?? {}) as { content?: unknown };
  const content = (reply.content ?? []) as Array<
    { type: "image"; data: string; mimeType: string }
  >;
  const img = content.find((c) => c.type === "image");
  if (!img) throw new Error("doc_render_preview returned no image block");
  return img.data;
}

// ─────────────────────────────────────────────────────────────
// LLM critique
// ─────────────────────────────────────────────────────────────

/** Anything that can turn a PNG into a verdict: GPT-4o, a local VLM, a test. */
export type VisionAuditor = (pngBase64: string) => Promise<VaResult>;

/**
 * Parses a model reply into a validated verdict. Separated from the API
 * call so malformed replies can be tested without a network round trip.
 */
export function parseVerdict(raw: string): VaResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Vision model returned malformed JSON (${(err as Error).message}): ` +
        raw.slice(0, 200),
    );
  }
  const verdict = VaResultSchema.safeParse(parsed);
  if (!verdict.success) {
    throw new Error(
      `Vision model returned invalid schema: ${verdict.error.message}`,
    );
  }
  return verdict.data;
}

/**
 * Builds the GPT-4o auditor: sends the rendered PNG in JSON mode and
 * validates the reply. Throws if the model returns malformed JSON or
 * violates the schema.
 */
export function createOpenAiAuditor(
  openai: OpenAI,
  systemPrompt: string = SYSTEM_PROMPT,
): VisionAuditor {
  return async (pngBase64: string): Promise<VaResult> => {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      // Response-format "json_object" makes OpenAI guarantee valid JSON.
      response_format: { type: "json_object" },
      temperature: 0.2,
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            {
              type: "text",
              text: "Audit this render. Reply with the JSON verdict only.",
            },
            {
              type: "image_url",
              image_url: {
                url: `data:image/png;base64,${pngBase64}`,
                detail: "high",
              },
            },
          ],
        },
      ],
    });

    const raw = completion.choices[0]?.message?.content ?? "{}";
    return parseVerdict(raw);
  };
}

// ─────────────────────────────────────────────────────────────
// Main loop
// ─────────────────────────────────────────────────────────────

export interface QaLoopOptions {
  mcp: Client;
  vision: VisionAuditor;
  maxIterations?: number;
  confidenceFloor?: number;
  previewMaxSide?: number;
  outputPath?: string;
  log?: (message: string) => void;
}

export interface QaLoopResult {
  /** How many critique→correct cycles actually started. */
  iterations: number;
  /** Corrections that landed on the document. */
  applied: number;
  /** Corrections rolled back after a mid-batch failure. */
  undone: number;
  /** Where the document ended up. */
  savedPath: string;
  warnings: string[];
  /** Why the loop stopped. */
  reason: "ok" | "confidence_floor" | "batch_failed" | "max_iterations";
}

/**
 * Runs the whole closed loop against a connected PhotoCraft MCP client.
 *
 * The client is owned by the caller: this function never closes it, so
 * the same session can be reused for further work after a run.
 */
export async function runQaLoop(options: QaLoopOptions): Promise<QaLoopResult> {
  const {
    mcp,
    vision,
    maxIterations = MAX_ITERATIONS,
    confidenceFloor = CONFIDENCE_FLOOR,
    previewMaxSide = PREVIEW_MAX_SIDE,
    outputPath = OUTPUT_PATH,
    log = (line: string) => console.log(line),
  } = options;

  // 1. Create a blank document.
  const created = await mcp.callTool({
    name: "doc_new",
    arguments: {
      width: 1024,
      height: 768,
      mode: "rgb",
      depth: 8,
      background: "white",
      name: "QA-Hello-World",
    },
  });
  extractText(created);

  // 2. Seed the document with an initial edit — a deliberately
  //    over-brightened curves layer so the vision model has
  //    something to critique.
  await runCommand(mcp, "layer.newAdjustmentLayer.curves", {
    points: [
      [0, 0],
      [64, 96],
      [192, 210],
      [255, 255],
    ],
  });

  let iterations = 0;
  let applied = 0;
  let undone = 0;
  let reason: QaLoopResult["reason"] = "max_iterations";

  // 3. Bounded critique → correct loop.
  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    iterations = iteration;
    log(`\n── iteration ${iteration} / ${maxIterations} ──`);

    // 3a. Render a preview PNG.
    const preview = await mcp.callTool({
      name: "doc_render_preview",
      arguments: { max_side: previewMaxSide },
    });
    const pngBase64 = extractPngBase64(preview);

    // 3b. Ask the vision model to audit it.
    const verdict = await vision(pngBase64);
    log(`status: ${verdict.status}`);
    log(`reasoning: ${verdict.reasoning}`);

    if (verdict.status === "ok") {
      log("✓ Vision model is satisfied; exiting loop.");
      reason = "ok";
      break;
    }

    // 3c. Keep only known commands above the confidence floor. A model
    //     can invent a plausible id; dispatching it would fail the whole
    //     batch, so unknown ids are dropped here with a warning.
    const actionable: Correction[] = [];
    for (const correction of verdict.corrections) {
      if (correction.confidence < confidenceFloor) continue;
      if (!ALLOWED_COMMANDS.has(correction.command)) {
        log(`⚠ dropping unknown command: ${correction.command}`);
        continue;
      }
      actionable.push(correction);
    }
    if (actionable.length === 0) {
      log("⚠ Model asked for correction but nothing actionable remained.");
      reason = "confidence_floor";
      break;
    }

    log(`dispatching ${actionable.length} correction(s) via command_batch…`);
    const batch = await mcp.callTool({
      name: "command_batch",
      arguments: {
        steps: actionable.map<BatchStep>((c) => ({
          id: c.command,
          params: c.params,
        })),
        stop_on_error: true,
      },
    });
    const batchResult = BatchResultSchema.parse(extractText(batch));
    log(
      `batch result: completed=${batchResult.completed} failed=${batchResult.failed}`,
    );

    // 3d. A batch is not a transaction. With stop_on_error the engine
    //     halts at the first failure, but the steps before it stay
    //     applied. Roll that prefix back so the next iteration audits a
    //     coherent document, then stop: retrying the same corrections
    //     would fail for the same reason.
    if (batchResult.failed > 0) {
      for (let i = 0; i < batchResult.completed; i++) {
        await runCommand(mcp, "edit.undo");
      }
      undone += batchResult.completed;
      log(
        `✗ batch failed after ${batchResult.completed} step(s); ` +
          `undid them and stopping the loop.`,
      );
      reason = "batch_failed";
      break;
    }
    applied += batchResult.completed;
  }

  // 4. Persist the final document. doc_save does not create the parent
  //    directory, so the caller does — the path is resolved and passed
  //    absolutely to remove any doubt about the engine's write root.
  const absolutePath = resolve(outputPath);
  mkdirSync(dirname(absolutePath), { recursive: true });
  const saved = await mcp.callTool({
    name: "doc_save",
    arguments: { path: absolutePath },
  });
  const saveReply = extractText(saved) as { path?: string; warnings?: string[] };
  const savedPath = saveReply?.path ?? absolutePath;
  const warnings = saveReply?.warnings ?? [];
  log(`\nSaved: ${savedPath}`);
  for (const warning of warnings) log(`⚠ ${warning}`);

  return { iterations, applied, undone, savedPath, warnings, reason };
}

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");

  // Spawn the PhotoCraft MCP server over stdio.
  const transport = new StdioClientTransport({
    command: "photocraft-cli",
    args: ["mcp"],
  });
  const mcp = new Client(
    { name: "qa-loop", version: "1.0.0" },
    { capabilities: {} },
  );
  await mcp.connect(transport);

  try {
    const result = await runQaLoop({
      mcp,
      vision: createOpenAiAuditor(new OpenAI({ apiKey })),
    });
    console.log(
      `\nDone: ${result.iterations} iteration(s), ` +
        `${result.applied} correction(s) applied, stopped because ${result.reason}.`,
    );
  } finally {
    // Always tear the server down, even on failure.
    await mcp.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[fatal]", err);
    process.exitCode = 1;
  });
}
