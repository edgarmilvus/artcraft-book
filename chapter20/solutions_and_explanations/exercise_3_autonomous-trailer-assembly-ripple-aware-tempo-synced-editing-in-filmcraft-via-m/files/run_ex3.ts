#!/usr/bin/env tsx
/**
 * run_ex3.ts — the acceptance harness for the autonomous trailer assembler.
 *
 * It builds real footage and a real music bed, runs the reference solution
 * against a real FilmCraft engine, and checks the artefacts the solution
 * leaves behind against the engine's own reports: the sequence the engine
 * read back, the mixer the engine read back, and the rendered trailer.
 *
 * No network and no API key are involved. The music is synthesised here, so
 * the beat detector has something with a known tempo to find.
 *
 *     npx tsx run_ex3.ts
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  TICKS_PER_FRAME,
  TICKS_PER_SEC,
  assemble,
  detectBeats,
  frameToTicks,
  serialiseReport,
  ticksToFrames,
  type TrailerManifest,
  type TrailerReport,
} from "./03_autonomous-trailer-assembly-ripple-aware-tempo-synced-editing-in-filmcraft-via-mcp.js";

const HERE = new URL(".", import.meta.url).pathname;
const WORK = join(HERE, "..", "output", "work");
const MEDIA = join(WORK, "media");
const RUNS = join(WORK, "runs");
const BINARY = process.env.FILMCRAFT_CLI ?? "filmcraft-cli";

let passed = 0;

function check(label: string, condition: boolean, detail = ""): void {
  if (!condition) {
    console.log(`FAIL ${label} — ${detail || "the assertion did not hold"}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`PASS ${label}`);
}

/* --------------------------------------------------------------------- */
/* The fixtures                                                            */
/* --------------------------------------------------------------------- */

interface JsonObject {
  [key: string]: unknown;
}

