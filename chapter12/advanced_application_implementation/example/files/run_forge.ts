// run_forge.ts — deterministic harness for the agentic assembly pipeline.
//
// The pipeline is driven against the real headless FilmCraft: a dialogue
// take, a music bed and two B-roll stills are imported, the transcript is
// supplied (no speech model in the loop), the timeline is cut and rippled,
// and the export is checked.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  AutonomousAssembler,
  type AuditContext,
  type CutVerdict,
  type VisionAuditor,
} from "./01_agentic-assembly.js";

const OUTPUT = resolve(process.cwd(), "output");
const MEDIA = resolve(OUTPUT, "media");
const READ_ROOT = resolve(OUTPUT, "read");
const WRITE_ROOT = resolve(OUTPUT, "write");

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

/** A vision auditor that approves every frame. */
class ApprovingAuditor implements VisionAuditor {
  readonly frames: string[] = [];

  async audit(pngBase64: string, context: AuditContext): Promise<CutVerdict> {
    this.frames.push(pngBase64);
    return {
      ok: true,
      reasons: [],
      confidence: 0.95,
    };
  }
}

function makeFrame(seed: number, size = 320): Buffer {
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      png.data[i] = 30 + Math.floor(150 * Math.sin((x + seed * 40) / 55) * Math.cos(y / 70));
      png.data[i + 1] = 50 + Math.floor(110 * Math.cos((y + seed * 15) / 50));
      png.data[i + 2] = 90 + Math.floor(100 * Math.sin((x + y + seed * 8) / 85));
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

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
    const value = Math.sin((2 * Math.PI * 220 * i) / rate) * 0.35;
    buffer.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return buffer;
}

/**
 * A transcript the planner can work with: three spoken beats separated by
 * pauses long enough for the ripple trim to excise. It spans the five
 * seconds of the dialogue still, so the planned silence windows fall inside
 * the media.
 */
const transcript = {
  words: [
    { text: "Hello", start: 0.0, end: 0.5, speaker: 0 },
    { text: "and", start: 0.5, end: 0.9, speaker: 0 },
    { text: "welcome", start: 0.9, end: 1.6, speaker: 0 },
    // A half-second pause — the planner cuts around it.
    { text: "Today", start: 2.1, end: 2.7, speaker: 0 },
    { text: "we", start: 2.7, end: 3.1, speaker: 0 },
    { text: "ship", start: 3.1, end: 3.6, speaker: 0 },
    // Another pause, then the closing beat.
    { text: "the", start: 4.1, end: 4.5, speaker: 0 },
    { text: "new", start: 4.5, end: 5.0, speaker: 0 },
  ],
};

async function main(): Promise<void> {
  rmSync(OUTPUT, { recursive: true, force: true });
  for (const dir of [MEDIA, READ_ROOT, WRITE_ROOT]) mkdirSync(dir, { recursive: true });

  const dialogue = resolve(READ_ROOT, "dialogue.png");
  const music = resolve(READ_ROOT, "music.wav");
  const brollA = resolve(READ_ROOT, "broll-city.png");
  const brollB = resolve(READ_ROOT, "broll-desk.png");
  writeFileSync(dialogue, makeFrame(0));
  writeFileSync(music, makeTone(8));
  writeFileSync(brollA, makeFrame(1));
  writeFileSync(brollB, makeFrame(2));

  const auditor = new ApprovingAuditor();
  const assembler = new AutonomousAssembler(auditor, async () => transcript);

  console.log("\n# the job");
  const manifest = {
    tenant: "acme",
    jobId: "job-0001",
    readRoot: READ_ROOT,
    writeRoot: WRITE_ROOT,
    dialoguePath: dialogue,
    musicPath: music,
    broll: [
      { path: brollA, tags: ["ship", "launch", "skyline"], label: "City" },
      { path: brollB, tags: ["editor", "desk", "typing"], label: "Desk" },
    ],
    brief: "A product launch: we ship the new editor today.",
    width: 640,
    height: 360,
    fps: 24,
    targetRuntimeSec: 5,
    brollDensity: 0.9,
    minShotSec: 1.5,
    maxShotSec: 4,
    autoGrade: false,
    auditPerMinute: 2,
    maxRetries: 1,
  };

  const result = await assembler.run(manifest, { binaryPath: "filmcraft-cli" });

  console.log("\n# the result");
  ok("result: it produced a file", typeof result.outputPath === "string" && result.outputPath.length > 0, result.outputPath);
  ok("result: the file exists", existsSync(result.outputPath!), result.outputPath);
  ok("result: the runtime is positive", result.runtimeSec > 0, `${result.runtimeSec}`);
  ok("result: the coverage is a fraction", result.coverage >= 0 && result.coverage <= 1, `${result.coverage}`);
  ok("result: the b-roll was placed", result.shotsPlaced > 0, `${result.shotsPlaced}`);
  ok("result: the b-roll covers the edit", result.coverage > 0, `${result.coverage}`);
  ok("result: frames were audited", result.auditedFrames > 0, `${result.auditedFrames}`);
  equal("result: nothing rolled back", result.rollbacks, 0);

  console.log("\n# the audit");
  ok("audit: the auditor saw frames", auditor.frames.length > 0, `${auditor.frames.length}`);
  ok("audit: the frames are PNGs", auditor.frames.every((frame) => frame.length > 100));

  assert.ok(result.outputPath!.length > 0);

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
