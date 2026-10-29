/**
 * run_aperture.ts — harness for the Aperture QA advanced application.
 *
 * Exercises the real PhotoCraft session against a scripted vision
 * auditor, plus the pure units (compiler, convergence, prefilter,
 * pixels). No provider key is required: every model answer is injected.
 *
 * Run: photocraft-cli must be on PATH, then `npx tsx run_aperture.ts`.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  Critique,
  CycleRecord,
  DesignBrief,
} from "./src/contracts.js";
import { PhotoCraftSession } from "./src/session.js";
import { compileBaseEdit, centreCrop } from "./src/base-edit.js";
import { compileCorrections } from "./src/compiler.js";
import { decide, severityScore } from "./src/convergence.js";
import { auditFrame, AuditFn } from "./src/audit.js";
import { prefilter, histogramClipping } from "./src/prefilter.js";
import { decodePngToRgba, meanAbsoluteDelta, RgbaFrame } from "./src/pixels.js";
import { runApertureLoop } from "./src/orchestrator.js";

const ROOT = process.cwd();
const OUT = resolve(ROOT, "output");
const INPUT = resolve(ROOT, "input");
const SOURCE = "input/hero.png";

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

function isPng(base64: string): boolean {
  return Buffer.from(base64, "base64").subarray(0, 8).equals(PNG_SIGNATURE);
}

function critique(over: Partial<Critique> = {}): Critique {
  return { verdict: "revise", confidence: 0.8, findings: [], corrections: [], ...over };
}

function record(
  cycle: number,
  critiqueValue: Critique,
  appliedSteps = 1,
  deltaVsPrev = 0.5,
): CycleRecord {
  return {
    cycle,
    screenshot: "",
    critique: critiqueValue,
    appliedSteps,
    deltaVsPrev,
    durationMs: 5,
    startedAt: "2026-01-01T00:00:00.000Z",
  };
}

function brief(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    jobId: randomUUID(),
    sourcePath: SOURCE,
    targetPath: "output/result.jpg",
    channelProfile: "shopify_hero",
    brandKit: {
      primaryHex: "#3366cc",
      forbiddenHex: ["#ff0000"],
      tone: "editorial_clean",
    },
    maxCycles: 3,
    confidenceFloor: 0.62,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────
// Pure units: pixels, prefilter, compiler, convergence, audit
// ─────────────────────────────────────────────────────────────

function testPixels(): void {
  const a = new Uint8Array([0, 0, 0]);
  const b = new Uint8Array([0, 0, 0]);
  equal("pixels: identical frames have zero delta", meanAbsoluteDelta(a, b), 0);
  const c = new Uint8Array([255, 255, 255]);
  equal("pixels: inverted frames have maximal delta", meanAbsoluteDelta(a, c), 1);
  equal("pixels: length mismatch is maximal delta", meanAbsoluteDelta(a, new Uint8Array(4)), 1);
  equal("pixels: empty frames are zero delta", meanAbsoluteDelta(new Uint8Array(0), new Uint8Array(0)), 0);

  const fixture = readFileSync(resolve(INPUT, "hero.png")).toString("base64");
  const frame = decodePngToRgba(fixture);
  equal("pixels: fixture decodes at source width", frame.width, 1200);
  equal("pixels: fixture decodes at source height", frame.height, 800);
  equal("pixels: RGBA buffer has four bytes per pixel", frame.data.length, frame.width * frame.height * 4);
}

function rgbaFrame(fill: [number, number, number], pixels = 100): RgbaFrame {
  const data = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    data[i * 4] = fill[0];
    data[i * 4 + 1] = fill[1];
    data[i * 4 + 2] = fill[2];
    data[i * 4 + 3] = 255;
  }
  return { data, width: pixels, height: 1 };
}

async function testPrefilter(): Promise<void> {
  const black = histogramClipping(rgbaFrame([0, 0, 0]).data);
  equal("prefilter: black frame is 100 % shadow-clipped", black.shadowClip, 1);
  const white = histogramClipping(rgbaFrame([255, 255, 255]).data);
  equal("prefilter: white frame is 100 % highlight-clipped", white.highlightClip, 1);

  const clipped = await prefilter(rgbaFrame([0, 0, 0]));
  ok("prefilter: crushed shadows are rejected", !clipped.pass);
  ok("prefilter: rejection names shadow clipping", (clipped.reason ?? "").includes("shadow"));
  const blown = await prefilter(rgbaFrame([255, 255, 255]));
  ok("prefilter: blown highlights are rejected", !blown.pass);
  ok("prefilter: rejection names highlight clipping", (blown.reason ?? "").includes("highlight"));

  const neutral = await prefilter(rgbaFrame([128, 128, 128]));
  ok("prefilter: mid-tones pass without a classifier", neutral.pass);
  equal("prefilter: missing CLIP degrades to heuristics", neutral.topLabel, "heuristic-only");

  const embedded = await prefilter(rgbaFrame([128, 128, 128]), { embedding: { data: [0.1] } });
  equal("prefilter: supplied embedding skips the model", embedded.topLabel, "embedding-supplied");

  const negative = await prefilter(rgbaFrame([128, 128, 128]), {
    classifier: {
      classify: async () => [
        { label: "a photograph with conspicuous colour cast", score: 0.91 },
        { label: "a professionally lit product photograph", score: 0.09 },
      ],
    },
  });
  ok("prefilter: confident negative label rejects the frame", !negative.pass);
  ok("prefilter: negative reason quotes the score", (negative.reason ?? "").includes("0.91"));

  const unsure = await prefilter(rgbaFrame([128, 128, 128]), {
    classifier: {
      classify: async () => [{ label: "a photograph with conspicuous colour cast", score: 0.4 }],
    },
  });
  ok("prefilter: an unsure negative label does not reject", unsure.pass);

  const broken = await prefilter(rgbaFrame([128, 128, 128]), {
    loadClassifier: async () => ({
      classify: async () => {
        throw new Error("weights missing");
      },
    }),
  });
  equal("prefilter: classifier failure degrades to heuristics", broken.topLabel, "heuristic-only");
}

function testBaseEdit(): void {
  const crop = centreCrop({ width: 1200, height: 800 }, 2);
  equal("base: landscape source keeps its width", crop.width, 1200);
  equal("base: landscape source is cropped to the aspect", crop.height, 600);
  equal("base: landscape crop is vertically centred", crop.y, 100);

  const portrait = centreCrop({ width: 800, height: 1200 }, 2);
  equal("base: portrait source is cropped vertically", portrait.width, 800);
  equal("base: portrait crop height follows the aspect", portrait.height, 400);
  equal("base: portrait crop is vertically centred", portrait.y, 400);

  const steps = compileBaseEdit(
    brief({ brandKit: { primaryHex: "#3366cc", forbiddenHex: [], tone: "warm_lifestyle" } }) as DesignBrief,
    { width: 1200, height: 800 },
  );
  equal("base: eight deterministic steps", steps.length, 8);
  equal("base: geometry comes first", steps[0].id, "image.crop");
  equal("base: resize follows the crop", steps[1].id, "image.imageSize");
  equal("base: resize lands on the channel box", (steps[1].params as any).width, 2048);
  equal("base: no file.open in the batch", steps.some((s) => s.id === "file.open"), false);
  equal("base: warm tone picks a warming filter", (steps[3].params as any).filter, "warmingLBA");
  equal("base: high-pass runs on a duplicate", steps[5].id, "layer.duplicate");
  equal("base: high-pass follows the duplicate", steps[6].id, "filter.other.highPass");
  equal("base: the overlay is blended back", (steps[7].params as any).blend, "overlay");
}

function testCompiler(): void {
  const warm = compileCorrections(
    critique({
      corrections: [{ command: "warm_up", params: { amount: 20 } }],
      findings: [{ axis: "color", severity: "warn", message: "warm cast on the backdrop" }],
    }),
    2048,
    1024,
  );
  equal("compiler: warm suggestion wins over the heuristic", warm.steps.length, 1);
  equal("compiler: warm suggestion maps to photoFilter", warm.steps[0].id, "layer.newAdjustmentLayer.photoFilter");
  equal("compiler: warm suggestion uses a warming filter", (warm.steps[0].params as any).filter, "warming81");
  equal("compiler: suggestion density is clamped", (warm.steps[0].params as any).density, 20);

  const unknown = compileCorrections(
    critique({ corrections: [{ command: "make_it_pop", params: {} }] }),
    2048,
    1024,
  );
  equal("compiler: unknown suggestion is dropped", unknown.dropped[0], "make_it_pop");
  equal("compiler: revise with no usable step gets the safe move", unknown.steps[0].id, "layer.newAdjustmentLayer.brightnessContrast");
  equal("compiler: safe move is a contrast nudge", (unknown.steps[0].params as any).contrast, 4);

  const advisory = compileCorrections(
    critique({ verdict: "pass", findings: [{ axis: "color", severity: "info", message: "a touch more polish" }] }),
    2048,
    1024,
  );
  equal("compiler: info findings compile nothing", advisory.steps.length, 0);

  const region = compileCorrections(
    critique({
      findings: [{ axis: "exposure", severity: "warn", message: "dark corner", region: [0.1, 0.2, 0.5, 0.6] }],
    }),
    1000,
    500,
  );
  equal("compiler: region opens a selection", region.steps[0].id, "select.rect");
  equal("compiler: region is converted to pixels", (region.steps[0].params as any).x, 100);
  equal("compiler: region height is converted to pixels", (region.steps[0].params as any).height, 200);
  equal("compiler: region closes the selection", region.steps[region.steps.length - 1].id, "select.deselect");

  const composition = compileCorrections(
    critique({ findings: [{ axis: "composition", severity: "warn", message: "loose framing" }] }),
    1000,
    500,
  );
  const cropParams = composition.steps[0].params as any;
  equal("compiler: composition crops a border", cropParams.width, 960);
  ok("compiler: composition crop is non-degenerate", cropParams.width > 0 && cropParams.height > 0);

  const deduped = compileCorrections(
    critique({
      corrections: [
        { command: "add_contrast", params: {} },
        { command: "add_contrast", params: {} },
      ],
      findings: [{ axis: "exposure", severity: "warn", message: "muddy midtones" }],
    }),
    1000,
    500,
  );
  equal("compiler: duplicate suggestions collapse", deduped.steps.length, 1);
  equal("compiler: covered axis skips its heuristic", deduped.steps[0].id, "layer.newAdjustmentLayer.brightnessContrast");

  const vignette = compileCorrections(
    critique({ corrections: [{ command: "add_vignette", params: {} }] }),
    1000,
    500,
  );
  equal("compiler: vignette uses the real gradient command", vignette.steps[0].id, "gradient.fill.create");
  ok("compiler: vignette multiplies over the frame", (vignette.steps[0].params as any).mode === "multiply");
}

function testConvergence(): void {
  const design = brief({ maxCycles: 3, confidenceFloor: 0.62 }) as DesignBrief;

  equal("converge: cold start iterates", decide([], design).kind, "iterate");

  const escalate = decide([record(0, critique({ verdict: "escalate" }))], design);
  equal("converge: model escalation wins", escalate.kind, "escalate");

  const lowPriority = decide([record(0, critique({ verdict: "pass", confidence: 0.3 }))], design);
  equal("converge: low-confidence pass escalates", lowPriority.kind, "escalate");

  const pass = decide([record(0, critique({ verdict: "pass", confidence: 0.9 }))], design);
  equal("converge: confident pass is accepted", pass.kind, "accept");

  const lastChance = decide(
    [record(0, critique({})), record(1, critique({})), record(2, critique({ verdict: "pass", confidence: 0.9 }))],
    design,
  );
  equal("converge: pass on the final allowed cycle is accepted", lastChance.kind, "accept");

  const capped = decide(
    [record(0, critique({})), record(1, critique({})), record(2, critique({}))],
    design,
  );
  equal("converge: revision at the cap escalates", capped.kind, "escalate");
  ok("converge: cap escalation names the limit", (capped as any).reason.includes("max cycles"));

  const regressed = decide(
    [record(0, critique({ findings: [{ axis: "color", severity: "warn", message: "warm cast" }] })),
     record(1, critique({ findings: [
       { axis: "color", severity: "block", message: "brand colour wrong" },
       { axis: "exposure", severity: "block", message: "highlights blown" },
     ] }), 2)],
    design,
  );
  equal("converge: worse severity rolls back", regressed.kind, "rollback");
  equal("converge: rollback undoes this cycle's steps", (regressed as any).stepsToUndo, 2);

  const stalled = decide(
    [record(0, critique({})), record(1, critique({}), 1, 0.001)],
    design,
  );
  equal("converge: a stalled edit rolls back", stalled.kind, "rollback");

  equal("converge: block outweighs five info findings", severityScore(critique({ findings: [
    { axis: "exposure", severity: "block", message: "blown" },
    { axis: "color", severity: "info", message: "a" },
    { axis: "color", severity: "info", message: "b" },
    { axis: "color", severity: "info", message: "c" },
    { axis: "color", severity: "info", message: "d" },
    { axis: "color", severity: "info", message: "e" },
  ] })), 105);
}

async function testAudit(): Promise<void> {
  const ctx = {
    brief: brief({}) as DesignBrief,
    channel: { width: 2048, height: 1024 },
    cycleIndex: 0,
  };

  const valid = await auditFrame("iVBOR", ctx, {
    complete: async () => JSON.stringify({
      verdict: "revise",
      confidence: 0.7,
      findings: [
        { axis: "color", severity: "info", message: "polish" },
        { axis: "exposure", severity: "block", message: "highlights blown" },
        { axis: "color", severity: "warn", message: "warm cast" },
      ],
    }),
  });
  equal("audit: findings are ordered by severity", valid.findings[0].severity, "block");
  equal("audit: warn follows block", valid.findings[1].severity, "warn");

  const many = Array.from({ length: 20 }, (_, i) => ({
    axis: "color" as const, severity: "info" as const, message: `finding ${i}`,
  }));
  const capped = await auditFrame("iVBOR", ctx, {
    complete: async () => JSON.stringify({ verdict: "pass", confidence: 0.9, findings: many }),
  });
  equal("audit: findings are capped at twelve", capped.findings.length, 12);

  await assert.rejects(
    auditFrame("iVBOR", ctx, { complete: async () => "{not json" }),
    /malformed JSON/,
  );
  ok("audit: malformed JSON is rejected", true);

  await assert.rejects(
    auditFrame("iVBOR", ctx, { complete: async () => '{"verdict":"maybe","confidence":0.5,"findings":[]}' }),
    /schema violation/,
  );
  ok("audit: schema violations are rejected", true);
}

// ─────────────────────────────────────────────────────────────
// Engine fixture + session predicates
// ─────────────────────────────────────────────────────────────

async function callText(client: Client, name: string, args: Record<string, unknown>): Promise<any> {
  const res = await client.callTool({ name, arguments: args });
  const content = (res.content ?? []) as Array<{ type: string; text?: string }>;
  const text = content.find((b) => b.type === "text")?.text ?? "";
  if ((res as { isError?: boolean }).isError) throw new Error(`${name}: ${text}`);
  return text ? JSON.parse(text) : null;
}

async function makeFixture(): Promise<void> {
  mkdirSync(INPUT, { recursive: true });
  const client = new Client({ name: "fixture", version: "1" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: "photocraft-cli",
    args: ["mcp", "--automation-read-root", ROOT, "--automation-write-root", ROOT],
    cwd: ROOT,
  }));
  try {
    await callText(client, "doc_new", { width: 1200, height: 800, background: "white" });
    await callText(client, "command_run", {
      id: "layer.newFillLayer.solidColor",
      params: { color: "#7f7f7f" },
    });
    const saved = await callText(client, "doc_save", { path: SOURCE });
    equal("fixture: hero rendered", saved.path, SOURCE);
  } finally {
    await client.close();
  }
}

function auditScript(script: Critique[], seen: { sizes: number[]; cycles: number[] }): AuditFn {
  const pending = [...script];
  return async (png, ctx) => {
    ok("audit: frame is a PNG", isPng(png));
    const frame = decodePngToRgba(png);
    seen.sizes.push(frame.width);
    seen.cycles.push(ctx.cycleIndex);
    const next = pending.shift();
    if (!next) throw new Error("scripted auditor ran out of verdicts");
    return next;
  };
}

async function scenarioAccept(): Promise<void> {
  const seen = { sizes: <number[]>[], cycles: <number[]>[] };
  const run = await runApertureLoop(brief({ targetPath: "output/a-accepted.jpg", maxCycles: 2 }), {
    audit: auditScript([critique({ verdict: "pass", confidence: 0.91 })], seen),
  });
  equal("accept: outcome", run.outcome, "accepted");
  equal("accept: one cycle", run.history.length, 1);
  equal("accept: nothing applied", run.history[0].appliedSteps, 0);
  equal("accept: preview is 1536 on the long edge", seen.sizes[0], 1536);
  equal("accept: base edit applied eight steps", (run.baseEdit as any).completed, 8);
  equal("accept: artifact path echoed", run.artifactPath, "output/a-accepted.jpg");
  const saved = resolve(ROOT, "output/a-accepted.jpg");
  ok("accept: artifact exists", existsSync(saved));
  ok("accept: artifact is a JPEG", readFileSync(saved).subarray(0, 2).toString("hex") === "ffd8");
}

async function scenarioReviseThenPass(): Promise<void> {
  const seen = { sizes: <number[]>[], cycles: <number[]>[] };
  const run = await runApertureLoop(brief({ targetPath: "output/b-revised.jpg" }), {
    audit: auditScript([
      critique({
        confidence: 0.8,
        findings: [{ axis: "color", severity: "warn", message: "warm cast across the backdrop" }],
      }),
      critique({ verdict: "pass", confidence: 0.88 }),
    ], seen),
  });
  equal("revise: outcome", run.outcome, "accepted");
  equal("revise: two cycles", run.history.length, 2);
  equal("revise: first cycle applied one correction", run.history[0].appliedSteps, 1);
  equal("revise: second cycle applied nothing", run.history[1].appliedSteps, 0);
  equal("revise: cycle indexes are sequential", seen.cycles.join(","), "0,1");
  ok("revise: the correction changed pixels", run.history[0].deltaVsPrev > 0.001);
  ok("revise: artifact exists", existsSync(resolve(ROOT, "output/b-revised.jpg")));
}

async function scenarioRollback(): Promise<void> {
  const run = await runApertureLoop(brief({ targetPath: "output/c-rollback.jpg" }), {
    audit: auditScript([
      critique({ findings: [{ axis: "exposure", severity: "warn", message: "muddy midtones" }] }),
      critique({
        confidence: 0.75,
        findings: [
          { axis: "exposure", severity: "block", message: "highlights blown on the hero" },
          { axis: "color", severity: "block", message: "brand colour shifted" },
        ],
      }),
    ], { sizes: [], cycles: [] }),
  });
  equal("rollback: outcome", run.outcome, "rolled-back-then-escalated");
  equal("rollback: two cycles were recorded", run.history.length, 2);
  equal("rollback: regression decision", run.finalDecision?.kind, "rollback");
  equal("rollback: this cycle's two steps are undone", (run.finalDecision as any).stepsToUndo, 2);
  ok("rollback: artifact still exists", existsSync(resolve(ROOT, "output/c-rollback.jpg")));
}

async function scenarioMaxCycles(): Promise<void> {
  const run = await runApertureLoop(brief({ targetPath: "output/d-capped.jpg", maxCycles: 2 }), {
    audit: auditScript([
      critique({ findings: [{ axis: "exposure", severity: "warn", message: "muddy midtones" }] }),
      critique({ findings: [{ axis: "exposure", severity: "warn", message: "still muddy" }] }),
      critique({ findings: [{ axis: "exposure", severity: "warn", message: "never used" }] }),
    ], { sizes: [], cycles: [] }),
  });
  equal("cap: outcome", run.outcome, "escalated");
  equal("cap: exactly two cycles", run.history.length, 2);
  ok("cap: escalation names the policy", ((run.finalDecision as any)?.reason ?? "").includes("max cycles"));
}

async function scenarioConfidenceFloor(): Promise<void> {
  const run = await runApertureLoop(brief({ targetPath: "output/e-unsure.jpg" }), {
    audit: auditScript([critique({ verdict: "pass", confidence: 0.2 })], { sizes: [], cycles: [] }),
  });
  equal("floor: outcome", run.outcome, "escalated");
  equal("floor: one cycle", run.history.length, 1);
  ok("floor: escalation names confidence", ((run.finalDecision as any)?.reason ?? "").includes("below floor"));
}

async function scenarioPrefilterRejection(): Promise<void> {
  let calls = 0;
  const run = await runApertureLoop(brief({ targetPath: "output/f-prefilter.jpg" }), {
    audit: auditScript([critique({ verdict: "pass", confidence: 0.9 })], { sizes: [], cycles: [] }),
    prefilter: async (frame) => {
      calls++;
      if (calls === 1) {
        return { pass: false, topLabel: "clip", topScore: 1, shadowClip: 0, highlightClip: 0.4,
                 reason: "highlight clipping exceeds 22 % of the frame" };
      }
      return prefilter(frame);
    },
  });
  equal("prefilter: outcome", run.outcome, "accepted");
  equal("prefilter: two cycles", run.history.length, 2);
  equal("prefilter: rejection skipped the vision call", run.history[0].critique.reviewerNote, "pre-filter rejection");
  equal("prefilter: a synthetic block finding was compiled", run.history[0].appliedSteps, 1);
  equal("prefilter: the audit runs on the next cycle", run.history[1].appliedSteps, 0);
}

async function testSession(): Promise<void> {
  const session = new PhotoCraftSession(ROOT, ROOT);
  await session.boot();
  try {
    const opened = await session.docOpen(SOURCE);
    equal("session: source opens at its own size", opened.width, 1200);
    equal("session: source reports its height", opened.height, 800);
    equal("session: source opens one layer", opened.layers, 1);

    const preview = await session.preview(512);
    ok("session: preview returns a PNG", isPng(preview.base64));
    equal("session: preview MIME", preview.mime, "image/png");
    const frame = decodePngToRgba(preview.base64);
    equal("session: preview honours max_side", Math.max(frame.width, frame.height), 512);

    const state = await session.inspect();
    ok("session: inspect reports history", Array.isArray(state.history) && state.history.length > 0);

    const dropped = await session.runCorrectionBatch([
      { id: "doc_save", params: { path: "output/leak.jpg" } },
    ]);
    equal("session: non-allowlisted command is dropped", dropped.dropped, 1);
    equal("session: dropped batch runs nothing", dropped.completed, 0);

    const before = (await session.inspect()).layers.length;
    const failed = await session.runCorrectionBatch([
      { id: "layer.newAdjustmentLayer.hueSaturation", params: { saturation: -30 } },
      { id: "layer.newAdjustmentLayer.curves", params: { points: [[0, 0]] } },
    ]);
    equal("session: failed step is reported", failed.failed, 1);
    equal("session: partial success is not left applied", failed.completed, 0);
    equal("session: applied prefix is undone", failed.undone, 1);
    ok("session: failure carries the engine message", (failed.errors[0] ?? "").includes("points"));
    const after = (await session.inspect()).layers.length;
    equal("session: layer count is restored", after, before);

    const saved = await session.save("output/g-session.jpg");
    equal("session: save echoes the path", saved.path, "output/g-session.jpg");
    equal("session: JPEG save warns about lossy compression", saved.warnings[0], "lossy compression");

    const lossless = await session.save("output/g-session.pcraft");
    equal("session: native save is lossless", lossless.warnings.length, 0);
  } finally {
    await session.shutdown();
  }
}

// ─────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  rmSync(OUT, { recursive: true, force: true });
  rmSync(INPUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });

  process.env.PC_READ_ROOT = ROOT;
  process.env.PC_WRITE_ROOT = ROOT;

  await makeFixture();

  testPixels();
  await testPrefilter();
  testBaseEdit();
  testCompiler();
  testConvergence();
  await testAudit();

  await testSession();
  await scenarioAccept();
  await scenarioReviseThenPass();
  await scenarioRollback();
  await scenarioMaxCycles();
  await scenarioConfidenceFloor();
  await scenarioPrefilterRejection();

  console.log(`\n${assertions} assertions passed`);
}

main().catch((err) => {
  console.error("[fatal]", err);
  process.exitCode = 1;
});
