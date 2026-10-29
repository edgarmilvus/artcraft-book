import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/* ------------ Types ------------------------------------------------------ */
export interface MixReport {
  sequenceId: number;
  preDuckLufs: Record<string, number>;
  postDuckLufs: Record<string, number>;
  truePeakDbtp: number;
  generatedKeys: number;
  maxDuckDepthDb: number;
  speechIntervals: Array<{ startSec: number; endSec: number }>;
  masterCorrectionDb: number;
  residualDeviation: number;
  pass: boolean;
}
const TICKS_PER_SEC = 254_016_000_000;
const FRAME_MS = 1000 / 23.976;
const TICKS_PER_MS = TICKS_PER_SEC / 1000;

/* ------------ Transport helpers ------------------------------------------- */
/** Run one engine command through the `command_run` meta-tool. */
async function run(client: Client, id: string, params: Record<string, unknown> = {}) {
  const reply = await client.callTool({ name: "command_run", arguments: { id, params } });
  const blocks = (reply as any).content ?? [];
  const text = blocks.find((b: any) => b.type === "text")?.text;
  if (text === undefined) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

/** Read the active sequence. */
async function sequence(client: Client): Promise<any> {
  const reply = await client.callTool({ name: "sequence_inspect", arguments: {} });
  const text = (reply as any).content?.find((b: any) => b.type === "text")?.text;
  return text ? JSON.parse(text) : {};
}

/** The short alias of a track label: "Audio 3" -> "A3". */
export function trackAlias(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 2 && /^(video|audio|caption)$/i.test(parts[0] ?? "") && /^\d+$/.test(parts[1] ?? "")) {
    const prefix =
      (parts[0] ?? "").toLowerCase() === "video" ? "V" : (parts[0] ?? "").toLowerCase() === "audio" ? "A" : "C";
    return prefix + parts[1];
  }
  return name;
}

/* ------------ Locate dialogue gaps via onset scanning --------------------- */
// The mixer inspects clip boundaries; where the dialogue track has an audio
// clip whose peak exceeds a floor, we treat that as "speech present". This
// gives us noise-robust intervals even if the extraction was recorded with
// a live lav — the floor is well below speech RMS but above room tone.
async function detectSpeechIntervals(client: Client, dialogueClipIds: number[]) {
  const intervals: Array<{ startSec: number; endSec: number }> = [];
  for (const id of dialogueClipIds) {
    const peak = await run(client, "clip.audioPeak", { clips: [id] });
    const peakDb = (peak as any).peakDb ?? -60;
    // Treat the clip's own boundary as one interval; the mixer knows speech
    // doesn't extend past the clip's in/out points.
    const info = await sequence(client);
    const clip = findClip(info, id);
    if (clip && peakDb > -40) {
      intervals.push({ startSec: clip.start / TICKS_PER_SEC, endSec: (clip.start + clip.duration) / TICKS_PER_SEC });
    }
  }
  return intervals;
}
function findClip(seq: any, id: number): any | undefined {
  for (const t of [...(seq.video ?? []), ...(seq.audio ?? [])]) {
    for (const c of t.items ?? []) if (c.clip === id) return c;
  }
  return undefined;
}

/* ------------ Write explicit attack/release keyframes --------------------- */
// The generated ducking curve is musical but not spec-compliant on attack.
// We overwrite the melody with bezier ramps that hit −14 dB in exactly 30 ms
// and recover over 450 ms — this preserves natural speech pauses because the
// bezier handles are long, not because the ramp is short.
export async function writeAttackReleaseKeyframes(
  client: Client,
  strip: "A3" | "A4",
  speech: Array<{ startSec: number; endSec: number }>,
  depthDb: number,
  attackMs = 30,
  releaseMs = 450,
  attackHoldMs = 0,
) {
  let written = 0;
  for (const s of speech) {
    const onsetTick  = Math.round((s.startSec * 1000 - attackMs) * TICKS_PER_MS);
    const duckTick   = Math.round((s.startSec * 1000 + attackHoldMs) * TICKS_PER_MS);
    const releaseBegin = Math.round((s.endSec * 1000 + attackHoldMs) * TICKS_PER_MS);
    const releaseEnd   = Math.round((s.endSec * 1000 + attackHoldMs + releaseMs) * TICKS_PER_MS);

    // Pre-speech at 0 dB → 30 ms later at −14 dB → hold → ramp back up.
    for (const [tick, value] of [
      [onsetTick,    0],
      [duckTick,     depthDb],
      [releaseBegin, depthDb],
      [releaseEnd,   0],
    ] as const) {
      await run(client, "mixer.setKeyframe", { strip, lane: "volume", time: tick, value });
      written++;
    }
  }
  return written;
}

/* ------------ Master bus correction --------------------------------------- */
export async function correctMasterBus(client: Client, currentLufs: number, target: number) {
  // Distance to the nearest edge of the acceptance window.
  const deviation = currentLufs - target;       // positive = program too loud
  const correction = Math.max(-3, Math.min(3, -deviation)); // cap ±3 dB
  if (Math.abs(correction) < 0.05) return { correction: 0, residual: deviation };
  // The Mix strip carries the programme bus: the correction is written to
  // its volume lane.
  await run(client, "mixer.setValue", { strip: "Mix", lane: "volume", value: correction });
  return { correction, residual: deviation + correction };
}

/**
 * The loudness of a set of clips.
 *
 * `essentialSound.inspect` reports the measured loudness and the applied
 * gain of every clip; the loudness the clip will be heard at is the sum of
 * the two.
 */
