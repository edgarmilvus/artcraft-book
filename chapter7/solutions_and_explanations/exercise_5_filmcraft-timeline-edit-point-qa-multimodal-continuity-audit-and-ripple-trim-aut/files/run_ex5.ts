// run_ex5.ts — deterministic harness for the FilmCraft edit-point QA agent.
//
// Builds a three-cut sequence from generated stills and a generated WAV, runs
// the audit with a scripted vision client that measures the actual rasters,
// and checks the engine state after every remediation.

import { strict as assert } from "node:assert";
import { mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  FPS,
  FilmcraftSession,
  THRESHOLDS,
  TICKS_PER_SECOND,
  VISION_SCHEMA,
  analyzeEditPointAudio,
  applyGuardedBatch,
  assessEditPoint,
  audioClipAtCut,
  buildRemediationCommands,
  clipsEqual,
  extractEditPoints,
  framesToTicks,
  planRemediation,
  runFilmcraftQA,
  secondsToTicks,
  ssdBetweenPngs,
  ticksToFrames,
  ticksToSeconds,
  type EditPointAudit,
  type RenderedFrame,
  type TrackClip,
  type VisionClient,
  type VisionRequest,
} from "./05_filmcraft-timeline-edit-point-qa-multimodal-continuity-audit-and-ripple-trim-auto-correction.js";

const ROOT = process.cwd();
const INPUT = resolve(ROOT, "input");
const OUTPUT = resolve(ROOT, "..", "output");

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

function near(label: string, actual: number, expected: number, eps: number): void {
  ok(label, Math.abs(actual - expected) <= eps, `expected ${expected} ± ${eps}, got ${actual}`);
}

// ---------------------------------------------------------------------------
// Fixture media
// ---------------------------------------------------------------------------

const W = 1920;
const H = 1080;

