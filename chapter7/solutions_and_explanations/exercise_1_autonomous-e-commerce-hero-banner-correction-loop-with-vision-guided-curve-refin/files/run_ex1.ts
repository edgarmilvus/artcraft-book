/**
 * run_ex1.ts — harness for the Exercise 1 banner loop.
 *
 * Unit-tests the pixel/translation helpers, then drives the real loop
 * against photocraft-cli with a scripted vision model.
 *
 * Run: photocraft-cli on PATH, then `npx tsx run_ex1.ts`.
 */

import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PNG } from "pngjs";
import {
  BannerJob,
  Frame,
  VisionCritique,
  VisionFn,
  centreCropPng,
  downscale,
  meanLuminance,
  productRgb,
  runBannerJob,
  ssdBetween,
  translateToBatch,
  validateAgainstHistogram,
} from "./01_banner-loop.js";

const ROOT = process.cwd();
const BASE = resolve(ROOT, "..");
const INPUT = resolve(ROOT, "input");
const OUT = resolve(BASE, "output", "ex1");

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

function approx(label: string, actual: number, expected: number, eps = 1e-6): void {
  ok(label, Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);
}

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function frame(width: number, height: number, rgb: [number, number, number]): Frame {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = rgb[0];
    data[i * 4 + 1] = rgb[1];
    data[i * 4 + 2] = rgb[2];
    data[i * 4 + 3] = 255;
  }
  return { width, height, data };
}

function decode(buffer: Buffer): Frame {
  const png = PNG.sync.read(buffer);
  return {
    width: png.width,
    height: png.height,
    data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength),
  };
}

function critique(over: Partial<VisionCritique> = {}): VisionCritique {
  return {
    critique_category: "exposure",
    reasoning: "the render is flat",
    confidence: 0.9,
    proposed_fix: { kind: "curves", points: [[0, 20], [64, 80], [192, 200], [255, 255]] },
    footprint_pct: 60,
    ...over,
  };
}

function visionScript(verdicts: VisionCritique[]): { vision: VisionFn; calls: number } {
  const pending = [...verdicts];
  const state = { calls: 0 };
  const vision: VisionFn = async (input) => {
    state.calls++;
    const audit = Buffer.from(input.auditPngB64, "base64");
    ok("vision: whole-frame preview is a PNG", audit.subarray(0, 8).equals(PNG_SIG));
    const crop = decode(Buffer.from(input.productCropB64, "base64"));
    ok("vision: product crop is smaller than the frame", crop.width < 1536);
    const next = pending.shift();
    if (!next) throw new Error("scripted vision ran out of verdicts");
    return next;
  };
  return {
    get calls() {
      return state.calls;
    },
    vision,
  };
}

function job(master: string): BannerJob {
  return {
    sku: "SKU-1",
    masterPng: master,
    referenceColorHex: "#808080",
    brandLuminanceBand: [62, 74],
    maxIterations: 5,
    confidenceFloor: 0.72,
  };
}

async function makeFixture(): Promise<string> {
  mkdirSync(INPUT, { recursive: true });
  const client = new Client({ name: "fixture", version: "1" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: "photocraft-cli",
    args: ["mcp", "--automation-read-root", ROOT, "--automation-write-root", ROOT],
    cwd: ROOT,
  }));
  const call = async (name: string, args: Record<string, unknown>): Promise<any> => {
    const reply = await client.callTool({ name, arguments: args });
    const text = (reply.content as Array<{ type: string; text?: string }>)
      .find((b) => b.type === "text")?.text ?? "";
    if ((reply as { isError?: boolean }).isError) throw new Error(text);
    return JSON.parse(text);
  };
  try {
    await call("doc_new", { width: 1920, height: 1080, background: "white" });
    await call("command_run", { id: "layer.newFillLayer.solidColor", params: { color: "#808080" } });
    await call("doc_save", { path: "input/hero.png" });
  } finally {
    await client.close();
  }
  return resolve(INPUT, "hero.png");
}