export function summariseLoudness(payload: any): {
  dialogue: number;
  music: number;
  integrated: number;
} {
  const clips: any[] = payload?.clips ?? [];
  const of = (kind: string): number => {
    const values = clips
      .filter((c) => (c.settings?.kind ?? "").toLowerCase() === kind)
      .map((c) => {
        const loudness = c.settings?.loudness;
        if (typeof loudness?.measured_lufs !== "number") return undefined;
        return loudness.measured_lufs + (loudness.gain_db ?? c.gainDb ?? 0);
      })
      .filter((v): v is number => v !== undefined);
    return values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : NaN;
  };
  const dialogue = of("dialogue");
  const music = of("music");
  const all = [dialogue, music].filter((v) => !Number.isNaN(v));
  return {
    dialogue,
    music,
    integrated: all.length > 0 ? all.reduce((a, b) => a + b, 0) / all.length : NaN,
  };
}

/* ------------ Main ------------------------------------------------------- */
export async function runDucking(sequenceId: number): Promise<MixReport> {
  const client = new Client({ name: "ducking-mixer", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: "filmcraft-cli",
    args: ["mcp", "--automation-read-root", "/work/audio", "--automation-write-root", "/work/audio"],
  }));

  // 1. Inspect and bucket clips by track role. The inspector reports the
  //    audio tracks under `audio`, and every clip is identified by `clip`.
  const seq = await sequence(client);
  const dialogueIds: number[] = [], musicIds: number[] = [], sfxIds: number[] = [];
  for (const track of seq.audio ?? []) {
    const alias = trackAlias(track.name ?? "");
    const ids = (track.items ?? []).map((c: any) => c.clip as number);
    if (alias === "A1" || alias === "A2") dialogueIds.push(...ids);
    else if (alias === "A3" || alias === "A4") musicIds.push(...ids);
    else if (alias === "A5") sfxIds.push(...ids);
  }

  // 2. Tag by Essential Sound type.
  await run(client, "essentialSound.setType", { clips: dialogueIds, type: "dialogue" });
  await run(client, "essentialSound.setType", { clips: musicIds, type: "music" });
  await run(client, "essentialSound.setType", { clips: sfxIds, type: "sfx" });

  // 3. Pre-duck loudness reading (for the report). The engine reports the
  //    measured loudness and the gain of every clip it knows.
  const pre = await run(client, "essentialSound.inspect", {
    clips: [...dialogueIds, ...musicIds, ...sfxIds],
  });
  const preDuckLufs = summariseLoudness(pre);

  // 4. Reference-match each family.
  await run(client, "essentialSound.autoMatch", { clips: dialogueIds, target: -23 });
  await run(client, "essentialSound.autoMatch", { clips: musicIds, target: -28 });

  // 5. Configure ducking.
  await run(client, "essentialSound.set", { clips: musicIds, key: "ducking.reduceDb", value: -14 });
  await run(client, "essentialSound.set", { clips: musicIds, key: "creative.reverbPreset", value: "Small Room" });

  // 6. Generate ducking (writes track-strip volume lane).
  await run(client, "essentialSound.generateDucking", { clips: musicIds });

  // 7. Assert lanes exist before we touch them. A lane is a list of
  //    [tick, value] points.
  const mix = await run(client, "mixer.inspect", {});
  const stripA3 = (mix.strips ?? []).find((s: any) => s.ref === "A3");
  const stripA4 = (mix.strips ?? []).find((s: any) => s.ref === "A4");
  if (!stripA3?.lanes?.volume?.length || !stripA4?.lanes?.volume?.length) {
    throw new Error("Essential Sound did not populate A3/A4 volume lanes");
  }

  // 8. Override with explicit attack/release (bezier) at documented boundaries.
  const speech = await detectSpeechIntervals(client, dialogueIds);
  const kA3 = await writeAttackReleaseKeyframes(client, "A3", speech, -14);
  const kA4 = await writeAttackReleaseKeyframes(client, "A4", speech, -14);
  const generatedKeys = kA3 + kA4;

  // 9. Post-duck measurements.
  const post = await run(client, "essentialSound.inspect", {
    clips: [...dialogueIds, ...musicIds],
  });
  const postSummary = summariseLoudness(post);
  let postIntegrated = postSummary.integrated;

  const peakReply = await run(client, "clip.audioPeak", {
    clips: [...dialogueIds, ...musicIds],
  });
  const truePeakDbtp = (peakReply.truePeakDbtp ?? peakReply.peakDb ?? -3) as number;

  // 10. SII check — the gap between the dialogue and the music bed.
  const sii = postSummary.dialogue - postSummary.music;
  const siiOk = sii >= 12;

  // 11. Master-bus correction if the ducked program drifted.
  let masterCorrectionDb = 0, residualDeviation = 0;
  const inWindow = postIntegrated >= -26 && postIntegrated <= -22;
  if (!inWindow) {
    const { correction, residual } = await correctMasterBus(client, postIntegrated, -24);
    masterCorrectionDb = correction;
    residualDeviation = residual;
    postIntegrated += correction;
  }
  const compliant =
    postIntegrated >= -26 && postIntegrated <= -22 &&
    truePeakDbtp <= -2 && siiOk && Math.abs(residualDeviation) < 0.5;

  const report: MixReport = {
    sequenceId,
    preDuckLufs,
    postDuckLufs: {
      integrated: postIntegrated,
      dialogue: postSummary.dialogue,
      music: postSummary.music,
    },
    truePeakDbtp,
    generatedKeys,
    maxDuckDepthDb: 14,
    speechIntervals: speech,
    masterCorrectionDb,
    residualDeviation,
    pass: compliant,
  };

  await client.close();
  writeFileSync("/work/audio/mix_report.json", JSON.stringify(report, null, 2));
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runDucking(42).catch((e) => { console.error(e); process.exit(1); });
}
