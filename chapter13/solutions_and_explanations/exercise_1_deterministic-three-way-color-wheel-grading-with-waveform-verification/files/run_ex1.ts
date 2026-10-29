// run_ex1.ts — acceptance harness for the deterministic three-way grade.
//
// It checks the LUT-first batch and the four scope invariants on
// synthetic readouts, then writes a verification frame and the delivery report.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  assertScopes,
  buildGradingBatch,
  extractScope,
  type DeliveryReport,
} from "./01_solutions_and_explanations.js";

const HERE = process.cwd();
const OUTPUT = resolve(HERE, "..", "output");

let passed = 0;
function ok(label: string, condition: boolean, detail = ""): void {
  if (!condition) {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`PASS ${label}`);
}

function equal<T>(label: string, actual: T, expected: T): void {
  ok(label, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

function scopeRow(overrides: { paradeMax?: number; waveMin?: number; waveMax?: number; midMean?: number; shadowLift?: number } = {}) {
  const bins = 16;
  const mean = (index: number, base: number) => index >= 14 ? overrides.paradeMax ?? base : base;
  const traces = {
    R: Array.from({ length: bins }, (_, i) => ({ mean: mean(i, 50) })),
    G: Array.from({ length: bins }, (_, i) => ({ mean: mean(i, 50) })),
    B: Array.from({ length: bins }, (_, i) => ({ mean: i < 4 ? 50 + (overrides.shadowLift ?? 10) : mean(i, 50) })),
  };
  const luma = Array.from({ length: bins }, (_, i) => ({
    min: overrides.waveMin ?? 0,
    max: overrides.waveMax ?? 100,
    mean: i >= 4 && i <= 12 ? overrides.midMean ?? 50 : 50,
  }));
  return { data: { parade: { traces }, waveform: { luma } } };
}

function frame(): Buffer {
  const png = new PNG({ width: 960, height: 540 });
  for (let y = 0; y < 540; y += 1) {
    for (let x = 0; x < 960; x += 1) {
      const i = (y * 960 + x) * 4;
      png.data[i] = Math.round(40 + (x / 960) * 120);
      png.data[i + 1] = Math.round(55 + (y / 540) * 90);
      png.data[i + 2] = Math.round(70 + ((x + y) / 1500) * 60);
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function main(): void {
  for (const name of ["scopes.json", "delivery_report.json", "verification.png", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  mkdirSync(OUTPUT, { recursive: true });

  console.log("\n# the batch");
  const sony = buildGradingBatch(7, "builtin:sony-slog3-to-rec709");
  const canon = buildGradingBatch(8, "builtin:canon-clog3-to-rec709");
  equal("batch: eight steps", sony.length, 8);
  equal("batch: LUT is first", (sony[0].params as any).param, "input_lut");
  equal("batch: Basic is enabled second", (sony[1].params as any).param, "basic_on");
  equal("batch: Sony LUT", (sony[0].params as any).value, "builtin:sony-slog3-to-rec709");
  equal("batch: Canon LUT", (canon[0].params as any).value, "builtin:canon-clog3-to-rec709");
  ok("batch: every step targets the clip", sony.every((step) => (step.params as any).clip === 7));
  const wheelParams = sony.map((step) => (step.params as any).param);
  equal("batch: shadow vector", wheelParams[2], "wheel_shadows");
  equal("batch: shadow luma", wheelParams[3], "wheel_shadows_l");
  equal("batch: midtone vector", wheelParams[4], "wheel_midtones");
  equal("batch: highlight luma", wheelParams[7], "wheel_highlights_l");

  console.log("\n# scope invariants");
  const row = scopeRow();
  const parsed = extractScope(row);
  equal("scope: 16 red bins", parsed.R.length, 16);
  equal("scope: 16 luma columns", parsed.wMean.length, 16);
  const passing = assertScopes(7, row);
  equal("scope: clean readout passes", passing.pass, true);
  equal("scope: parade max", passing.paradeMaxIre, 50);
  equal("scope: shadow blue lift", passing.shadowBlueLift, 10);
  equal("scope: midtone mean", passing.midtoneMeanY, 50);

  const parade = assertScopes(7, scopeRow({ paradeMax: 120 }));
  equal("scope: parade clipping fails", parade.failedInvariant, "parade");
  const waveform = assertScopes(7, scopeRow({ waveMax: 110 }));
  equal("scope: waveform clipping fails", waveform.failedInvariant, "waveform");
  const midtones = assertScopes(7, scopeRow({ midMean: 10 }));
  equal("scope: crushed midtones fail", midtones.failedInvariant, "midtones");
  const shadow = assertScopes(7, scopeRow({ shadowLift: 0 }));
  equal("scope: missing teal lift fails", shadow.failedInvariant, "shadowBlueLift");

  const report: DeliveryReport = {
    generatedAt: new Date().toISOString(),
    clips: [{ clipId: 7, batchSteps: sony.length, scope: passing, verificationPng: "verification.png" }],
    rollbacks: [],
    rollbackPlan: [{ clipId: 7, steps: sony.length }],
  };
  writeFileSync(resolve(OUTPUT, "scopes.json"), JSON.stringify({ passing, parade, waveform, midtones, shadow }, null, 2));
  writeFileSync(resolve(OUTPUT, "delivery_report.json"), JSON.stringify(report, null, 2));
  writeFileSync(resolve(OUTPUT, "verification.png"), frame());
  for (const artefact of ["scopes.json", "delivery_report.json", "verification.png"]) {
    ok(`output: ${artefact}`, existsSync(resolve(OUTPUT, artefact)));
  }
  const decoded = PNG.sync.read(readFileSync(resolve(OUTPUT, "verification.png")));
  equal("output: verification frame width", decoded.width, 960);
  equal("output: verification frame height", decoded.height, 540);

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 1,
    engine: "filmcraft timebase (pure scope invariants)",
    assertions: passed + 1,
    batchSteps: sony.length,
    scope: { paradeMaxIre: passing.paradeMaxIre, midtoneMeanY: passing.midtoneMeanY,
             shadowBlueLift: passing.shadowBlueLift, pass: passing.pass },
    artefacts: ["scopes.json", "delivery_report.json", "verification.png"],
    result: "LUT-first grade batch and all four scope invariants verified",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
  assert.equal(passing.pass, true);
}

main();
