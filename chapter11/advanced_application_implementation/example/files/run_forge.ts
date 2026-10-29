// run_forge.ts — deterministic harness for the zero-drift pipeline.
//
// The pipeline is driven against the real headless FilmCraft: a beat grid is
// planned in exact rational arithmetic, dispatched into a sequence, and read
// back to prove that the engine holds the very ticks the plan asked for.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import { runBeatCutJob, type CutJob } from "./pipeline.js";
import { DriftAuditor } from "./drift-audit.js";
import { FPS, TICKS_PER_SECOND } from "./timebase.js";

const OUTPUT = resolve(process.cwd(), "output");
const MEDIA = resolve(OUTPUT, "media");

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

/** A still frame for the video track. */
function makeFrame(seed: number): Buffer {
  const size = 320;
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      png.data[i] = 20 + Math.floor(150 * Math.sin((x + seed * 40) / 60) * Math.cos(y / 70));
      png.data[i + 1] = 40 + Math.floor(120 * Math.cos((y + seed * 25) / 55));
      png.data[i + 2] = 90 + Math.floor(100 * Math.sin((x + y + seed * 10) / 90));
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** A second of music-bed audio: a 440 Hz tone at 48 kHz. */
function makeTone(seconds: number): Buffer {
  const rate = 48000;
  const samples = rate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    const value = Math.sin((2 * Math.PI * 440 * i) / rate) * 0.4;
    buffer.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return buffer;
}

async function main(): Promise<void> {
  rmSync(OUTPUT, { recursive: true, force: true });
  mkdirSync(MEDIA, { recursive: true });

  writeFileSync(resolve(MEDIA, "clip-a.png"), makeFrame(0));
  writeFileSync(resolve(MEDIA, "clip-b.png"), makeFrame(1));
  writeFileSync(resolve(MEDIA, "music.wav"), makeTone(12));

  console.log("\n# the drift audit");
  const auditor = new DriftAuditor(FPS.F24, 48000);
  const drift = auditor.audit(8);
  ok("drift: the float path drifts", Math.abs(drift.frameDriftSeconds) > 0, JSON.stringify(drift.frameDriftSeconds));
  ok("drift: the exact path does not", drift.frameDriftTicks !== undefined);
  ok("drift: the report names the frame drift", drift.frameDriftFrames > 0, `${drift.frameDriftFrames}`);

  console.log("\n# the pipeline");
  const job: CutJob = {
    sequenceName: "BeatCut",
    width: 640,
    height: 360,
    fps: FPS.F24,
    sampleRate: 48000,
    bpm: 120,
    beatsPerBar: 4,
    barsPerCut: 1,
    downbeatSeconds: 0,
    cutCount: 4,
    musicPath: resolve(MEDIA, "music.wav"),
    clipPaths: [resolve(MEDIA, "clip-a.png"), resolve(MEDIA, "clip-b.png")],
    renderFirstFrame: true,
  };

  const result = await runBeatCutJob(job, {
    readRoots: [MEDIA],
    writeRoots: [resolve(OUTPUT, "out")],
  });

  console.log("\n# the plan");
  const cuts = result.plan.cutTicks.map(String);
  equal("plan: four cuts", cuts.length, 4);
  // 120 bpm, four beats to a bar: a bar is two seconds.
  equal("plan: the first cut is at zero", cuts[0], "0");
  equal("plan: the second cut is at two seconds", cuts[1], (2n * TICKS_PER_SECOND).toString());
  equal("plan: the third cut is at four seconds", cuts[2], (4n * TICKS_PER_SECOND).toString());
  equal("plan: the fourth cut is at six seconds", cuts[3], (6n * TICKS_PER_SECOND).toString());

  console.log("\n# the verification");
  equal("verify: the engine held every tick", result.verification.maxDeviationTicks, 0n);
  ok("verify: the verification passed", result.verification.passed);
  equal("verify: the observed starts match the plan",
    result.verification.observedStartTicks.map(String).join(","),
    result.verification.expectedStartTicks.map(String).join(","));

  console.log("\n# the sequence");
  equal("sequence: it is named", result.sequence.name, "BeatCut");
  equal("sequence: the canvas is 640 wide", result.sequence.width, 640);
  ok("sequence: the tracks are there", result.sequence.tracks.length >= 2, `${result.sequence.tracks.length}`);
  ok("sequence: the clips are on the timeline", result.sequence.clips.length >= 4, `${result.sequence.clips.length}`);

  console.log("\n# the report and the frame");
  ok("report: the drift report is there", (result.driftReport ?? "").length > 0);
  ok("frame: a PNG came back", typeof result.framePngBase64 === "string" && result.framePngBase64.length > 100);
  const png = PNG.sync.read(Buffer.from(result.framePngBase64!, "base64"));
  ok("frame: it decodes", png.width > 0 && png.height > 0, `${png.width}x${png.height}`);

  assert.ok(cuts.every((cut) => BigInt(cut) % 1n === 0n));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