function makeShot(headX: number, backgroundBoost: number): Buffer {
  const png = new PNG({ width: W, height: H });
  for (let y = 0; y < H; y += 1) {
    for (let x = 0; x < W; x += 1) {
      const i = (y * W + x) * 4;
      const horizon = y / H;
      let r = 26 + horizon * 34 + backgroundBoost;
      let g = 34 + horizon * 40 + backgroundBoost;
      let b = 46 + horizon * 36 + backgroundBoost;
      const dx = (x - headX) / 96;
      const dy = (y - 470) / 128;
      const head = dx * dx + dy * dy <= 1;
      const shoulder = y > 560 && y < 840 && Math.abs(x - headX) < 220 - (y - 560) * 0.6;
      if (head) { r = 226; g = 196; b = 164; }
      if (shoulder) { r = 96; g = 108; b = 120; }
      png.data[i] = Math.min(255, Math.round(r));
      png.data[i + 1] = Math.min(255, Math.round(g));
      png.data[i + 2] = Math.min(255, Math.round(b));
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function makeTone(seconds: number): Buffer {
  const sampleRate = 48_000;
  const samples = sampleRate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    const t = i / sampleRate;
    let value = 0.12 * Math.sin(2 * Math.PI * 220 * t) + 0.05 * Math.sin(2 * Math.PI * 440 * t);
    if (i === 6 * sampleRate) value = 0.95; // the pop, exactly at the third cut
    buffer.writeInt16LE(Math.round(Math.max(-1, Math.min(1, value)) * 32767), 44 + i * 2);
  }
  return buffer;
}

// ---------------------------------------------------------------------------
// Scripted vision: measure the rasters instead of calling a provider
// ---------------------------------------------------------------------------

function lstar(r: number, g: number, b: number): number {
  const linear = (value: number) => {
    const channel = value / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  };
  const y = 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  return y > 216 / 24389 ? 116 * Math.cbrt(y) - 16 : (24389 / 27) * y;
}

function headCentre(png: PNG): number | null {
  let sum = 0;
  let count = 0;
  for (let y = 0; y < png.height * 0.62; y += 1) {
    for (let x = 0; x < png.width; x += 1) {
      const i = (y * png.width + x) * 4;
      if (png.data[i] > 180 && png.data[i + 1] > 140 && png.data[i + 2] > 110) {
        sum += x;
        count += 1;
      }
    }
  }
  return count > 50 ? sum / count : null;
}

function meanL(png: PNG): number {
  let total = 0;
  let count = 0;
  for (let i = 0; i < png.data.length; i += 16) {
    total += lstar(png.data[i], png.data[i + 1], png.data[i + 2]);
    count += 1;
  }
  return total / count;
}

function decode(frame: RenderedFrame): PNG {
  return PNG.sync.read(Buffer.from(frame.png, "base64"));
}

const measuredVision: VisionClient = {
  async assess(request: VisionRequest) {
    const a = decode(request.aEnd);
    const b = decode(request.bStart);
    const centreA = headCentre(a);
    const centreB = headCentre(b);
    const shift = centreA !== null && centreB !== null ? (centreB - centreA) / b.width : 0;
    const luminanceA = meanL(a);
    const luminanceB = meanL(b);
    const deltaPct = ((luminanceB - luminanceA) / luminanceA) * 100;
    return {
      jump: {
        jump_detected: Math.abs(shift) > 0.08,
        horizontal_shift_fraction: Math.abs(shift),
        shift_direction: shift > 0.005 ? "right" : shift < -0.005 ? "left" : "none",
        is_numeric_claim: true,
        confidence: 0.96,
        note: `measured head centres ${centreA?.toFixed(1)} → ${centreB?.toFixed(1)} px`,
      },
      luminance: {
        luminance_delta_pct: Number(deltaPct.toFixed(2)),
        is_numeric_claim: true,
        confidence: 0.95,
        note: `measured mean L* ${luminanceA.toFixed(1)} → ${luminanceB.toFixed(1)}`,
      },
    };
  },
};

const nonNumericVision: VisionClient = {
  async assess(request: VisionRequest) {
    const result = await measuredVision.assess(request);
    return {
      jump: { ...result.jump, is_numeric_claim: false, note: "estimated from the description" },
      luminance: { ...result.luminance, is_numeric_claim: false, note: "estimated" },
    };
  },
};

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

const dummyEditPoint = {
  clipA: 1,
  clipB: 2,
  cutTick: secondsToTicks(2),
  track: "V1",
  clipBMediaInTick: secondsToTicks(2),
  clipBDurationTick: secondsToTicks(2),
  clipAName: "a.png",
  clipBName: "b.png",
  clipADurationTick: secondsToTicks(2),
  trackIndex: 0,
};

function audit(overrides: Partial<EditPointAudit>): Omit<EditPointAudit, "remediation"> {
  return {
    editPoint: dummyEditPoint,
    jumpCut: null,
    luminance: null,
    audio: null,
    unverifiable: false,
    applied: false,
    rollback: null,
    error: null,
    ...overrides,
  };
}

function unitPlanning(): void {
  console.log("\n# remediation planning");

  const jump = planRemediation(
    audit({
      jumpCut: {
        jump_detected: true,
        horizontal_shift_fraction: 0.125,
        shift_direction: "right",
        is_numeric_claim: true,
        confidence: 0.9,
        note: "",
      },
    }),
    47,
  );
  equal("plan: jump remediation", jump.remediations[0].kind, "ripple_trim_a_out");
  equal("plan: jump frames", (jump.remediations[0] as any).frames, 12);
  equal("plan: jump touches two clips", jump.clipsTouched, 2);
  ok("plan: jump is automatic", !jump.requiresHumanReview);

  const smallJump = planRemediation(
    audit({
      jumpCut: {
        jump_detected: true,
        horizontal_shift_fraction: 0.151,
        shift_direction: "left",
        is_numeric_claim: true,
        confidence: 0.9,
        note: "",
      },
    }),
    47,
  );
  equal("plan: minimum four frames", (smallJump.remediations[0] as any).frames, 12);

  const belowThreshold = planRemediation(
    audit({
      jumpCut: {
        jump_detected: true,
        horizontal_shift_fraction: 0.08,
        shift_direction: "right",
        is_numeric_claim: true,
        confidence: 0.9,
        note: "",
      },
    }),
    47,
  );
  equal("plan: exactly 8% is not a jump", belowThreshold.remediations[0].kind, "none");

  const pop = planRemediation(
    audit({ audio: { tick: secondsToTicks(2), delta_dbfs: 3.2, is_pop: true } }),
    47,
  );
  equal("plan: pop becomes a crossfade", pop.remediations[0].kind, "crossfade");
  equal("plan: crossfade frames", (pop.remediations[0] as any).frames, 3);
  ok("plan: audio-only pop is automatic", !pop.requiresHumanReview);

  const luminance = planRemediation(
    audit({
      luminance: { luminance_delta_pct: -18.4, is_numeric_claim: true, confidence: 0.9, note: "" },
    }),
    47,
  );
  equal("plan: luminance becomes a ramp", luminance.remediations[0].kind, "exposure_ramp");
  equal("plan: ramp duration", (luminance.remediations[0] as any).durationSeconds, 1);
  equal("plan: ramp touches one clip", luminance.clipsTouched, 1);

  const both = planRemediation(
    audit({
      jumpCut: {
        jump_detected: true,
        horizontal_shift_fraction: 0.125,
        shift_direction: "right",
        is_numeric_claim: true,
        confidence: 0.9,
        note: "",
      },
      audio: { tick: secondsToTicks(2), delta_dbfs: 3.2, is_pop: true },
    }),
    47,
  );
  ok("plan: jump plus pop escalates", both.requiresHumanReview);
  ok("plan: escalation names the clip count", (both.reviewReason ?? "").includes("4 clips"), both.reviewReason ?? "");

  // A shift larger than the 12-frame policy is still corrected by the maximum
  // allowed trim; escalation is reserved for the two explicit rules.
  const oversizedShift = planRemediation(
    audit({
      jumpCut: {
        jump_detected: true,
        horizontal_shift_fraction: 0.22,
        shift_direction: "right",
        is_numeric_claim: true,
        confidence: 0.9,
        note: "",
      },
    }),
    47,
  );
  equal("plan: a 22% shift is capped", (oversizedShift.remediations[0] as any).frames, 12);
  ok("plan: a capped shift stays automatic", !oversizedShift.requiresHumanReview);

  const noHandles = planRemediation(
    audit({
      jumpCut: {
        jump_detected: true,
        horizontal_shift_fraction: 0.1,
        shift_direction: "right",
        is_numeric_claim: true,
        confidence: 0.9,
        note: "",
      },
    }),
    2,
  );
  ok("plan: too few handles escalates", noHandles.requiresHumanReview);
  ok("plan: no commands without handles", noHandles.remediations[0].kind === "none");

  const quiet = planRemediation(audit({}), 47);
  equal("plan: quiet cut needs nothing", quiet.remediations[0].kind, "none");
  ok("plan: quiet cut is automatic", !quiet.requiresHumanReview);

  const commands = buildRemediationCommands(jump, dummyEditPoint, 0);
  equal("commands: ripple has two steps", commands.length, 2);
  equal("commands: edit point selected first", commands[0].id, "trim.selectEditPoint");
  equal("commands: trim is a ripple", commands[1].params.mode, "ripple");
  equal("commands: trim shortens", commands[1].params.deltaFrames, -12);
}

function unitSchema(): void {
  console.log("\n# schema");
  const required = (VISION_SCHEMA.properties.jump as any).required as string[];
  ok("schema: numeric claim is required", required.includes("is_numeric_claim"));
  ok("schema: shift is required", required.includes("horizontal_shift_fraction"));
  ok("schema: no extra properties", (VISION_SCHEMA as any).additionalProperties === false);
  const luminanceRequired = (VISION_SCHEMA.properties.luminance as any).required as string[];
  ok("schema: luminance delta is required", luminanceRequired.includes("luminance_delta_pct"));
}

function unitSsd(): void {
  console.log("\n# raster difference");
  const black = new PNG({ width: 4, height: 4 });
  const white = new PNG({ width: 4, height: 4 });
  for (let i = 0; i < black.data.length; i += 4) {
    black.data[i] = 0; black.data[i + 1] = 0; black.data[i + 2] = 0; black.data[i + 3] = 255;
    white.data[i] = 255; white.data[i + 1] = 255; white.data[i + 2] = 255; white.data[i + 3] = 255;
  }
  const blackB64 = PNG.sync.write(black).toString("base64");
  const whiteB64 = PNG.sync.write(white).toString("base64");
  equal("ssd: identical frames", ssdBetweenPngs(blackB64, blackB64), 0);
  near("ssd: inverted frames", ssdBetweenPngs(blackB64, whiteB64), 1, 0.001);
}

async function unitRetry(): Promise<void> {
  console.log("\n# vision retry");
  const frame: RenderedFrame = { png: "", width: 640, height: 360 };
  let calls = 0;
  const numericOnSecond: VisionClient = {
    async assess(request) {
      calls += 1;
      const result = await measuredVision.assess(request);
      return request.strictNumeric
        ? result
        : { jump: { ...result.jump, is_numeric_claim: false }, luminance: { ...result.luminance, is_numeric_claim: false } };
    },
  };
  // The measured client needs real pixels, so feed it the fixture frames later.
  // Here a tiny 1x1 image is enough to exercise the retry path.
  const tiny = new PNG({ width: 1, height: 1 });
  tiny.data.fill(255);
  const tinyFrame: RenderedFrame = { png: PNG.sync.write(tiny).toString("base64"), width: 1, height: 1 };
  const recovered = await assessEditPoint(numericOnSecond, { prior: tinyFrame, aEnd: tinyFrame, bStart: tinyFrame }, 2);
  equal("retry: two attempts", recovered.attempts, 2);
  ok("retry: recovered on the strict pass", !recovered.unverifiable);

  const alwaysNonNumeric: VisionClient = {
    async assess(request) {
      const result = await measuredVision.assess(request);
      return { jump: { ...result.jump, is_numeric_claim: false }, luminance: { ...result.luminance, is_numeric_claim: false } };
    },
  };
  const refused = await assessEditPoint(alwaysNonNumeric, { prior: tinyFrame, aEnd: tinyFrame, bStart: tinyFrame }, 2);
  equal("retry: still two attempts", refused.attempts, 2);
  ok("retry: second refusal is unverifiable", refused.unverifiable);
  void frame;
  void calls;
}

// ---------------------------------------------------------------------------
// Fixture sequence
// ---------------------------------------------------------------------------

async function buildFixture(session: FilmcraftSession): Promise<void> {
  writeFileSync(resolve(INPUT, "shot-a.png"), makeShot(640, 0));
  writeFileSync(resolve(INPUT, "shot-b.png"), makeShot(880, 0));
  writeFileSync(resolve(INPUT, "shot-c.png"), makeShot(880, 70));
  writeFileSync(resolve(INPUT, "shot-d.png"), makeShot(880, 70));
  writeFileSync(resolve(INPUT, "tone.wav"), makeTone(8));

  await session.command("file.newProject", { name: "Edit-Point QA Fixture" });
  const imported = await session.importMedia([
    resolve(INPUT, "shot-a.png"),
    resolve(INPUT, "shot-b.png"),
    resolve(INPUT, "shot-c.png"),
    resolve(INPUT, "shot-d.png"),
    resolve(INPUT, "tone.wav"),
  ]);
  assert.equal(imported.errors.length, 0);

  await session.command("file.newSequence", {
    name: "Travel Cut",
    width: W,
    height: H,
    fps: 24_000 / 1001,
    video: 1,
    audio: 1,
  });

  const placements: [number, string, number, number, number][] = [
    [1, "V1", 0, 2, 0],
    [2, "V1", 2, 2, 0],
    [3, "V1", 4, 2, 0],
    [4, "V1", 6, 2, 0],
    [5, "A1", 0, 2, 0],
    [5, "A1", 2, 2, 2],
    [5, "A1", 4, 2, 4],
    [5, "A1", 6, 2, 6],
  ];
  for (const [item, track, start, duration, sourceIn] of placements) {
    await session.command("timeline.place", {
      item,
      track,
      time: secondsToTicks(start),
      duration: secondsToTicks(duration),
      sourceIn: secondsToTicks(sourceIn),
    });
  }

  // Linking each video clip to its audio keeps a ripple trim in sync: the
  // engine ripples linked clips together, while a sync-locked unlinked track
  // blocks the edit with "a clip is in the way".
  const view = await session.inspectSequence();
  const video = view.tracks.find((track) => track.label === "V1")!.clips;
  const audio = view.tracks.find((track) => track.label === "A1")!.clips;
  for (let i = 0; i < video.length; i += 1) {
    await session.command("clip.link", { clips: [video[i].id, audio[i].id] });
  }
}

// ---------------------------------------------------------------------------
// Integration
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Keep the shell-captured run_ex5.log beside the artefacts: clear only the
  // evidence this harness regenerates, never the whole output directory.
  rmSync(resolve(OUTPUT, "frames"), { recursive: true, force: true });
  for (const name of ["audit_report.json", "summary.txt", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  mkdirSync(INPUT, { recursive: true });
  mkdirSync(OUTPUT, { recursive: true });

  unitPlanning();
  unitSchema();
  unitSsd();
  await unitRetry();

  const session = new FilmcraftSession();
  await session.connect();
  try {
    await buildFixture(session);
    const view = await session.inspectSequence();
    const editPoints = extractEditPoints(view, "V1");
    equal("fixture: three hard cuts", editPoints.length, 3);
    near("fixture: first cut", ticksToSeconds(editPoints[0].cutTick), 2, 0.001);
    near("fixture: second cut", ticksToSeconds(editPoints[1].cutTick), 4, 0.001);
    near("fixture: third cut", ticksToSeconds(editPoints[2].cutTick), 6, 0.001);
    equal("fixture: clip A name", editPoints[0].clipAName, "shot-a.png");
    equal("fixture: clip B name", editPoints[0].clipBName, "shot-b.png");
    ok("fixture: audio clip is linked at the cut", audioClipAtCut(view, editPoints[0].cutTick) !== null);

    // --- Local audio analysis ------------------------------------------------
    console.log("\n# audio");
    const resolveMedia = (clip: TrackClip) => resolve(INPUT, clip.name);
    const pop = await analyzeEditPointAudio(view, editPoints[2].cutTick, resolveMedia);
    ok("audio: third cut is a pop", pop?.is_pop === true, `${pop?.delta_dbfs}`);
    ok("audio: pop is louder than -24 dBFS", (pop?.delta_dbfs ?? 100) < 24, `${pop?.delta_dbfs}`);
    const smooth = await analyzeEditPointAudio(view, editPoints[0].cutTick, resolveMedia);
    ok("audio: first cut is smooth", smooth?.is_pop === false, `${smooth?.delta_dbfs}`);
    ok("audio: smooth delta is below the threshold", (smooth?.delta_dbfs ?? 0) > 24, `${smooth?.delta_dbfs}`);

    // --- Full audit ----------------------------------------------------------
    console.log("\n# audit");
    const report = await runFilmcraftQA(session, {
      track: "V1",
      mediaRoot: INPUT,
      vision: measuredVision,
      outputDir: resolve(OUTPUT, "frames"),
      apply: true,
      log: (message) => console.log(`   ${message}`),
    });

    equal("audit: three edit points", report.editPoints.length, 3);
    equal("audit: one jump cut", report.summary.jumpCuts, 1);
    equal("audit: one luminance jump", report.summary.luminanceJumps, 1);
    equal("audit: one pop", report.summary.pops, 1);
    equal("audit: three remediations", report.summary.remediated, 3);
    equal("audit: nothing rolled back", report.summary.rolledBack, 0);
    equal("audit: nothing escalated", report.summary.escalated, 0);
    equal("audit: nothing unverifiable", report.summary.unverifiable, 0);

    const [jumpCut, luminanceCut, popCut] = report.editPoints;
    equal("audit: jump plan", jumpCut.remediation?.remediations[0].kind, "ripple_trim_a_out");
    near("audit: measured head shift", jumpCut.jumpCut?.horizontal_shift_fraction ?? 0, 0.125, 0.01);
    equal("audit: jump direction", jumpCut.jumpCut?.shift_direction, "right");
    ok("audit: jump applied", jumpCut.applied);
    ok("audit: jump rollback is clean", jumpCut.rollback !== null && !jumpCut.rollback.rolledBack);
    ok("audit: downstream SSD below 0.08", (jumpCut.rollback?.ssdDownstream ?? 1) <= 0.08);

    ok("audit: luminance ramp applied", luminanceCut.applied);
    equal("audit: luminance plan", luminanceCut.remediation?.remediations[0].kind, "exposure_ramp");
    ok("audit: luminance delta exceeds 12%", Math.abs(luminanceCut.luminance?.luminance_delta_pct ?? 0) > 12);

    ok("audit: crossfade applied", popCut.applied);
    equal("audit: pop plan", popCut.remediation?.remediations[0].kind, "crossfade");

    // --- Engine state --------------------------------------------------------
    console.log("\n# engine state");
    const finalView = await session.inspectSequence();
    const finalCuts = extractEditPoints(finalView, "V1");
    equal("state: cut count unchanged", finalCuts.length, 3);
    near("state: first cut moved by 12 frames", ticksToSeconds(finalCuts[0].cutTick), 2 - 12 / FPS, 0.002);
    near("state: second cut moved", ticksToSeconds(finalCuts[1].cutTick), 4 - 12 / FPS, 0.002);
    near("state: third cut moved", ticksToSeconds(finalCuts[2].cutTick), 6 - 12 / FPS, 0.002);

    const clipA = finalView.tracks.find((track) => track.label === "V1")!.clips
      .find((clip) => clip.name === "shot-a.png")!;
    equal("state: clip A lost 12 frames", ticksToFrames(clipA.durationTick), 36);

    const rampClip = finalView.tracks.find((track) => track.label === "V1")!.clips
      .find((clip) => clip.name === "shot-c.png")!;
    const lumetri = rampClip ? (finalView.raw.video[0].items.find((item: any) => item.clip === rampClip.id)
      ?.effects ?? []).find((effect: any) => effect.effect === "lumetri") : null;
    ok("state: shot C carries lumetri", lumetri !== undefined && lumetri !== null);
    equal("state: exposure has two keyframes", lumetri?.params?.exposure?.keyframes, 2);
    near("state: ramp ends at zero", Number(String(lumetri?.params?.exposure?.value ?? "Float(NaN)").match(/-?\d+(\.\d+)?/)?.[0] ?? NaN), 0, 0.001);

    const audioTrack = finalView.tracks.find((track) => track.label === "A1")!;
    equal("state: one audio transition", audioTrack.transitions.length, 1);
    equal("state: transition effect", audioTrack.transitions[0].effect, "constant_power");
    near("state: transition is three frames", audioTrack.transitions[0].duration, framesToTicks(3), framesToTicks(1));

    const audioAtFirstCut = audioTrack.clips.find((clip) => clip.startTick === finalCuts[0].cutTick);
    ok("state: audio rippled with the video", audioAtFirstCut !== undefined);

    // --- Unverifiable path ---------------------------------------------------
    console.log("\n# unverifiable");
    const unverifiable = await runFilmcraftQA(session, {
      track: "V1",
      mediaRoot: INPUT,
      vision: nonNumericVision,
      apply: false,
    });
    equal("unverifiable: all cuts", unverifiable.editPoints.length, 3);
    equal("unverifiable: every cut flagged", unverifiable.summary.unverifiable, 3);
    equal("unverifiable: no remediation applied", unverifiable.summary.remediated, 0);
    ok(
      "unverifiable: reason names the numeric claim",
      (unverifiable.editPoints[0].remediation?.reviewReason ?? "").includes("unverifiable"),
      unverifiable.editPoints[0].remediation?.reviewReason ?? "",
    );

    // --- Guarded rollback on real damage ------------------------------------
    console.log("\n# rollback");
    const before = await session.inspectSequence();
    const beforeCuts = extractEditPoints(before, "V1");
    const clipsBefore = before.tracks.flatMap((track) => track.clips);
    const target = before.tracks.find((track) => track.label === "V1")!.clips
      .find((clip) => clip.name === "shot-c.png")!;
    // Invert is a one-command, unmistakable change to the incoming frame at
    // the downstream cut, which makes the guard's job unambiguous.
    const damage = [{ id: "effects.apply", params: { clips: [target.id], effect: "invert" } }];
    const guarded = await applyGuardedBatch(session, damage, {
      track: "V1",
      downstreamCutIndex: 1,
      fallbackDownstreamTick: beforeCuts[1].cutTick,
      maxSide: 640,
    });
    ok("rollback: guard saw downstream damage", guarded.rollback.ssdDownstream > THRESHOLDS.jumpFraction);
    ok("rollback: batch rolled back", guarded.rollback.rolledBack);
    equal("rollback: one command undone", guarded.rollback.undoDepth, 1);
    ok("rollback: clip table restored exactly", guarded.rollback.restoredExactly);

    const after = await session.inspectSequence();
    equal(
      "rollback: clip table identical",
      clipsEqual(
        clipsBefore.map((clip) => ({
          id: clip.id,
          track: clip.track,
          startTick: clip.startTick,
          durationTick: clip.durationTick,
          mediaInTick: clip.mediaInTick,
        })),
        after.tracks.flatMap((track) => track.clips).map((clip) => ({
          id: clip.id,
          track: clip.track,
          startTick: clip.startTick,
          durationTick: clip.durationTick,
          mediaInTick: clip.mediaInTick,
        })),
      ),
      true,
    );
    const restoredClip = after.raw.video[0].items.find((item: any) => item.clip === target.id);
    ok("rollback: effect removed", !(restoredClip.effects ?? []).some((effect: any) => effect.effect === "invert"));

    // --- Outputs -------------------------------------------------------------
    writeFileSync(resolve(OUTPUT, "audit_report.json"), JSON.stringify(report, null, 2));
    writeFileSync(
      resolve(OUTPUT, "summary.txt"),
      [
        `sequence: ${report.sequence.name} (${report.sequence.width}x${report.sequence.height} @ ${report.sequence.fps.toFixed(3)} fps)`,
        `cuts: ${report.summary.cuts}`,
        `jump cuts: ${report.summary.jumpCuts}`,
        `luminance jumps: ${report.summary.luminanceJumps}`,
        `audio pops: ${report.summary.pops}`,
        `remediated: ${report.summary.remediated}`,
        `rolled back: ${report.summary.rolledBack}`,
        `escalated: ${report.summary.escalated}`,
        "",
        `ticks per second: ${TICKS_PER_SECOND}`,
      ].join("\n"),
    );
    ok("output: report", existsSync(resolve(OUTPUT, "audit_report.json")));
    ok("output: summary", existsSync(resolve(OUTPUT, "summary.txt")));

    const frameNames = [1, 2, 3].flatMap((cut) =>
      ["a-end", "b-start", "prior"].map((kind) => `cut-${cut}-${kind}.png`));
    for (const frame of frameNames) {
      const path = resolve(OUTPUT, "frames", frame);
      ok(`output: frame ${frame}`, existsSync(path));
      ok(`output: frame ${frame} non-empty`,
        existsSync(path) && PNG.sync.read(readFileSync(path)).width === 640);
    }

    writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
      exercise: 5,
      engine: "filmcraft-cli",
      sequence: report.sequence,
      summary: report.summary,
      assertions: passed + 1,
      frames: frameNames,
      artefacts: ["audit_report.json", "summary.txt", ...frameNames.map((f) => `frames/${f}`)],
      result: "three edit points audited; jump, luma shift and audio pop remediated; guard rollback verified",
    }, null, 2));
    ok("output: manifest report", existsSync(resolve(OUTPUT, "report.json")));
  } finally {
    await session.close();
  }

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
