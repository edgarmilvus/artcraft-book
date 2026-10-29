// run_ex2.ts — deterministic harness for the Exercise 2 brand auditor.
//
// It builds a real .vectorcraft fixture with the engine's own commands, runs
// the auditor with a scripted vision model, and asserts on document state:
// swatch ΔE, effect stacks, object bounds, dry-run rasters, escalation reasons
// and the report envelope.

import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  AuditConfig,
  BrandAudit,
  BrandReport,
  VectorSession,
  buildDigest,
  cmykToRgb,
  decodePng,
  deltaE2000,
  hexFromCmyk,
  intersects,
  runBrandAudit,
  solveCmykToTarget,
  ssdBetween,
  VisionFn,
} from "./02_brand-compliance-vision-auditor-for-vectorcraft-packaging-die-lines.js";

const ROOT = process.cwd();
const OUTPUT = resolve(ROOT, "..", "output");

let passed = 0;
function ok(label: string, condition: boolean, detail = ""): void {
  if (!condition) {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  passed++;
  console.log(`PASS ${label}`);
}

function equal<T>(label: string, actual: T, expected: T): void {
  ok(label, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

function approx(label: string, actual: number, expected: number, eps = 1e-6): void {
  ok(label, Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);
}

function near(label: string, actual: number, expected: number, eps: number): void {
  ok(label, Math.abs(actual - expected) <= eps, `expected ${expected} ± ${eps}, got ${actual}`);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const CREMA_TARGET = "#dcb78a";

function freshFile(name: string): string {
  const path = `input/${name}`;
  const full = resolve(ROOT, path);
  if (existsSync(full)) rmSync(full);
  return path;
}

interface Fixture {
  config: AuditConfig;
  wordmarkId: number;
  squareId: number;
  cremaBefore: string;
}

async function buildFixture(file: string): Promise<Fixture> {
  const session = new VectorSession({ read: ROOT, write: ROOT });
  await session.connect();
  try {
    await session.run("file.new", { width: 600, height: 600, units: "Points" });
    await session.run("file.documentColorMode", { mode: "cmyk", convert: true });

    // Four approved spot inks. Roast, Leaf and Ink are on target; Crema is
    // 4+ ΔE off, which is the drift the auditor must close.
    await session.run("swatch.new", { name: "Roast", color: { c: 45, m: 65, y: 75, k: 55 }, mode: "cmyk", spot: true });
    await session.run("swatch.new", { name: "Crema", color: { c: 8, m: 18, y: 38, k: 4 }, mode: "cmyk", spot: true });
    await session.run("swatch.new", { name: "Leaf", color: { c: 60, m: 25, y: 70, k: 35 }, mode: "cmyk", spot: true });
    await session.run("swatch.new", { name: "Ink", color: { c: 0, m: 0, y: 0, k: 90 }, mode: "cmyk", spot: true });

    await session.run("text.create", { x: 140, y: 260, text: "NORTH ROAST", size: 64, font: "Helvetica" });
    await session.run("paint.setFill", { swatch: "Roast" });

    // A white card with a drop shadow, parked inside the wordmark's clear
    // space and inside the die-line.
    await session.run("path.create", {
      anchors: [
        { x: 330, y: 250 },
        { x: 390, y: 250 },
        { x: 390, y: 310 },
        { x: 330, y: 310 },
      ],
      closed: true,
    });
    await session.run("paint.setFill", { color: "#ffffff" });
    await session.run("effect.apply", { effect: "stylize.dropShadow" });
    await session.run("file.saveAs", { path: file });

    const swatches = await session.swatches();
    const hexOf = (name: string): string => {
      const found = swatches.find((s) => s.name === name);
      assert(found, `swatch ${name} missing`);
      return found.hex;
    };

    const inspect = await session.inspect(2);
    const objects = inspect.layers.flatMap((layer) => layer.children ?? []);
    const wordmark = objects.find((o) => o.kind === "Type");
    const square = objects.find((o) => o.kind === "Path");
    assert(wordmark && square, "fixture objects missing");

    return {
      config: {
        approved: [
          { name: "Roast", targetHex: hexOf("Roast") },
          { name: "Crema", targetHex: CREMA_TARGET },
          { name: "Leaf", targetHex: hexOf("Leaf") },
          { name: "Ink", targetHex: hexOf("Ink") },
        ],
        wordmarkName: "NORTH ROAST",
        dieLineInsetPt: 24,
        deltaETolerance: 2.5,
        maxRounds: 4,
        readRoot: ROOT,
        writeRoot: ROOT,
      },
      wordmarkId: wordmark.id,
      squareId: square.id,
      cremaBefore: hexOf("Crema"),
    };
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Scripted vision models
// ---------------------------------------------------------------------------

function mainVision(): VisionFn {
  return async ({ previewPngB64, digest }) => {
    const png = decodePng(previewPngB64);
    equal("vision: preview is rendered at the requested side", png.width, 1024);
    const wordmark = digest.objects.find((o) => o.kind === "Text");
    const square = digest.objects.find((o) => o.kind === "Path");
    assert(wordmark && square, "digest objects missing");
    const crema = digest.approvedSwatches.find((s) => s.name === "Crema");
    assert(crema, "Crema missing from digest");

    const audit: BrandAudit = {
      findings: [
        { rule: "clear-space", violated: true, severity: "blocking", note: "The card crowds the wordmark on the right." },
        { rule: "die-line", violated: true, severity: "blocking", note: "An unapproved white element sits inside the die-line." },
        { rule: "spot-accuracy", violated: true, severity: "warning", note: "Crema drifts from the guide target." },
      ],
      fixes: [
        { kind: "swap_swatch", targetId: wordmark.id, fromHex: crema.hex, toHex: CREMA_TARGET },
        { kind: "reposition", targetId: square.id, dxPt: 0, dyPt: 120 },
        { kind: "remove_effect", targetId: square.id, effectIndex: 0 },
        { kind: "recolor_gradient_to_flat", targetId: square.id, flatHex: CREMA_TARGET },
      ],
      confidence: 0.91,
    };
    return audit;
  };
}

function escalationVision(): VisionFn {
  return async ({ digest }) => {
    const wordmark = digest.objects.find((o) => o.kind === "Text");
    const square = digest.objects.find((o) => o.kind === "Path");
    assert(wordmark && square, "digest objects missing");
    const crema = digest.approvedSwatches.find((s) => s.name === "Crema");
    assert(crema, "Crema missing from digest");
    return {
      findings: [{ rule: "clear-space", violated: true, severity: "blocking", note: "Move the wordmark." }],
      fixes: [
        { kind: "reposition", targetId: wordmark.id, dxPt: 10, dyPt: 0 },
        { kind: "swap_swatch", targetId: square.id, fromHex: crema.hex, toHex: "#0000ff" },
      ],
      confidence: 0.8,
    };
  };
}

function budgetVision(): VisionFn {
  return async ({ digest }) => {
    const wordmark = digest.objects.find((o) => o.kind === "Text");
    const square = digest.objects.find((o) => o.kind === "Path");
    assert(wordmark && square, "digest objects missing");
    return {
      findings: [{ rule: "clear-space", violated: true, severity: "warning", note: "Four small corrections." }],
      fixes: [
        { kind: "reposition", targetId: square.id, dxPt: 0, dyPt: 120 },
        { kind: "remove_effect", targetId: square.id, effectIndex: 0 },
        { kind: "typography", targetId: wordmark.id, tracking: 20 },
        { kind: "resize", targetId: square.id, scalePct: 80 },
      ],
      confidence: 0.75,
    };
  };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioMain(): Promise<void> {
  console.log("\n# main audit");
  const fixture = await buildFixture(freshFile("brand.vectorcraft"));

  // The probe opens the saved file and checks the digest before any fix.
  const probe = new VectorSession({ read: ROOT, write: ROOT });
  await probe.connect();
  await probe.open("input/brand.vectorcraft");
  const digest = await buildDigest(probe, fixture.config);
  const preview = await probe.preview(1024);
  await probe.close();

  equal("digest: artboard width", digest.artboard.widthPt, 600);
  equal("digest: two objects", digest.objects.length, 2);
  equal("digest: four approved swatches", digest.approvedSwatches.length, 4);
  const wordmark = digest.objects.find((o) => o.name === "NORTH ROAST");
  const square = digest.objects.find((o) => o.id === fixture.squareId);
  assert(wordmark && square, "digest objects missing");
  equal("digest: wordmark kind", wordmark.kind, "Text");
  equal("digest: wordmark font", wordmark.fontFamily, "Helvetica");
  equal("digest: wordmark size", wordmark.fontSizePt, 64);
  equal("digest: wordmark is spot Roast", wordmark.fillHex, digest.approvedSwatches.find((s) => s.name === "Roast")!.hex);
  equal("digest: square carries one effect", square.effectIds?.length, 1);
  equal("digest: square effect id", square.effectIds?.[0], "stylize.dropShadow");
  ok("digest: Crema is out of tolerance",
    digest.approvedSwatches.find((s) => s.name === "Crema")!.deltaEToTarget > 2.5,
    `ΔE ${digest.approvedSwatches.find((s) => s.name === "Crema")!.deltaEToTarget}`);
  ok("digest: clear space is violated", digest.clearSpaceViolations.includes(fixture.squareId));
  ok("digest: die-line is intruded", digest.dieLineIntrusions.includes(fixture.squareId));
  equal("digest: preview decodes", decodePng(preview).width, 1024);

  const report: BrandReport = await runBrandAudit("input/brand.vectorcraft", fixture.config, {
    vision: mainVision(),
    jobId: "ex2-main",
    now: () => new Date("2026-01-01T00:00:00Z"),
  });

  equal("report: job id", report.jobId, "ex2-main");
  equal("report: timestamp", report.generatedAt, "2026-01-01T00:00:00.000Z");
  equal("report: audit fixes", report.audit.fixes.length, 4);
  equal("report: applied fixes", report.applied.length, 4);
  equal("report: nothing escalated", report.escalated.length, 0);
  equal("report: four rounds", report.rounds, 4);
  equal("report: fix order", report.applied.map((a) => a.fix.kind).join(","),
    "swap_swatch,reposition,remove_effect,recolor_gradient_to_flat");

  const reposition = report.applied[1];
  const dryRun = reposition.dryRun;
  assert(dryRun, "reposition must carry a dry run");
  equal("dry run: command id", dryRun.command.id, "object.move");
  ok("dry run: raster changed", dryRun.ssd > 0, `SSD ${dryRun.ssd}`);
  ok("dry run: improvement below 1", dryRun.improvement < 1);
  ok("dry run: below the guard", dryRun.ssd <= 0.25);
  equal("dry run: before decodes", decodePng(dryRun.rasterBefore).width, 1024);
  equal("dry run: after decodes", decodePng(dryRun.rasterAfter).width, 1024);
  equal("report: applied batch keeps select and move", reposition.steps.length, 2);

  const swap = report.applied[0];
  ok("swatch: notes record the target", swap.notes.join(" ").includes(CREMA_TARGET), swap.notes.join(" "));

  const final = report.finalDigest;
  const cremaAfter = final.approvedSwatches.find((s) => s.name === "Crema")!;
  ok("final: Crema closed to tolerance", cremaAfter.deltaEToTarget <= 2.5, `ΔE ${cremaAfter.deltaEToTarget}`);
  ok("final: Crema moved", cremaAfter.hex.toLowerCase() !== fixture.cremaBefore.toLowerCase(),
    `${fixture.cremaBefore} → ${cremaAfter.hex}`);
  const squareAfter = final.objects.find((o) => o.id === fixture.squareId)!;
  equal("final: effect stack is empty", squareAfter.effectIds?.length, 0);
  near("final: square moved down 120 pt", squareAfter.bounds[1], square.bounds[1] + 120, 0.01);
  ok("final: clear space is clear", !final.clearSpaceViolations.includes(fixture.squareId),
    JSON.stringify(final.clearSpaceViolations));
  ok("final: die-line is respected", !final.dieLineIntrusions.includes(fixture.squareId),
    JSON.stringify(final.dieLineIntrusions));
  equal("final: preview decodes", decodePng(report.finalPreviewPng).width, 1024);
  equal("final: wordmark unchanged", final.objects.find((o) => o.id === fixture.wordmarkId)!.bounds.join(","),
    wordmark.bounds.join(","));

  const serialised = JSON.stringify(report);
  ok("report: serialises", serialised.length > 1000);
  writeFileSync(resolve(OUTPUT, "report-main.json"), JSON.stringify(report, null, 2));
  writeFileSync(resolve(OUTPUT, "final-main.png"), Buffer.from(report.finalPreviewPng, "base64"));
  ok("report: written to output", existsSync(resolve(OUTPUT, "report-main.json")));
}

async function scenarioEscalation(): Promise<void> {
  console.log("\n# escalation");
  const fixture = await buildFixture(freshFile("brand-escalate.vectorcraft"));
  const config: AuditConfig = { ...fixture.config, maxRounds: 4 };

  const report = await runBrandAudit("input/brand-escalate.vectorcraft", config, {
    vision: escalationVision(),
    jobId: "ex2-escalate",
  });

  equal("escalation: nothing applied", report.applied.length, 0);
  equal("escalation: two escalations", report.escalated.length, 2);
  equal("escalation: no rounds", report.rounds, 0);
  ok("escalation: wordmark limit named", report.escalated[0].reason.includes("4 pt limit"), report.escalated[0].reason);
  ok("escalation: ink limit named", report.escalated[1].reason.includes("points of ink"), report.escalated[1].reason);

  const before = report.digest.objects.find((o) => o.id === fixture.wordmarkId)!;
  const after = report.finalDigest.objects.find((o) => o.id === fixture.wordmarkId)!;
  equal("escalation: wordmark did not move", after.bounds.join(","), before.bounds.join(","));

  const cremaBefore = report.digest.approvedSwatches.find((s) => s.name === "Crema")!;
  const cremaAfter = report.finalDigest.approvedSwatches.find((s) => s.name === "Crema")!;
  equal("escalation: swatch rolled back", cremaAfter.hex.toLowerCase(), cremaBefore.hex.toLowerCase());

  writeFileSync(resolve(OUTPUT, "report-escalation.json"), JSON.stringify(report, null, 2));
  writeFileSync(resolve(OUTPUT, "final-escalation.png"), Buffer.from(report.finalPreviewPng, "base64"));
  ok("escalation: report written", existsSync(resolve(OUTPUT, "report-escalation.json")));
}

async function scenarioBudget(): Promise<void> {
  console.log("\n# budget");
  const fixture = await buildFixture(freshFile("brand-budget.vectorcraft"));
  const config: AuditConfig = { ...fixture.config, maxRounds: 2 };

  const report = await runBrandAudit("input/brand-budget.vectorcraft", config, {
    vision: budgetVision(),
    jobId: "ex2-budget",
  });

  equal("budget: two applied", report.applied.length, 2);
  equal("budget: two escalated", report.escalated.length, 2);
  equal("budget: rounds capped", report.rounds, 2);
  ok("budget: reason names the budget",
    report.escalated.every((e) => e.reason.includes("iteration budget of 2 rounds")),
    report.escalated.map((e) => e.reason).join(" | "));
  equal("budget: first fix applied", report.applied[0].fix.kind, "reposition");
  equal("budget: second fix applied", report.applied[1].fix.kind, "remove_effect");

  writeFileSync(resolve(OUTPUT, "report-budget.json"), JSON.stringify(report, null, 2));
  writeFileSync(resolve(OUTPUT, "final-budget.png"), Buffer.from(report.finalPreviewPng, "base64"));
  ok("budget: report written", existsSync(resolve(OUTPUT, "report-budget.json")));
}

// ---------------------------------------------------------------------------
// Unit checks
// ---------------------------------------------------------------------------

function unitColour(): void {
  console.log("\n# colour math");
  approx("ΔE: identical colours", deltaE2000("#53352b", "#53352b"), 0, 1e-9);
  near("ΔE: black to white", deltaE2000("#000000", "#ffffff"), 100, 0.05);
  near("ΔE: red to green", deltaE2000("#ff0000", "#00ff00"), 86.61, 0.05);

  const from: [number, number, number, number] = [45, 65, 75, 55];
  const targetCmyk: [number, number, number, number] = [43, 62, 72, 52];
  const targetHex = hexFromCmyk(targetCmyk);
  const solved = solveCmykToTarget(from, targetHex);
  ok("solver: closes on the naive profile", solved.deltaE <= 2.5, `ΔE ${solved.deltaE}`);
  ok("solver: stays inside ink bounds", solved.cmyk.every((v) => v >= 0 && v <= 100));
  ok("solver: improves on the start", solved.deltaE < deltaE2000(hexFromCmyk(from), targetHex));

  const rgb = cmykToRgb([0, 0, 0, 100]);
  equal("cmyk: full black", rgb.join(","), "0,0,0");

  const a: [number, number, number, number] = [0, 0, 10, 10];
  const b: [number, number, number, number] = [5, 5, 15, 15];
  ok("bounds: overlap", intersects(a, b));
  ok("bounds: separate", !intersects(a, [20, 20, 30, 30]));
}

function unitRaster(): void {
  console.log("\n# raster");
  const png = new PNG({ width: 2, height: 1 });
  png.data.fill(255);
  equal("raster: decodes", `${png.width}x${png.height}`, "2x1");
  equal("raster: identical frames have zero SSD", ssdBetween(png, png), 0);
}

async function main(): Promise<void> {
  mkdirSync(OUTPUT, { recursive: true });
  mkdirSync(resolve(ROOT, "input"), { recursive: true });
  unitColour();
  unitRaster();
  await scenarioMain();
  await scenarioEscalation();
  await scenarioBudget();

  const artefacts = [
    "final-main.png",
    "report-main.json",
    "final-escalation.png",
    "report-escalation.json",
    "final-budget.png",
    "report-budget.json",
  ];
  for (const artefact of artefacts) {
    ok(`output: ${artefact}`, existsSync(resolve(OUTPUT, artefact)));
  }
  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 2,
    engine: "vectorcraft-cli",
    jobIds: ["ex2-main", "ex2-escalate", "ex2-budget"],
    assertions: passed,
    artefacts,
    result: "brand compliance audit converged; escalation and budget paths verified",
  }, null, 2));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
