// run_forge.ts — deterministic harness for the governance pipeline.
//
// The services are driven against the real headless FilmCraft: a dialogue
// take, a music bed and a shot are imported, the Lumetri parameters are
// discovered from the running build, the three-way grade is written, the
// sidechain ducking is authored and the loudness is governed.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import { FilmCraftSession, type FilmCraftSessionOptions } from "./src/mcp/session.js";
import { discoverLumetri } from "./src/mcp/discovery.js";
import { WheelGrader } from "./src/services/wheel-grader.js";
import { DuckingEngine } from "./src/services/ducking-engine.js";
import { LoudnessGovernor } from "./src/services/loudness-governor.js";

const OUTPUT = resolve(process.cwd(), "output");
const PROJECT = resolve(OUTPUT, "project");

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

/** A still frame for the shot. */
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

/** A tone: the dialogue (with a gap) and the music bed. */
function makeTone(seconds: number, frequency: number, gap = 0): Buffer {
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
    const silent = gap > 0 && i > rate * gap && i < rate * (gap + 0.8);
    const value = silent ? 0 : Math.sin((2 * Math.PI * frequency * i) / rate) * 0.3;
    buffer.writeInt16LE(Math.round(value * 32767), 44 + i * 2);
  }
  return buffer;
}

async function main(): Promise<void> {
  rmSync(OUTPUT, { recursive: true, force: true });
  const media = resolve(PROJECT, "media");
  mkdirSync(media, { recursive: true });

  const dialogue = resolve(media, "dialogue.wav");
  const music = resolve(media, "music.wav");
  const shot = resolve(media, "shot.png");
  writeFileSync(dialogue, makeTone(10, 180, 2));
  writeFileSync(music, makeTone(12, 110));
  writeFileSync(shot, makeFrame(3));

  const options: FilmCraftSessionOptions = {
    binary: "filmcraft-cli",
    readRoots: [PROJECT],
    writeRoots: [PROJECT],
    clientName: "cap13-harness",
    clientVersion: "1.0.0",
  };
  const session = new FilmCraftSession(options);
  await session.connect();

  try {
    console.log("\n# the stage");
    const project = await session.run("file.newProject", { name: "Ep13_Harness" });
    ok("stage: the project was created", project.ok, project.ok ? "" : project.error);
    const sequence = await session.run("file.newSequence", {
      name: "Ep13",
      width: 640,
      height: 360,
      fps: 24,
      sampleRate: 48000,
      video: 1,
      audio: 2,
      mix: "Stereo",
    });
    ok("stage: the sequence was created", sequence.ok, sequence.ok ? "" : sequence.error);
    const imported = await session.run("file.import", { paths: [dialogue, music, shot] });
    ok("stage: the media was imported", imported.ok, imported.ok ? "" : imported.error);

    const items = imported.ok ? ((imported.result as { items?: number[] }).items ?? []) : [];
    equal("stage: three items came in", items.length, 3);
    const [dialogueItem, musicItem, shotItem] = items as [number, number, number];

    const placed = await session.batch([
      { id: "timeline.place", params: { item: shotItem, track: "V1", time: 0, insert: false, video: true, audio: false } },
      { id: "timeline.place", params: { item: dialogueItem, track: "A1", time: 0, insert: false, video: false, audio: true } },
      { id: "timeline.place", params: { item: musicItem, track: "A2", time: 0, insert: false, video: false, audio: true } },
    ]);
    ok("stage: the timeline was laid out", placed.every((r) => r.ok));

    const snapshot = await session.sequenceInspect();
    equal("stage: one video track", snapshot.video.length, 1);
    equal("stage: two audio tracks", snapshot.audio.length, 2);
    equal("stage: the shot is on the video track", snapshot.video[0]?.items.length, 1);
    const videoClip = snapshot.video[0]?.items[0]?.clip;
    ok("stage: the shot has a clip id", typeof videoClip === "number");

    console.log("\n# the discovery");
    const discovery = await discoverLumetri(session);
    equal("discovery: the effect id", discovery.effectId, "lumetri");
    equal("discovery: the effect name", discovery.effectName, "Lumetri Color");
    equal("discovery: the shadow colour parameter", discovery.wheelParams.shadows.colour, "wheel_shadows");
    equal("discovery: the shadow luma parameter", discovery.wheelParams.shadows.luma, "wheel_shadows_l");
    equal("discovery: the midtone colour parameter", discovery.wheelParams.midtones.colour, "wheel_midtones");
    equal("discovery: the highlight colour parameter", discovery.wheelParams.highlights.colour, "wheel_highlights");

    console.log("\n# the grade");
    const grader = new WheelGrader(session, discovery);
    const report = await grader.applyGrade(videoClip as number, {
      grade: {
        shadows: { hue: 210, saturation: 35, luminance: -12 },
        midtones: { hue: 30, saturation: 22, luminance: 4 },
        highlights: { hue: 45, saturation: 18, luminance: 8 },
        exposure: 0.2,
        contrast: 12,
      },
      requireColorSpace: true,
    });
    ok("grade: it dispatched steps", report.stepsDispatched > 0, `${report.stepsDispatched}`);
    equal("grade: nothing failed", report.stepsFailed, 0);
    ok("grade: it produced a proof frame", report.previewFrameBase64.length > 1000, `${report.previewFrameBase64.length}`);

    const after = await session.sequenceInspect();
    const effects = after.video[0]?.items[0]?.effects ?? [];
    const lumetri = effects.find((e) => e.effect === "lumetri");
    ok("grade: the effect is on the clip", lumetri !== undefined, effects.map((e) => e.effect).join(", "));
    const wheelShadows = lumetri?.params?.["wheel_shadows"];
    ok("grade: the shadow wheel was written", wheelShadows !== undefined, JSON.stringify(Object.keys(lumetri?.params ?? {})));
    const exposure = lumetri?.params?.["exposure"];
    ok("grade: the exposure was written", exposure !== undefined);

    console.log("\n# the ducking");
    const ducker = new DuckingEngine(session);
    const ducking = await ducker.applyPolicy({
      reduceDb: -12,
      attackSeconds: 0.15,
      releaseSeconds: 0.6,
      holdSeconds: 0.25,
      applyToSfx: false,
      requireDialogue: true,
    });
    equal("ducking: the dialogue was found", ducking.dialogueClipIds.length, 1);
    equal("ducking: the music was found", ducking.duckedClipIds.length, 1);
    ok("ducking: the engine ran its pass", ducking.generatedKeyframePasses >= 1, `${ducking.generatedKeyframePasses}`);

    const inspected = await session.run<{
      clips?: Array<{ clip: number; settings?: { kind?: string; ducking?: { enabled?: boolean; reduce_db?: number } } }>;
    }>("essentialSound.inspect", { clips: ducking.duckedClipIds });
    const musicSettings = inspected.ok
      ? (inspected.result.clips ?? []).find((c) => c.clip === ducking.duckedClipIds[0])?.settings
      : undefined;
    equal("ducking: the music is typed", musicSettings?.kind, "Music");
    ok("ducking: the ducking is on", musicSettings?.ducking?.enabled === true, JSON.stringify(musicSettings?.ducking));

    const mixer = await session.run<{ strips?: Array<{ ref?: string; lanes?: Record<string, unknown> }> }>("mixer.inspect", {});
    const a2 = mixer.ok ? mixer.result.strips?.find((s) => s.ref === "A2") : undefined;
    ok("ducking: the volume lane was authored", a2?.lanes?.["volume"] !== undefined, JSON.stringify(a2?.lanes));

    console.log("\n# the loudness");
    const governor = new LoudnessGovernor(session);
    const loudness = await governor.govern({
      integratedLufs: -16,
      truePeakDbTP: -1,
      maxLoudnessRangeLu: 12,
      dialogueAnchorOffsetLu: 0,
      anchorType: "dialogue",
    });
    ok("loudness: it converged", loudness.passes >= 1, `${loudness.passes}`);
    ok(
      "loudness: the measurement is a number",
      Number.isFinite(loudness.integratedLufs),
      `${loudness.integratedLufs}`,
    );
    ok("loudness: the report is inside the tolerance", loudness.withinTolerance, `${loudness.withinTolerance}`);

    const mix = await session.run<{
      strips?: Array<{ kind?: string; ref?: string; inserts?: unknown[] }>;
    }>("mixer.inspect", {});
    const strips = mix.ok ? (mix.result.strips ?? []) : [];
    const master = strips.find((s) => s.kind === "master" || s.ref === "Mix");
    ok(
      "loudness: the limiter is on the mix",
      (master?.inserts ?? []).length > 0,
      JSON.stringify(strips.map((s) => ({ kind: s.kind, ref: s.ref, inserts: (s.inserts ?? []).length }))),
    );
  } finally {
    await session.close();
  }

  assert.ok(existsSync(PROJECT));
  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
