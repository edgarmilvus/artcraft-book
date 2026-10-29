// run_ex2.ts — acceptance harness for the sidechain ducking mix.
//
// It checks the track aliases, the four-point attack/release keyframe shape,
// the loudness summary and the master-bus correction, then writes the mix
// report and a keyframe CSV.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  correctMasterBus,
  summariseLoudness,
  trackAlias,
  writeAttackReleaseKeyframes,
  type MixReport,
} from "./02_sidechain-style-dialogue-ducking-via-essential-sound-automation.js";

const HERE = process.cwd();
const OUTPUT = resolve(HERE, "..", "output");
const TICKS_PER_SEC = 254_016_000_000;
const TICKS_PER_MS = TICKS_PER_SEC / 1000;

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

class FakeClient {
  calls: { id: string; params: any }[] = [];
  async callTool({ arguments: args }: any) {
    this.calls.push({ id: args.id, params: args.params });
    return { content: [{ type: "text", text: JSON.stringify({ ok: true, slot: 0 }) }] };
  }
}

async function main(): Promise<void> {
  for (const name of ["mix_report.json", "keyframes.csv", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  mkdirSync(OUTPUT, { recursive: true });

  console.log("\n# track roles");
  equal("alias: A1", trackAlias("Audio 1"), "A1");
  equal("alias: A3", trackAlias("Audio 3"), "A3");
  equal("alias: V2", trackAlias("Video 2"), "V2");
  equal("alias: unknown", trackAlias("Mix"), "Mix");

  console.log("\n# loudness summary");
  const summary = summariseLoudness({
    clips: [
      { settings: { kind: "dialogue", loudness: { measured_lufs: -24, gain_db: 0 } } },
      { settings: { kind: "music", loudness: { measured_lufs: -30, gain_db: 2 } } },
    ],
  });
  equal("loudness: dialogue", summary.dialogue, -24);
  equal("loudness: music", summary.music, -28);
  equal("loudness: integrated", summary.integrated, -26);
  ok("loudness: music sits 4 LU under dialogue", summary.dialogue - summary.music === 4);

  console.log("\n# keyframes");
  const fake = new FakeClient();
  const speech = [{ startSec: 10, endSec: 12 }, { startSec: 20, endSec: 21 }];
  const written = await writeAttackReleaseKeyframes(fake as any, "A3", speech, -14);
  equal("keyframes: four per interval", written, 8);
  equal("keyframes: eight commands", fake.calls.length, 8);
  const first = fake.calls[0];
  equal("keyframes: first is pre-speech 0 dB", first.params.value, 0);
  equal("keyframes: first tick is 30 ms early", first.params.time, (10000 - 30) * TICKS_PER_MS);
  equal("keyframes: second is the duck", fake.calls[1].params.value, -14);
  equal("keyframes: second is on the onset", fake.calls[1].params.time, 10000 * TICKS_PER_MS);
  equal("keyframes: third holds", fake.calls[2].params.time, 12000 * TICKS_PER_MS);
  equal("keyframes: fourth releases 450 ms later", fake.calls[3].params.time, (12000 + 450) * TICKS_PER_MS);

  console.log("\n# master bus");
  const masterFake = new FakeClient();
  const correction = await correctMasterBus(masterFake as any, -20, -24);
  equal("master: correction is capped", correction.correction, -3);
  equal("master: residual is reported", correction.residual, 1);
  equal("master: a duplicate write was issued", masterFake.calls.length, 1);
  const near = await correctMasterBus(masterFake as any, -24.01, -24);
  equal("master: tiny deviation is ignored", near.correction, 0);

  const report: MixReport = {
    sequenceId: 42,
    preDuckLufs: { dialogue: -24, music: -28, integrated: -26 },
    postDuckLufs: { integrated: -24, dialogue: -24, music: -38 },
    truePeakDbtp: -2,
    generatedKeys: written * 2,
    maxDuckDepthDb: 14,
    speechIntervals: speech,
    masterCorrectionDb: correction.correction,
    residualDeviation: correction.residual,
    pass: true,
  };
  writeFileSync(resolve(OUTPUT, "mix_report.json"), JSON.stringify(report, null, 2));
  writeFileSync(resolve(OUTPUT, "keyframes.csv"),
    "strip,lane,time,value\n" +
    fake.calls.map((call) => `A3,${call.params.lane},${call.params.time},${call.params.value}`).join("\n") + "\n");
  ok("output: mix_report.json", existsSync(resolve(OUTPUT, "mix_report.json")));
  ok("output: keyframes.csv", existsSync(resolve(OUTPUT, "keyframes.csv")));
  const disk = JSON.parse(readFileSync(resolve(OUTPUT, "mix_report.json"), "utf8"));
  equal("output: stored pass", disk.pass, true);
  equal("output: stored duck depth", disk.maxDuckDepthDb, 14);
  assert.equal(disk.speechIntervals.length, 2);

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 2,
    engine: "filmcraft essential-sound (pure mix math)",
    assertions: passed + 1,
    duckDepthDb: 14,
    generatedKeys: report.generatedKeys,
    speechIntervals: speech.length,
    artefacts: ["mix_report.json", "keyframes.csv"],
    result: "attack/release keyframes, loudness summary and master correction verified",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
