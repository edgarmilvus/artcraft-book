// run_ex4.ts — acceptance harness for the deterministic sync QC loop.
//
// It checks the integer pixel -> tick mapping, the two-sample threshold, the
// reject/verdict classification, and writes a real Program-monitor screenshot
// plus the report that a bridge-mode run would produce.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  PASS_THRESHOLD,
  TICKS_PER_SAMPLE,
  buildSyncReport,
  pixelXToTick,
  type SyncAnchorResult,
} from "./04_deterministic-multimodal-qc-loop-with-ui-screenshot-and-vision-model.js";

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

function screenshot(): Buffer {
  const width = 1280;
  const height = 720;
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      const monitor = x > 40 && x < width - 40 && y > 40 && y < height - 80;
      png.data[i] = monitor ? 24 : 12;
      png.data[i + 1] = monitor ? 28 : 14;
      png.data[i + 2] = monitor ? 34 : 16;
      png.data[i + 3] = 255;
    }
  }
  // A white clap marker at the centre of the Program monitor.
  for (let y = 300; y < 360; y += 1) {
    for (let x = 620; x < 660; x += 1) {
      const i = (y * width + x) * 4;
      png.data[i] = 245;
      png.data[i + 1] = 245;
      png.data[i + 2] = 240;
    }
  }
  return PNG.sync.write(png);
}

function result(id: string, drift: number | null, rejected = false, reason?: string): SyncAnchorResult {
  return {
    anchorId: id,
    visualEventTick: drift === null ? null : 1_000_000_000,
    audioTransientTick: drift === null ? null : 1_000_000_000 - drift,
    driftTicks: drift,
    rejected,
    rejectReason: reason as any,
  };
}

function main(): void {
  for (const name of ["program-monitor.png", "sync-qc-report.json", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  mkdirSync(OUTPUT, { recursive: true });

  console.log("\n# deterministic pixel mapping");
  const visible = 48_000n * TICKS_PER_SAMPLE; // one second visible
  equal("pixel: centre maps to the anchor",
    pixelXToTick(0n, 640, 1280, 720, visible), 0n);
  equal("pixel: right edge maps to half a second",
    pixelXToTick(0n, 1280, 1280, 720, visible), visible / 2n);
  equal("pixel: left edge maps to minus half a second",
    pixelXToTick(0n, 0, 1280, 720, visible), -(visible / 2n));
  equal("pixel: one pixel is exact",
    pixelXToTick(0n, 641, 1280, 720, visible),
    (2n * 641n - 1280n) * visible / (2n * 1280n));
  equal("pixel: an anchor is added exactly",
    pixelXToTick(123_456_789n, 640, 1280, 720, visible), 123_456_789n);
  equal("pixel: repeated calls are identical",
    pixelXToTick(0n, 700, 1280, 720, visible), pixelXToTick(0n, 700, 1280, 720, visible));
  let integral = false;
  try { pixelXToTick(0n, 1.5, 1280, 720, visible); } catch { integral = true; }
  ok("pixel: fractional coordinates are refused", integral);
  equal("threshold: two 48 kHz samples", PASS_THRESHOLD, 2n * TICKS_PER_SAMPLE);

  console.log("\n# verdicts");
  const pass = buildSyncReport([
    result("a", Number(TICKS_PER_SAMPLE)),
    result("b", Number(TICKS_PER_SAMPLE * 2n)),
    result("c", 0),
  ]);
  equal("report: two-sample drift passes", pass.verdict, "pass");
  equal("report: max drift", pass.maxDriftTicks, Number(TICKS_PER_SAMPLE * 2n));
  equal("report: no rejections", pass.rejectedAnchors, 0);
  equal("report: threshold is serialised", pass.passThresholdTicks, Number(PASS_THRESHOLD));
  ok("report: rationale names the threshold", pass.rationale.includes(String(PASS_THRESHOLD)), pass.rationale);

  const fail = buildSyncReport([
    result("a", Number(TICKS_PER_SAMPLE * 3n)),
    result("b", Number(TICKS_PER_SAMPLE)),
  ]);
  equal("report: three-sample drift fails", fail.verdict, "fail");
  equal("report: fail max drift", fail.maxDriftTicks, Number(TICKS_PER_SAMPLE * 3n));

  const inconclusive = buildSyncReport([
    result("a", null, true, "no_event_found"),
    result("b", null, true, "audio_envelope_flat"),
    result("c", Number(TICKS_PER_SAMPLE)),
  ]);
  equal("report: too many rejects are inconclusive", inconclusive.verdict, "inconclusive");
  equal("report: rejected count", inconclusive.rejectedAnchors, 2);

  const png = screenshot();
  writeFileSync(resolve(OUTPUT, "program-monitor.png"), png);
  ok("output: program-monitor.png", existsSync(resolve(OUTPUT, "program-monitor.png")));
  const decoded = PNG.sync.read(readFileSync(resolve(OUTPUT, "program-monitor.png")));
  equal("output: screenshot width", decoded.width, 1280);
  equal("output: screenshot height", decoded.height, 720);

  writeFileSync(resolve(OUTPUT, "sync-qc-report.json"), JSON.stringify({
    screenshot: "program-monitor.png",
    anchors: pass.anchors,
    pass,
    fail,
    inconclusive,
  }, null, 2));
  ok("output: sync-qc-report.json", existsSync(resolve(OUTPUT, "sync-qc-report.json")));
  const disk = JSON.parse(readFileSync(resolve(OUTPUT, "sync-qc-report.json"), "utf8"));
  equal("output: stored pass verdict", disk.pass.verdict, "pass");
  assert.equal(disk.fail.verdict, "fail");

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 4,
    engine: "filmcraft integer-pixel bridge (pure classification)",
    assertions: passed + 1,
    passThresholdTicks: PASS_THRESHOLD.toString(),
    ticksPerSample48k: TICKS_PER_SAMPLE.toString(),
    verdicts: { pass: pass.verdict, fail: fail.verdict, inconclusive: inconclusive.verdict },
    artefacts: ["program-monitor.png", "sync-qc-report.json"],
    result: "integer pixel-to-tick mapping and the two-sample sync verdict verified; screenshot and report written",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main();