function asObject(value: unknown): JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** JSON cannot hold a BigInt, so the ticks are written as strings. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** Write a 16-bit PCM WAV. */
function writeWav(path: string, seconds: number, kind: "music" | "voice" | "ambience"): void {
  const rate = 48000;
  const channels = 1;
  const frames = Math.round(seconds * rate);
  const data = Buffer.alloc(frames * channels * 2);
  const beat = 0.5; // 120 bpm
  for (let frame = 0; frame < frames; frame += 1) {
    const t = frame / rate;
    let sample = 0;
    if (kind === "music") {
      // A quiet bed plus a broadband percussive click on every beat: the
      // click is what the spectral flux finds.
      const bed = 0.015 * Math.sin(2 * Math.PI * 110 * t);
      const phase = t % beat;
      let click = 0;
      if (phase < 0.04) {
        // A deterministic white-noise burst with a fast decay.
        const n = Math.sin(frame * 12.9898) * 43758.5453;
        const noise = (n - Math.floor(n)) * 2 - 1;
        click = 0.22 * Math.exp(-phase * 120) * noise;
      }
      sample = bed + click;
    } else if (kind === "voice") {
      const gate = t > 0.5 && t < 5.5 ? 1 : 0;
      sample = 0.1 * gate * Math.sin(2 * Math.PI * 220 * t);
    } else {
      // A low, quiet bed of room tone.
      sample =
        0.0125 *
        (Math.sin(2 * Math.PI * 61.7 * t) * 0.5 + Math.sin(2 * Math.PI * 97.3 * t) * 0.3);
    }
    const value = Math.max(-1, Math.min(1, sample));
    data.writeInt16LE(Math.round(value * 32767), frame * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * channels * 2, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(data.length, 40);
  writeFileSync(path, Buffer.concat([header, data]));
}

/** Synthesise a real H.264 file with ffmpeg. */
function writeVideo(path: string, seconds: number, label: string): void {
  execFileSync(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      `testsrc=size=320x180:rate=24000/1001:duration=${seconds}`,
      "-pix_fmt",
      "yuv420p",
      "-c:v",
      "libx264",
      "-preset",
      "ultrafast",
      "-y",
      path,
    ],
    { stdio: ["ignore", "ignore", "inherit"] },
  );
  if (!existsSync(path) || statSync(path).size === 0) {
    throw new Error(`ffmpeg produced no file for ${label}`);
  }
}

interface Fixture {
  manifest: TrailerManifest;
}

function buildFixture(): Fixture {
  mkdirSync(MEDIA, { recursive: true });
  mkdirSync(RUNS, { recursive: true });

  const musicPath = join(MEDIA, "music.wav");
  const voicePath = join(MEDIA, "vo.wav");
  const ambiencePath = join(MEDIA, "roomtone.wav");
  writeWav(musicPath, 45, "music");
  writeWav(voicePath, 6, "voice");
  writeWav(ambiencePath, 35, "ambience");

  const interviewPaths = [join(MEDIA, "interview-a.mp4"), join(MEDIA, "interview-b.mp4")];
  writeVideo(interviewPaths[0]!, 14, "interview-a");
  writeVideo(interviewPaths[1]!, 11, "interview-b");

  const brollPaths: string[] = [];
  for (let index = 0; index < 24; index += 1) {
    const path = join(MEDIA, `broll-${String(index).padStart(2, "0")}.mp4`);
    writeVideo(path, 4, `broll-${index}`);
    brollPaths.push(path);
  }

  const manifest: TrailerManifest = {
    interviewPaths,
    brollPaths,
    musicPath,
    voPaths: [voicePath],
    ambiencePath,
    aspect: { width: 1920, height: 1080 },
    fps: 23.976,
    targetLoudnessLufs: -14,
    acts: { hookSec: 6, bodySec: 18, titleSec: 6 },
    shotLengthDecayBeats: [4, 3, 2.5, 2],
    rippleGroups: [
      { groupId: "video", tracks: ["V1", "V2", "V3"], locked: false },
      { groupId: "audio", tracks: ["A1", "A2"], locked: false },
      { groupId: "ambience", tracks: ["A3"], locked: true },
    ],
  };
  return { manifest };
}

/* --------------------------------------------------------------------- */
/* Reading the engine's own reports                                        */
/* --------------------------------------------------------------------- */

interface EngineClip {
  clip: number;
  start: number;
  end: number;
  startFrame: number;
  endFrame: number;
  effects: Array<{ effect: string; params: Record<string, { keyframes: number }> }>;
}

interface EngineTrack {
  name: string;
  items: EngineClip[];
  transitions: Array<{ effect: string; duration: number; id: number }>;
}

function trackOf(sequence: JsonObject, name: string): EngineTrack | undefined {
  for (const group of ["video", "audio"]) {
    for (const track of asArray(sequence[group])) {
      const object = asObject(track);
      if (object.name === name) {
        return {
          name,
          items: asArray(object.items).map((item) => {
            const entry = asObject(item);
            return {
              clip: Number(entry.clip ?? 0),
              start: Number(entry.start ?? 0),
              end: Number(entry.end ?? 0),
              startFrame: Number(entry.startFrame ?? 0),
              endFrame: Number(entry.endFrame ?? 0),
              effects: asArray(entry.effects).map((effect) => {
                const descriptor = asObject(effect);
                const params: Record<string, { keyframes: number }> = {};
                for (const [key, value] of Object.entries(asObject(descriptor.params))) {
                  params[key] = { keyframes: Number(asObject(value).keyframes ?? 0) };
                }
                return { effect: String(descriptor.effect ?? ""), params };
              }),
            };
          }),
          transitions: asArray(object.transitions).map((transition) => {
            const entry = asObject(transition);
            return {
              effect: String(entry.effect ?? ""),
              duration: Number(entry.duration ?? 0),
              id: Number(entry.id ?? 0),
            };
          }),
        };
      }
    }
  }
  return undefined;
}

function stripOf(mixer: JsonObject, ref: string): JsonObject | undefined {
  for (const strip of asArray(mixer.strips)) {
    const object = asObject(strip);
    if (object.ref === ref) {
      return object;
    }
  }
  return undefined;
}

/* --------------------------------------------------------------------- */
/* The run                                                                 */
/* --------------------------------------------------------------------- */

async function runAssembler(
  manifest: TrailerManifest,
  name: string,
): Promise<{ report: TrailerReport; workDir: string }> {
  const workDir = join(RUNS, name);
  const report = await assemble(manifest, { binary: BINARY, workDir });
  writeFileSync(join(workDir, "trailer_report.json"), serialiseReport(report));
  return { report, workDir };
}

async function main(): Promise<void> {
  const which = execFileSync("sh", ["-c", `command -v ${BINARY}`], { encoding: "utf-8" }).trim();
  check("the engine is on the PATH", which.length > 0, `no ${BINARY}`);
  const fixture = buildFixture();
  const manifest = fixture.manifest;

  // The tick arithmetic the whole assembler rests on.
  check("the tick base is 254016000000", TICKS_PER_SEC === 254_016_000_000n, TICKS_PER_SEC.toString());
  check(
    "a frame is exactly 10594584000 ticks at 23.976 fps",
    TICKS_PER_FRAME === 10_594_584_000n,
    TICKS_PER_FRAME.toString(),
  );
  const ticks = new Set<bigint>();
  for (let frame = 0n; frame < 4000n; frame += 1n) {
    ticks.add(frameToTicks(frame));
  }
  check("no two frames share a tick", ticks.size === 4000, `${ticks.size} distinct ticks`);

  // The beat detector, on its own, before the assembler touches the engine.
  const detection = detectBeats(manifest.musicPath);
  check(
    "the beat detector finds the tempo of the fixture",
    Math.abs(detection.tempoBpm - 120) < 3,
    `${detection.tempoBpm.toFixed(2)} bpm`,
  );
  check(
    "the beat detector is confident",
    detection.confidence !== "low",
    detection.confidence,
  );

  // The main run.
  const { report, workDir } = await runAssembler(manifest, "first-cut");

  check("the assembler reports the tempo it found", Math.abs(report.tempoBpm - 120) < 3, report.tempoBpm.toFixed(2));
  check(
    "the beat grid is persisted for the human editor",
    existsSync(join(workDir, "beats.json")),
    "beats.json is missing",
  );
  const beatTickSet = new Set(report.beats.map((beat) => beat.tick.toString()));
  const brollCuts = report.cuts.filter((cut) => cut.trackId === "V2");
  check("the assembler cut the b-roll into several shots", brollCuts.length >= 4, `${brollCuts.length} shots`);
  check(
    "every cut lands on a beat",
    brollCuts.every((cut) => beatTickSet.has(cut.toTick.toString())),
    "a cut is off the grid",
  );
  const lengths = brollCuts.map((cut) => cut.toTick - cut.fromTick);
  const beatTicks = report.beats.length > 1 ? report.beats[1]!.tick - report.beats[0]!.tick : 1n;
  check(
    "the first shots follow the decay in the manifest",
    lengths[0] === 4n * beatTicks && lengths[1] === 3n * beatTicks && lengths[3] === 2n * beatTicks,
    lengths.slice(0, 4).map((value) => (value / beatTicks).toString()).join(","),
  );
  check(
    "the shot lengths decay",
    lengths[0]! > lengths[1]! && lengths[1]! > lengths[2]!,
    lengths.slice(0, 4).map((value) => (value / beatTicks).toString()).join(","),
  );
  check(
    "the shots after the decay alternate between two and one beat",
    lengths
      .slice(4, -1)
      .every((value, index) => value === (index % 2 === 0 ? 2n : 1n) * beatTicks),
    lengths.slice(4, 12).map((value) => (value / beatTicks).toString()).join(","),
  );  check(
    "the ripples are not clamped when the rushes cover the act",
    report.ripples.length > 0 && report.ripples.every((ripple) => !ripple.clamped),
    JSON.stringify(report.ripples.map((ripple) => ripple.clamped)),
  );
  check(
    "a ripple moved the graphics with the picture",
    report.ripples.some((ripple) => ripple.tracks.includes("V2") && ripple.tracks.includes("V3")),
    JSON.stringify(report.ripples.map((ripple) => ripple.tracks)),
  );
  check(
    "the ambience bed is locked and never rippled",
    report.ripples.every((ripple) => !ripple.tracks.includes("A3")),
    "A3 moved",
  );
  check(
    "the two cross dissolves and the dip to black are in the report",
    report.transitions.filter((entry) => entry.kind === "cross_dissolve").length === 2 &&
      report.transitions.filter((entry) => entry.kind === "dip_to_black").length === 1,
    JSON.stringify(report.transitions, jsonReplacer),
  );
  check(
    "the cross dissolve into Act II is two beats long",
    report.transitions[0]?.frames ===
      ticksToFrames(2n * (report.beats[1]!.tick - report.beats[0]!.tick)),
    `${report.transitions[0]?.frames}`,
  );
  check(
    "the integrated loudness is inside the tolerance",
    Math.abs(report.audio.integratedLufs - manifest.targetLoudnessLufs) <= 0.5,
    `${report.audio.integratedLufs.toFixed(2)} LUFS`,
  );
  check(
    "the loudness correction was applied once",
    report.audio.offsetApplied !== 0 && report.audio.residualErrorDb <= 0.5,
    JSON.stringify(report.audio),
  );
  check(
    "the decision hash is a sha256",
    /^[0-9a-f]{64}$/.test(report.decisionHash),
    report.decisionHash,
  );
  check(
    "the trailer was exported",
    existsSync(report.outputPath) && statSync(report.outputPath).size > 100_000,
    `${report.outputPath} ${existsSync(report.outputPath) ? statSync(report.outputPath).size : 0} bytes`,
  );
  check(
    "the engine's own reports are written next to the decision report",
    existsSync(join(workDir, "sequence_inspect.json")) &&
      existsSync(join(workDir, "mixer_inspect.json")),
    "the engine's reports are missing",
  );

  // The engine's own report of the sequence.
  const sequence = asObject(JSON.parse(readFileSync(join(workDir, "sequence_inspect.json"), "utf-8")));
  const v2 = trackOf(sequence, "Video 2");
  const v1 = trackOf(sequence, "Video 1");
  const v3 = trackOf(sequence, "Video 3");
  const a3 = trackOf(sequence, "Audio 3");
  check("the engine's report has the b-roll track", v2 !== undefined, "Video 2 is missing");
  const row = (v2?.items ?? []).slice().sort((a, b) => a.start - b.start);
  check(
    "the b-roll row is contiguous",
    row.length > 1 && row.every((clip, index) => index === 0 || row[index - 1]!.end === clip.start),
    JSON.stringify(row.map((clip) => [clip.start, clip.end])),
  );
  const lastBroll = row[row.length - 1];
  const act2End = brollCuts[brollCuts.length - 1]!.toTick;
  check(
    "the b-roll row ends on the act boundary",
    lastBroll !== undefined && lastBroll.end === Number(act2End),
    `${lastBroll?.end} vs ${act2End.toString()}`,
  );
  check(
    "the engine's report has the two cross dissolves",
    (v1?.transitions ?? []).some((transition) => transition.effect === "cross_dissolve") &&
      (v3?.transitions ?? []).some((transition) => transition.effect === "cross_dissolve"),
    JSON.stringify([v1?.transitions, v3?.transitions]),
  );
  const opacity = (v1?.items ?? []).flatMap((clip) => clip.effects).find((effect) => effect.effect === "opacity");
  check(
    "the dip to black is a pair of opacity keyframes",
    opacity !== undefined && (opacity.params.opacity?.keyframes ?? 0) === 2,
    JSON.stringify(opacity?.params.opacity),
  );
  check(
    "the ambience bed is on the locked track",
    (a3?.items ?? []).length === 1,
    JSON.stringify(a3?.items.length),
  );
  const ambienceEnd = a3?.items[0]?.end ?? 0;
  const titleEnd = v3?.items[v3.items.length - 1]?.end ?? 0;
  check(
    "the ambience bed was trimmed to the length of the trailer",
    ambienceEnd > 0 && Math.abs(ambienceEnd - titleEnd) <= 2 * Number(TICKS_PER_FRAME),
    `${ambienceEnd} vs ${titleEnd}`,
  );

  // The engine's own report of the mixer.
  const mixer = asObject(JSON.parse(readFileSync(join(workDir, "mixer_inspect.json"), "utf-8")));
  const musicStrip = stripOf(mixer, "A1");
  check("the engine's report has the music strip", musicStrip !== undefined, "A1 is missing");
  const inserts = asArray(musicStrip?.inserts);
  check(
    "the gain insert is on the music track",
    inserts.length === 1 && asObject(inserts[0]).effect === "amplify" && Number(asObject(inserts[0]).slot) === 0,
    JSON.stringify(inserts),
  );
  const lanes = asObject(musicStrip?.lanes);
  const duck = asArray(lanes["fx.0.gain"]).map((entry) =>
    Array.isArray(entry) ? Number(entry[1]) : Number.NaN,
  );
  check(
    "the music ducks under the voice over",
    duck.length === 4 && duck.filter((value) => value === -6).length === 2,
    JSON.stringify(duck),
  );
  check(
    "the duck releases before the voice over ends",
    duck[0] === 0 && duck[3] === 0,
    JSON.stringify(duck),
  );
  const mixStrip = stripOf(mixer, "Mix");
  check(
    "the loudness correction landed on the mix bus",
    mixStrip !== undefined && Number(mixStrip.volumeDb) !== 0,
    `${mixStrip?.volumeDb}`,
  );

  // A second run of the same manifest must reach the same decisions.
  const repeat = await runAssembler(manifest, "first-cut-repeat");
  check(
    "two runs of the same manifest make the same decisions",
    repeat.report.decisionHash === report.decisionHash,
    `${report.decisionHash.slice(0, 12)} vs ${repeat.report.decisionHash.slice(0, 12)}`,
  );
  check(
    "two runs of the same manifest find the same beats",
    repeat.report.beats.length === report.beats.length &&
      repeat.report.beats[0]?.tick === report.beats[0]?.tick,
    "the beat grids differ",
  );

  // A run whose rushes do not cover the act must clamp the ripple.
  const shortManifest: TrailerManifest = {
    ...manifest,
    brollPaths: manifest.brollPaths.slice(0, 2),
    aspect: { width: 640, height: 360 },
    acts: { hookSec: 3, bodySec: 6, titleSec: 3 },
  };
  const clamped = await runAssembler(shortManifest, "clamped");
  check(
    "the clamp is recorded when the rushes run out",
    clamped.report.ripples.some((ripple) => ripple.clamped) &&
      clamped.report.warnings.some((warning) => warning.code === "ripple-clamped"),
    JSON.stringify(clamped.report.warnings),
  );
  const clampedSequence = asObject(
    JSON.parse(readFileSync(join(clamped.workDir, "sequence_inspect.json"), "utf-8")),
  );
  const clampedRow = (trackOf(clampedSequence, "Video 2")?.items ?? [])
    .slice()
    .sort((a, b) => a.start - b.start);
  check(
    "the clamped row is still contiguous",
    clampedRow.length > 0 &&
      clampedRow.every((clip, index) => index === 0 || clampedRow[index - 1]!.end === clip.start),
    JSON.stringify(clampedRow.map((clip) => [clip.start, clip.end])),
  );
  check(
    "the clamped run still produced a trailer",
    existsSync(clamped.report.outputPath) && statSync(clamped.report.outputPath).size > 10_000,
    clamped.report.outputPath,
  );

  // The artefacts stay under the work directory.
  const stray = ["first-cut", "first-cut-repeat", "clamped"].filter(
    (name) => !existsSync(join(RUNS, name)),
  );
  check("the artefacts stay under the work directory", stray.length === 0, stray.join(","));

  const publishDir = join(HERE, "..", "output");
  for (const [from, to] of [
    [join(RUNS, "first-cut", "trailer_firstcut.mp4"), "trailer_firstcut.mp4"],
    [join(RUNS, "first-cut", "trailer_report.json"), "trailer_report.json"],
    [join(RUNS, "first-cut", "beats.json"), "beats.json"],
    [join(RUNS, "clamped", "trailer_report.json"), "trailer_report_clamped.json"],
  ] as const) copyFileSync(from, join(publishDir, to));

  console.log(`${passed} assertions passed`);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
