/**
 * run_basic.ts — harness for the Hello World closed loop.
 *
 * Drives `runQaLoop` against a real photocraft-cli MCP server with a
 * scripted vision auditor, so no provider key is needed. Covers:
 *
 *   1. happy path: filter by confidence, reject unknown commands, exit on ok
 *   2. mid-batch failure: the applied prefix is undone before the loop stops
 *   3. confidence floor: nothing actionable → stop without dispatching
 *   4. iteration cap: the loop stops at MAX_ITERATIONS
 *   5. verdict parsing: defaults, malformed JSON, schema violations
 *
 * Run: photocraft-cli must be on PATH, then `npx tsx run_basic.ts`.
 */

import assert from "node:assert/strict";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  parseVerdict,
  runQaLoop,
  type VaResult,
  type VisionAuditor,
} from "./src/qa-hello.js";

const ROOT = process.cwd();
const OUT = resolve(ROOT, "output/basic");

let assertions = 0;

function ok(label: string, condition: boolean, detail = ""): void {
  if (!condition) {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    throw new Error(label);
  }
  assertions++;
  console.log(`PASS ${label}`);
}

function equal<T>(label: string, actual: T, expected: T): void {
  ok(label, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

interface PngSize {
  width: number;
  height: number;
}

function pngSize(base64: string): PngSize {
  const bytes = Buffer.from(base64, "base64");
  ok("preview payload is a PNG", bytes.subarray(0, 8).equals(PNG_SIGNATURE));
  // IHDR always starts at byte 8; width and height are big-endian uint32s.
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

interface ScriptedAuditor {
  vision: VisionAuditor;
  sizes: PngSize[];
}

function scriptedAuditor(script: VaResult[]): ScriptedAuditor {
  const pending = [...script];
  const sizes: PngSize[] = [];
  return {
    sizes,
    vision: async (png: string): Promise<VaResult> => {
      sizes.push(pngSize(png));
      const next = pending.shift();
      if (!next) throw new Error("scripted auditor ran out of verdicts");
      return next;
    },
  };
}

function collector(): { log: (line: string) => void; lines: string[] } {
  const lines: string[] = [];
  return { log: (line: string) => lines.push(line), lines };
}

interface DocState {
  layers: Array<{ kind: string; name: string; selected: boolean }>;
  history: string[];
}

async function inspect(mcp: Client): Promise<DocState> {
  const res = await mcp.callTool({ name: "doc_inspect", arguments: {} });
  const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content.find((block) => block.type === "text")?.text ?? "{}";
  return JSON.parse(text) as DocState;
}

function adjustmentCount(doc: DocState): number {
  return doc.layers.filter((layer) => layer.kind === "Adjustment").length;
}

// ─────────────────────────────────────────────────────────────
// 5. Verdict parsing (no engine required)
// ─────────────────────────────────────────────────────────────

function testParsing(): void {
  const defaults = parseVerdict('{"status":"ok"}');
  equal("parse: missing reasoning defaults to empty", defaults.reasoning, "");
  equal("parse: missing corrections defaults to empty", defaults.corrections.length, 0);

  const filled = parseVerdict(
    JSON.stringify({
      status: "needs_correction",
      corrections: [{ command: "layer.newAdjustmentLayer.levels" }],
    }),
  );
  equal("parse: missing params defaults to {}", Object.keys(filled.corrections[0].params).length, 0);
  equal("parse: missing confidence defaults to 1", filled.corrections[0].confidence, 1);

  assert.throws(() => parseVerdict("{not json"), /malformed JSON/);
  ok("parse: malformed JSON is rejected with the raw payload", true);

  assert.throws(() => parseVerdict('{"status":"maybe"}'), /invalid schema/);
  ok("parse: status outside the enum is rejected", true);

  assert.throws(
    () =>
      parseVerdict(
        JSON.stringify({ status: "ok", corrections: [{ command: "x", confidence: 2 }] }),
      ),
    /invalid schema/,
  );
  ok("parse: confidence above 1 is rejected", true);

  const stripped = parseVerdict('{"status":"ok","extra":"ignored"}');
  ok("parse: unknown top-level keys are stripped", !("extra" in stripped));
}

// ─────────────────────────────────────────────────────────────
// Engine scenarios
// ─────────────────────────────────────────────────────────────

async function scenarioHappyPath(mcp: Client): Promise<void> {
  const script = scriptedAuditor([
    {
      status: "needs_correction",
      reasoning: "Shadows are lifted too far and the render is flat.",
      corrections: [
        {
          command: "layer.newAdjustmentLayer.levels",
          params: { inBlack: 0, gamma: 1.2, inWhite: 255 },
          confidence: 0.9,
        },
        // Dropped by the confidence floor.
        {
          command: "layer.newAdjustmentLayer.curves",
          params: { points: [[0, 0], [255, 255]] },
          confidence: 0.3,
        },
        // Not in the allowlist: would fail the whole batch.
        { command: "image.adjustments.desaturate", params: {}, confidence: 0.95 },
      ],
    },
    { status: "ok", reasoning: "Contrast restored.", corrections: [] },
  ]);
  const log = collector();

  const result = await runQaLoop({
    mcp,
    vision: script.vision,
    outputPath: resolve(OUT, "a-happy.pcraft"),
    log: log.log,
  });

  equal("happy: two iterations", result.iterations, 2);
  equal("happy: only the confidence-cleared known command landed", result.applied, 1);
  equal("happy: nothing needed undoing", result.undone, 0);
  equal("happy: stopped because the critic said ok", result.reason, "ok");
  equal("happy: one preview per iteration", script.sizes.length, 2);
  equal("happy: previews are capped at 768 on the long edge", Math.max(...script.sizes.map((s) => Math.max(s.width, s.height))), 768);
  equal("happy: preview keeps the document aspect ratio", script.sizes[0].height, 576);
  ok("happy: unknown command is reported", log.lines.some((line) => line.includes("dropping unknown command: image.adjustments.desaturate")));
  ok("happy: save path is echoed back", result.savedPath === resolve(OUT, "a-happy.pcraft"));
  equal("happy: save produced no warnings", result.warnings.length, 0);

  const saved = resolve(OUT, "a-happy.pcraft");
  ok("happy: output file exists", existsSync(saved));
  // .pcraft is a zip container.
  ok("happy: output is a .pcraft container", readFileSync(saved).subarray(0, 2).toString("latin1") === "PK");

  const doc = await inspect(mcp);
  equal("happy: document holds background + seed + one correction", doc.layers.length, 3);
  equal("happy: two adjustment layers are stacked", adjustmentCount(doc), 2);
  equal("happy: newest adjustment is selected", doc.layers.filter((l) => l.selected).length, 1);
}

async function scenarioBatchFailure(mcp: Client): Promise<void> {
  const script = scriptedAuditor([
    {
      status: "needs_correction",
      reasoning: "Desaturate slightly, then fix the curve.",
      corrections: [
        {
          command: "layer.newAdjustmentLayer.hueSaturation",
          params: { saturation: -40 },
          confidence: 0.9,
        },
        // One anchor is invalid: the engine rejects this step.
        {
          command: "layer.newAdjustmentLayer.curves",
          params: { points: [[0, 0]] },
          confidence: 0.9,
        },
      ],
    },
  ]);
  const log = collector();

  const result = await runQaLoop({
    mcp,
    vision: script.vision,
    outputPath: resolve(OUT, "b-failed.pcraft"),
    log: log.log,
  });

  equal("batch: one iteration", result.iterations, 1);
  equal("batch: no correction is counted as applied", result.applied, 0);
  equal("batch: the applied prefix was undone", result.undone, 1);
  equal("batch: stopped because the batch failed", result.reason, "batch_failed");
  ok("batch: counts are logged", log.lines.some((line) => line.includes("completed=1 failed=1")));
  ok("batch: the rollback is logged", log.lines.some((line) => line.includes("undid them")));

  const doc = await inspect(mcp);
  equal("batch: document is back to background + seed", doc.layers.length, 2);
  equal("batch: only the seed adjustment remains", adjustmentCount(doc), 1);
  ok("batch: the failed run still saved a document", existsSync(resolve(OUT, "b-failed.pcraft")));
}

async function scenarioConfidenceFloor(mcp: Client): Promise<void> {
  const script = scriptedAuditor([
    {
      status: "needs_correction",
      reasoning: "Maybe warm it up a touch.",
      corrections: [
        {
          command: "layer.newAdjustmentLayer.brightnessContrast",
          params: { brightness: 8 },
          confidence: 0.2,
        },
      ],
    },
  ]);

  const result = await runQaLoop({
    mcp,
    vision: script.vision,
    outputPath: resolve(OUT, "c-floor.pcraft"),
    log: () => {},
  });

  equal("floor: one iteration", result.iterations, 1);
  equal("floor: nothing applied", result.applied, 0);
  equal("floor: stopped at the confidence floor", result.reason, "confidence_floor");
  equal("floor: exactly one preview was rendered", script.sizes.length, 1);

  const doc = await inspect(mcp);
  equal("floor: document untouched beyond the seed", doc.layers.length, 2);
}

async function scenarioIterationCap(mcp: Client): Promise<void> {
  const corrections = [10, 20, 30].map((brightness) => ({
    status: "needs_correction" as const,
    reasoning: `Still flat, try +${brightness}.`,
    corrections: [
      {
        command: "layer.newAdjustmentLayer.brightnessContrast",
        params: { brightness },
        confidence: 0.9,
      },
    ],
  }));
  const script = scriptedAuditor(corrections);

  const result = await runQaLoop({
    mcp,
    vision: script.vision,
    outputPath: resolve(OUT, "d-cap.pcraft"),
    log: () => {},
  });

  equal("cap: three iterations", result.iterations, 3);
  equal("cap: three corrections landed", result.applied, 3);
  equal("cap: stopped at the iteration cap", result.reason, "max_iterations");
  equal("cap: three previews were audited", script.sizes.length, 3);

  const doc = await inspect(mcp);
  equal("cap: all three corrections are on the stack", doc.layers.length, 5);
  equal("cap: four adjustment layers total", adjustmentCount(doc), 4);
}

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });

  testParsing();

  const transport = new StdioClientTransport({
    command: "photocraft-cli",
    args: ["mcp", "--automation-write-root", ROOT],
    cwd: ROOT,
  });
  const mcp = new Client({ name: "qa-harness", version: "1.0.0" }, { capabilities: {} });
  await mcp.connect(transport);

  try {
    await scenarioHappyPath(mcp);
    await scenarioBatchFailure(mcp);
    await scenarioConfidenceFloor(mcp);
    await scenarioIterationCap(mcp);
  } finally {
    await mcp.close();
  }

  console.log(`\n${assertions} assertions passed`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exitCode = 1;
});
