/**
 * psd-smoke-test.ts
 *
 * "Hello World" of automated PSD assembly on top of the PhotoCraft MCP
 * bridge. Safe to import from a Next.js Route Handler, a Remix action,
 * a SvelteKit endpoint, or a plain `tsx` CLI.
 *
 * Responsibilities (one reason to change each, per SRP):
 *   1. Validate the inbound request.
 *   2. Spawn photocraft-cli in MCP mode with a capability-scoped sandbox.
 *   3. Issue one command_batch that stacks layers and a clipping mask.
 *   4. Persist the result as a layered .psd and return a compact summary.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// 1. Contract: what a web request may ask the compositor to do.
//    The engine's document constructor accepts 1..300_000 px per side; fail
//    fast here so we never spawn a child process just to receive its error.
// ---------------------------------------------------------------------------
const ComposeRequestSchema = z.object({
  canvas: z.object({
    width: z.number().int().min(1).max(300_000),
    height: z.number().int().min(1).max(300_000),
  }),
  title: z.string().min(1).max(120),
  /** Absolute path *under* workRoot where the .psd should land. */
  outputPath: z.string().min(1),
  /** The only directory the child process may read or write. */
  workRoot: z.string().min(1),
});
export type ComposeRequest = z.infer<typeof ComposeRequestSchema>;

/**
 * Perceptual tone curve, expressed as identity-adjacent knots on the
 * 0..255 grid that PhotoCraft's curve evaluator expects. These numbers
 * approximate an S-curve in the CIE-L* domain: shadows lift 8 levels,
 * highlights compress 4, and the midpoint stays put so skin tones do
 * not drift. In a real pipeline you would fit these knots from an
 * OkLCh transform (see the chapter's OkLCh section for the math).
 */
const PERCEPTUAL_L_KNOTS: Array<[number, number]> = [
  [0, 8],
  [64, 68],
  [128, 128],
  [192, 188],
  [255, 251],
];

// ---------------------------------------------------------------------------
// 2. Helper: pull a JSON payload out of a tool result without crashing
//    when the bridge returns plain text (e.g. a build failure message).
//    Keeping this in one place means any change to the MCP content-block
//    shape is a single-file edit, not a codebase-wide grep.
// ---------------------------------------------------------------------------
function readJsonContent<T>(result: unknown): T {
  // `content` is optional on the SDK's CallToolResult: a task-based server
  // answers with `toolResult` instead, and that is not JSON we can read.
  const { content, isError } = result as { content?: unknown; isError?: boolean };
  const block = Array.isArray(content)
    ? (content[0] as { type?: string; text?: string })
    : null;
  if (!block || typeof block.text !== "string") {
    throw new Error("MCP tool returned a non-text content block");
  }
  // A refusal arrives as a sentence, not as JSON: surface the engine's own
  // words instead of a SyntaxError from the parser.
  if (isError) throw new Error(block.text);
  return JSON.parse(block.text) as T;
}

// ---------------------------------------------------------------------------
// 3. The compositor.
// ---------------------------------------------------------------------------
export async function composeLayeredPsd(request: unknown) {
  const req: ComposeRequest = ComposeRequestSchema.parse(request);

  // 3a. Spawn the CLI. Note the capability-scoped roots: without them the
  //     engine refuses any file.open / file.save touching real paths.
  const transport = new StdioClientTransport({
    command: "photocraft-cli",
    args: [
      "mcp",
      "--automation-read-root", req.workRoot,
      "--automation-write-root", req.workRoot,
    ],
  });

  const client = new Client(
    { name: "psd-compositor", version: "1.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);

  try {
    // 3b. Create the canvas. doc_new is a first-class MCP tool (not a
    //     registry command) because it bootstraps the undo stack.
    const newDocResult = await client.callTool({
      name: "doc_new",
      arguments: {
        width: req.canvas.width,
        height: req.canvas.height,
        mode: "rgb",
        depth: 8,
        background: "white",
        name: req.title,
      },
    });
    const docInfo = readJsonContent<{ document: number }>(newDocResult);

    // 3c. One round-trip, three layers: a solid backing, a pixel layer
    //     clipped to it, and a lightness curve on top. `clipToPrevious`
    //     is the schema-conformant way to build a clipping mask; the
    //     post-hoc `layer.createClippingMask` command is the fallback.
    const batchResult = await client.callTool({
      name: "command_batch",
      arguments: {
        stop_on_error: true,
        steps: [
          {
            id: "layer.newFillLayer.solidColor",
            params: { color: "#808080" },
          },
          {
            id: "layer.new.layer",
            params: { name: "Clip", clipToPrevious: true },
          },
          {
            id: "layer.newAdjustmentLayer.curves",
            params: {
              points: [[0, 0], [255, 255]],        // identity master curve
              lightness: PERCEPTUAL_L_KNOTS,        // Lab L* channel
              pencil: false,
            },
          },
        ],
      },
    });
    const batch = readJsonContent<{ completed: number; failed: number }>(batchResult);
    if (batch.failed > 0) {
      throw new Error(`Batch reported ${batch.failed} failed steps`);
    }

    // 3d. Read the tree back so callers can assert layer ordering.
    const inspectResult = await client.callTool({
      name: "doc_inspect",
      arguments: { index: docInfo.document },
    });
    const tree = readJsonContent<{ layers?: unknown[] }>(inspectResult);

    // 3e. Persist as layered PSD. Because we pass an explicit path, the
    //     command performs an Export rather than an in-place save.
    const saveResult = await client.callTool({
      name: "doc_save",
      arguments: {
        index: docInfo.document,
        path: req.outputPath,
        format: "psd",
      },
    });
    const saved = readJsonContent<{ path: string; warnings?: string[] }>(saveResult);

    // The reply names the file it wrote but carries no size: measure it.
    const written = isAbsolute(saved.path)
      ? saved.path
      : join(req.workRoot, saved.path);
    const bytes = statSync(written).size;

    return {
      documentIndex: docInfo.document,
      topLevelLayers: Array.isArray(tree.layers) ? tree.layers.length : 0,
      bytes,
      warnings: saved.warnings ?? [],
    };
  } finally {
    // 3f. Kill the child even when the batch threw. StdioClientTransport's
    //     close() also waits for stdout to drain, so no zombies leak.
    await client.close();
  }
}