function testPixels(): void {
  const gray = frame(2, 1, [128, 128, 128]);
  equal("pixels: mean luma of mid-grey", meanLuminance(gray), 128);
  const half = frame(2, 1, [0, 0, 0]);
  half.data[4] = 255;
  half.data[5] = 255;
  half.data[6] = 255;
  approx("pixels: mean luma averages pixels", meanLuminance(half), 127.5);

  const tinted = frame(10, 10, [10, 20, 30]);
  equal("pixels: product mean keeps the red channel", productRgb(tinted)[0], 10);
  equal("pixels: product mean keeps the blue channel", productRgb(tinted)[2], 30);

  const crop = decode(centreCropPng(frame(100, 50, [90, 90, 90]), 0.4));
  equal("pixels: centre crop width", crop.width, 40);
  equal("pixels: centre crop height", crop.height, 20);

  const small = downscale(frame(200, 100, [1, 2, 3]), 50);
  equal("pixels: downscale max edge", Math.max(small.width, small.height), 50);

  equal("pixels: identical frames have zero SSD", ssdBetween(gray, frame(2, 1, [128, 128, 128])), 0);
  equal("pixels: black vs white is maximal SSD",
    ssdBetween(frame(2, 1, [0, 0, 0]), frame(2, 1, [255, 255, 255])), 1);
}

function testTranslation(): void {
  equal("translate: curves creates one layer",
    translateToBatch({ kind: "curves", points: [[0, 0], [255, 255]] })[0].id,
    "layer.newAdjustmentLayer.curves");
  equal("translate: channel curve is per-channel",
    (translateToBatch({ kind: "curves", points: [[0, 0], [255, 255]], channel: "red" })[0].params as any).red.length,
    2);

  const local = translateToBatch({
    kind: "localized_curves",
    points: [[0, 0], [255, 255]],
    mask_rect: [10, 20, 110, 220],
  });
  equal("translate: localized edit selects first", local[0].id, "select.rect");
  equal("translate: localized edit masks the curve", (local[0].params as any).width, 100);
  equal("translate: localized edit deselects afterwards", local[2].id, "select.deselect");

  const heal = translateToBatch({ kind: "content_aware_fill", rect: [0, 0, 100, 50] });
  equal("translate: content-aware fill uses the real command", heal[0].id, "edit.contentAwareFill");
  equal("translate: content-aware area keeps width", (heal[0].params as any).area[2], 100);

  const crop = translateToBatch({ kind: "crop", rect: [10, 10, 500, 400] });
  equal("translate: crop keeps pixels recoverable", (crop[0].params as any).deleteCroppedPixels, false);
}

function testHistogramGate(): void {
  const inBand = { meanLuminance: 68, productRgb: [120, 120, 120] as [number, number, number] };
  const gated = validateAgainstHistogram(critique(), inBand, job("x"));
  equal("histogram: in-band global curve is dropped", gated.proposed_fix, null);
  equal("histogram: dropping halves confidence", gated.confidence, 0.45);

  const blueCast = { meanLuminance: 68, productRgb: [100, 100, 130] as [number, number, number] };
  const refused = validateAgainstHistogram(
    critique({ critique_category: "color_balance" }), blueCast, job("x"));
  equal("histogram: blue-cast product refuses colour fixes", refused.proposed_fix, null);
}

function auditFiles(dir: string, iterations: number[]): void {
  for (const i of iterations) {
    for (const suffix of ["before.png", "critique.json", "ssd.json"]) {
      ok(`audit: iteration ${i} ${suffix}`, existsSync(resolve(dir, `iteration_${i}_${suffix}`)));
    }
  }
}

async function scenarioConverge(master: string): Promise<void> {
  const dir = resolve(OUT, "converge");
  const script = visionScript([
    critique({ confidence: 0.9 }),
    critique({ critique_category: "none", proposed_fix: null, confidence: 0.95 }),
  ]);
  const run = await runBannerJob(job(master), dir, {
    vision: script.vision, readRoot: BASE, writeRoot: BASE,
  });

  equal("converge: outcome", run.outcome, "converged");
  equal("converge: two records", run.records.length, 2);
  equal("converge: first cycle applied one command", run.records[0].batch.length, 1);
  ok("converge: first cycle changed pixels", run.records[0].ssd > 0);
  equal("converge: first cycle did not escalate", run.records[0].escalated, false);
  equal("converge: second cycle converged", run.records[1].converged, true);
  equal("converge: two vision calls", script.calls, 2);

  auditFiles(dir, [0, 1]);
  ok("converge: after PNG recorded", existsSync(resolve(dir, "iteration_0_after.png")));
  ok("converge: batch JSON recorded", existsSync(resolve(dir, "iteration_0_batch.json")));
  ok("converge: audit ledger exists", existsSync(resolve(dir, "audit.ndjson")));
  equal("converge: ledger has two lines",
    readFileSync(resolve(dir, "audit.ndjson"), "utf8").trim().split("\n").length, 2);
  ok("converge: result saved", existsSync(resolve(dir, "result.png")));
  const result = decode(readFileSync(resolve(dir, "result.png")));
  equal("converge: result keeps the canvas width", result.width, 1920);
}

async function scenarioLowConfidence(master: string): Promise<void> {
  const dir = resolve(OUT, "low-confidence");
  const script = visionScript([
    critique({ confidence: 0.3 }),
    critique({ confidence: 0.3 }),
  ]);
  const run = await runBannerJob(job(master), dir, {
    vision: script.vision, readRoot: BASE, writeRoot: BASE,
  });

  equal("confidence: outcome", run.outcome, "escalated");
  equal("confidence: two records", run.records.length, 2);
  equal("confidence: first low critique is a retry", run.records[0].escalated, false);
  equal("confidence: second low critique escalates", run.records[1].escalated, true);
  equal("confidence: no batch was applied", run.records[0].batch.length, 0);
  ok("confidence: a result is still saved", existsSync(resolve(dir, "result.png")));
}

async function scenarioDangerousFootprint(master: string): Promise<void> {
  const dir = resolve(OUT, "dangerous");
  const script = visionScript([
    critique({
      proposed_fix: { kind: "content_aware_fill", rect: [0, 0, 1800, 1000] },
      footprint_pct: 40,
      confidence: 0.95,
    }),
  ]);
  const run = await runBannerJob(job(master), dir, {
    vision: script.vision, readRoot: BASE, writeRoot: BASE,
  });
  equal("danger: outcome", run.outcome, "escalated");
  equal("danger: nothing applied", run.records[0].batch.length, 0);
  equal("danger: escalation recorded", run.records[0].escalated, true);
}

async function scenarioBatchFailure(master: string): Promise<void> {
  const dir = resolve(OUT, "batch-failure");
  const script = visionScript([
    critique({
      proposed_fix: {
        kind: "localized_curves",
        // One anchor is invalid: the engine rejects the curves step, so the
        // batch fails after the selection already landed.
        points: [[0, 0]],
        mask_rect: [100, 100, 600, 500],
      },
      confidence: 0.9,
    }),
    // Second cycle is never reached: the first batch fails and rolls back.
  ]);
  const run = await runBannerJob(job(master), dir, {
    vision: script.vision, readRoot: BASE, writeRoot: BASE,
  });
  equal("batch: outcome", run.outcome, "escalated");
  equal("batch: three commands were attempted", run.records[0].batch.length, 3);
  ok("batch: escalation reason is rollback", (run.reason ?? "").includes("rollback"));
  ok("batch: result still saved", existsSync(resolve(dir, "result.png")));
}

async function scenarioSsdRollback(master: string): Promise<void> {
  const dir = resolve(OUT, "ssd");
  const script = visionScript([critique({ confidence: 0.95 })]);
  const run = await runBannerJob(job(master), dir, {
    vision: script.vision, readRoot: BASE, writeRoot: BASE,
    ssdThreshold: 1e-6,
  });
  equal("ssd: outcome", run.outcome, "escalated");
  equal("ssd: reason is rollback", run.reason, "rollback");
  ok("ssd: measured delta exceeds the threshold", run.records[0].ssd > 1e-6);
  equal("ssd: record is marked escalated", run.records[0].escalated, true);

  const before = decode(readFileSync(resolve(dir, "iteration_0_before.png")));
  const after = decode(readFileSync(resolve(dir, "iteration_0_after.png")));
  equal("ssd: document was restored pixel-for-pixel", ssdBetween(before, after), 0);
}

async function main(): Promise<void> {
  rmSync(INPUT, { recursive: true, force: true });
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  const master = await makeFixture();

  testPixels();
  testTranslation();
  testHistogramGate();

  await scenarioConverge(master);
  await scenarioLowConfidence(master);
  await scenarioDangerousFootprint(master);
  await scenarioBatchFailure(master);
  await scenarioSsdRollback(master);

  writeFileSync(resolve(OUT, "hero.png"), readFileSync(master));
  writeFileSync(resolve(OUT, "report.json"), JSON.stringify({
    exercise: 1,
    engine: "photocraft-cli",
    assertions,
    scenarios: ["converge", "low-confidence", "dangerous", "batch-failure", "ssd"],
    artefacts: ["hero.png", "report.json"],
    result: "banner loop converged; confirmation gate, footprint guard, batch rollback and SSD rollback verified",
  }, null, 2));

  console.log(`\n${assertions} assertions passed`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exitCode = 1;
});
