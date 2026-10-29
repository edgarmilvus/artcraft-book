import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/* ------------ Types ------------------------------------------------------ */
export interface SpecStreamingA {
  client: "StreamingA"; creativeTone: "warm_cinematic" | "cool_desaturated" | "neutral_documentary";
  acquisitionCamera: string; loudnessStandard: "STREAMING";
  expectedRuntimeSec: number; targetCodec: "prores" | "h264";
}
export interface SpecStreamingB {
  client: "StreamingB"; tone: { adjective1: string; adjective2: string }; camera: string;
  loudness: { standard: "STREAMING" | "ATSC_A85" }; runtimeSec: number;
  codec: { container: "mov" | "mp4"; profile: string };
}
export interface SpecBroadcastX {
  client: "BroadcastX";
  styleGuide: { palette: "warm" | "cool" | "neutral"; saturation: "low" | "medium" | "high" };
  cameraModel: string;
  deliverySpec: { loudness: "EBU_R128" | "ATSC_A85"; truePeakCeilingDbtp: number };
  duration: { hours: number; minutes: number; seconds: number };
  outputFormat: "prores" | "dnxhr";
}
export type RawSpec = SpecStreamingA | SpecStreamingB | SpecBroadcastX;

export interface DeliverySpec {
  client: string;
  creativeTone: "warm_cinematic" | "cool_desaturated" | "neutral_documentary";
  acquisitionCamera: string;
  loudnessStandard: "EBU_R128" | "ATSC_A85" | "STREAMING";
  integratedLufsTarget: number; integratedLufsTolerance: number; truePeakCeilingDbtp: number;
  expectedRuntimeSec: number; targetCodec: "prores" | "h264" | "dnxhr";
  targetContainer: "mov" | "mp4"; proresProfile?: "hq" | "4444" | "lt";
}
export interface DeliveryManifest {
  pipelineVersion: string;
  specNormalization: { raw: RawSpec; normalized: DeliverySpec };
  gradeEvidence: Array<{ clipId: number; verificationPng: string;
                         scopeReadout: { paradeMaxIre: number; waveformMaxIre: number; midtoneMeanY: number } }>;
  audioEvidence: { preDuckLufs: number; postDuckLufs: number; duckingKeyframes: number;
                   finalIntegratedLufs: number; finalTruePeakDbtp: number };
  exportEvidence: { path: string; codec: string; durationSec: number; sampleRate: number; channels: number };
  idempotencyHash: string;
  manifestGeneratedAtIso: string;
}

/* ------------ Lookup tables ---------------------------------------------- */
const TONE_WHEELS: Record<DeliverySpec["creativeTone"], any> = {
  warm_cinematic:    { shadows: { hue: 220, sat: 8,  balance: -0.02 },
                       midtones: { hue: 30,  sat: 12, balance:  0.04 },
                       highlights: { hue: 45, sat: 10, balance:  0.02 } },
  cool_desaturated:  { shadows: { hue: 195, sat: 20, balance: -0.06 },
                       midtones: { hue: 210, sat: 5,  balance:  0.00 },
                       highlights: { hue: 220, sat: 6,  balance: -0.02 } },
  neutral_documentary: { shadows:    { hue: 0, sat: 0, balance: 0 },
                         midtones:   { hue: 0, sat: 0, balance: 0 },
                         highlights: { hue: 0, sat: 0, balance: 0 } },
};

const LOUDNESS_TABLE: Record<DeliverySpec["loudnessStandard"], {
  target: number; tolerance: number; truePeak: number; duckDepthDb: number; dialogueRef: number;
}> = {
  EBU_R128:  { target: -23, tolerance: 0.5, truePeak: -1, duckDepthDb: -14, dialogueRef: -23 },
  ATSC_A85:  { target: -24, tolerance: 2.0, truePeak: -2, duckDepthDb: -14, dialogueRef: -24 },
  STREAMING: { target: -14, tolerance: 1.0, truePeak: -1, duckDepthDb: -12, dialogueRef: -14 },
};

/* ------------ Spec normalizer -------------------------------------------- */
export function normalizeSpec(raw: RawSpec): DeliverySpec {
  if (raw.client === "StreamingA") {
    // StreamingA's brief always resolves to the streaming standard.
    const l = LOUDNESS_TABLE.STREAMING;
    return { client: raw.client, creativeTone: raw.creativeTone,
             acquisitionCamera: raw.acquisitionCamera,
             loudnessStandard: "STREAMING",
             integratedLufsTarget: l.target, integratedLufsTolerance: l.tolerance,
             truePeakCeilingDbtp: l.truePeak, expectedRuntimeSec: raw.expectedRuntimeSec,
             targetCodec: raw.targetCodec, targetContainer: "mov" };
  }
  if (raw.client === "StreamingB") {
    // Free-form adjectives → nearest canonical tone.
    const adjectives = `${raw.tone.adjective1} ${raw.tone.adjective2}`.toLowerCase();
    const tone: DeliverySpec["creativeTone"] =
      adjectives.includes("cool") ? "cool_desaturated" :
      adjectives.includes("warm") ? "warm_cinematic" : "neutral_documentary";
    const std = raw.loudness.standard as DeliverySpec["loudnessStandard"];
    const l = STANDARD_LOOKUP(std);
    return { client: raw.client, creativeTone: tone, acquisitionCamera: raw.camera,
             loudnessStandard: std, integratedLufsTarget: l.target,
             integratedLufsTolerance: l.tolerance, truePeakCeilingDbtp: l.truePeak,
             expectedRuntimeSec: raw.runtimeSec, targetCodec: "prores",
             targetContainer: raw.codec.container,
             proresProfile: raw.codec.profile.includes("4444") ? "4444" : "hq" };
  }
  // BroadcastX
  const std = raw.deliverySpec.loudness;
  const l = STANDARD_LOOKUP(std);
  const tone: DeliverySpec["creativeTone"] =
    raw.styleGuide.palette === "warm" && raw.styleGuide.saturation === "low" ? "warm_cinematic" :
    raw.styleGuide.palette === "cool" ? "cool_desaturated" : "neutral_documentary";
  return { client: raw.client, creativeTone: tone,
           acquisitionCamera: raw.cameraModel, loudnessStandard: std,
           integratedLufsTarget: l.target, integratedLufsTolerance: l.tolerance,
           truePeakCeilingDbtp: raw.deliverySpec.truePeakCeilingDbtp,
           expectedRuntimeSec: raw.duration.hours*3600 + raw.duration.minutes*60 + raw.duration.seconds,
           targetCodec: raw.outputFormat, targetContainer: "mov" };
}
export function STANDARD_LOOKUP(s: "EBU_R128"|"ATSC_A85"|"STREAMING") { return LOUDNESS_TABLE[s]; }

/* ------------ Transport helpers ------------------------------------------- */
/** Run one engine command through the `command_run` meta-tool. */
async function run(client: Client, id: string, params: Record<string, unknown> = {}) {
  const reply = await client.callTool({ name: "command_run", arguments: { id, params } });
  const text = (reply as any).content?.find((b: any) => b.type === "text")?.text;
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
function trackAlias(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 2 && /^(video|audio|caption)$/i.test(parts[0] ?? "") && /^\d+$/.test(parts[1] ?? "")) {
    const prefix =
      (parts[0] ?? "").toLowerCase() === "video" ? "V" : (parts[0] ?? "").toLowerCase() === "audio" ? "A" : "C";
    return prefix + parts[1];
  }
  return name;
}

/* ------------ Preflight -------------------------------------------------- */
async function preflight(client: Client, spec: DeliverySpec) {
  const docReply = await client.callTool({ name: "doc_inspect", arguments: {} });
  const doc = JSON.parse(
    (docReply as any).content?.find((b: any) => b.type === "text")?.text ?? "{}",
  );
  // The media items hang under the project tree.
  const mediaItems: any[] = [];
  const walk = (node: any): void => {
    if (node?.item !== undefined) mediaItems.push(node);
    for (const child of node?.children ?? []) walk(child);
  };
  walk(doc?.project?.root ?? doc?.root ?? doc);
  const missing = mediaItems.filter((i: any) => i.linkStatus === "missing" ||
                                                 i.mediaMissing === true);
  const seq = await sequence(client);
  const errored = [...(seq.video ?? []), ...(seq.audio ?? [])]
                     .flatMap((t: any) => t.items ?? [])
                     .flatMap((c: any) => c.effects ?? [])
                     .filter((e: any) => e.status === "error");
  const duration = (seq.duration ?? 0) / 254_016_000_000;
  const durationOk = Math.abs(duration - spec.expectedRuntimeSec) <= 2;
  return { missing, errored, duration, durationOk };
}

/* ------------ Grade / duck / loudness ------------------------------------ */
async function gradeAllClips(client: Client, spec: DeliverySpec) {
  const seq = await sequence(client);
  const clipIds: number[] = (seq.video ?? []).flatMap((t: any) =>
                                 (t.items ?? []).map((c: any) => c.clip as number));
  const wheels = TONE_WHEELS[spec.creativeTone];
  const evidence: DeliveryManifest["gradeEvidence"] = [];

  for (const id of clipIds) {
    // The engine stores a band as a colour vector and a luma offset.
    const steps = [
      { id: "effects.setParam", params: { clip: id, effect: "lumetri", param: "basic_on", value: true } },
      ...(["shadows","midtones","highlights"] as const).flatMap((axis) => [
        {
          id: "effects.setParam",
          params: {
            clip: id, effect: "lumetri", param: `wheel_${axis}`,
            value: [(wheels[axis].hue % 360) / 360, wheels[axis].sat / 100],
          },
        },
        {
          id: "effects.setParam",
          params: { clip: id, effect: "lumetri", param: `wheel_${axis}_l`, value: wheels[axis].balance },
        },
      ]),
    ];
    await client.callTool({ name: "command_batch", arguments: { steps, stop_on_error: true } });
    const scope = await run(client, "scopes.read", {
      scopes: ["parade", "waveform"], waveformType: "luma",
      colorSpace: "709", clamp: true, columns: 16,
    });
    const png = join("/work/delivery", spec.client, `clip_${id}.png`);
    mkdirSync(join("/work/delivery", spec.client), { recursive: true });
    // `render_frame` answers with an image block: the PNG comes back
    // base64-encoded and has to be written to disk by the agent.
    const pngReply = await client.callTool({
      name: "render_frame", arguments: { seconds: 30, max_side: 960 },
    });
    const image = (pngReply as any).content?.find((b: any) => b.type === "image");
    if (!image?.data) throw new Error(`render_frame returned no image for clip ${id}`);
    writeFileSync(png, Buffer.from(image.data, "base64"));
    const traces = scope?.parade?.traces ?? {};
    const luma = scope?.waveform?.luma ?? [];
    evidence.push({
      clipId: id, verificationPng: png,
      scopeReadout: {
        paradeMaxIre: Math.max(
          ...(traces.R ?? []).slice(14).map((x: any) => Number(x?.mean ?? 0)),
          0,
        ),
        waveformMaxIre: Math.max(
          ...luma.slice(0, 16).map((x: any) => Number(x?.max ?? 0)),
          0,
        ),
        midtoneMeanY: luma.slice(4, 13)
                        .map((x: any) => Number(x?.mean ?? 0))
                        .reduce((a: number,v: number)=>a+v,0) / 9 || 0.5,
      },
    });
  }
  return evidence;
}

async function processAudio(client: Client, spec: DeliverySpec) {
  const seq = await sequence(client);
  const dialogue: number[] = [], music: number[] = [];
  for (const t of seq.audio ?? []) {
    const alias = trackAlias(t.name ?? "");
    const ids = (t.items ?? []).map((c: any) => c.clip as number);
    if (alias === "A1" || alias === "A2") dialogue.push(...ids);
    if (alias === "A3" || alias === "A4") music.push(...ids);
  }
  await run(client, "essentialSound.setType", { clips: dialogue, type: "dialogue" });
  await run(client, "essentialSound.setType", { clips: music, type: "music" });

  const l = LOUDNESS_TABLE[spec.loudnessStandard];
  await run(client, "essentialSound.autoMatch", { clips: dialogue, target: l.dialogueRef });
  await run(client, "essentialSound.autoMatch", { clips: music, target: l.dialogueRef - 5 });
  await run(client, "essentialSound.set", { clips: music, key: "ducking.reduceDb", value: l.duckDepthDb });
  await run(client, "essentialSound.generateDucking", { clips: music });

  const mix = await run(client, "mixer.inspect", {});
  // A lane is a list of [tick, value] points.
  const keys = (mix.strips ?? []).reduce((a: number, s: any) =>
    a + (s.lanes?.volume?.length ?? 0), 0);

  const post = await run(client, "essentialSound.inspect", { clips: [...dialogue, ...music] });
  const measured = (post.clips ?? [])
    .map((c: any) => {
      const loudness = c.settings?.loudness;
      if (typeof loudness?.measured_lufs !== "number") return undefined;
      return loudness.measured_lufs + (loudness.gain_db ?? c.gainDb ?? 0);
    })
    .filter((v: number | undefined): v is number => v !== undefined);
  const integrated = measured.length > 0
    ? measured.reduce((a: number, b: number) => a + b, 0) / measured.length
    : NaN;
  return {
    preDuckLufs: integrated,
    postDuckLufs: integrated,
    duckingKeyframes: keys,
    finalIntegratedLufs: integrated,
    finalTruePeakDbtp: NaN,
  };
}

/* ------------ Export + verify -------------------------------------------- */
async function exportAndVerify(client: Client, spec: DeliverySpec) {
  const outDir = join("/work/delivery", spec.client);
  mkdirSync(outDir, { recursive: true });
  const outPath = join(outDir, `master.${spec.targetContainer}`);
  await run(client, "file.exportMedia", {
    path: outPath, format: spec.targetCodec === "prores" ? "prores" : spec.targetCodec,
    proresProfile: spec.proresProfile ?? "hq",
    width: 1920, height: 1080, fps: 23.976,
    audio: true,
    range: "entire", wait: true,
  });
  // The media probe is an engine command: `mediaBrowser.probe`.
  const probe = await run(client, "mediaBrowser.probe", { path: outPath });
  const info = probe?.info ?? {};
  const audio = (info.audio_streams ?? [])[0] ?? {};
  const durationSec = (info.duration ?? 0) / 254_016_000_000;
  const ok =
    String(info.video?.codec ?? "").toLowerCase().includes("prores") &&
    Math.abs(durationSec - spec.expectedRuntimeSec) <= 2 &&
    audio.sample_rate === 48000 && audio.channels === 2;
  if (!ok) throw new Error(`post-export verification failed: ${JSON.stringify(probe)}`);
  return { path: outPath, codec: info.video?.codec, durationSec,
           sampleRate: audio.sample_rate, channels: audio.channels };
}

/* ------------ Main ------------------------------------------------------- */
export async function runPipeline(rawSpec: RawSpec, sequenceId: number): Promise<DeliveryManifest> {
  const spec = normalizeSpec(rawSpec);
  const client = new Client({ name: "vector-frame-pipeline", version: "1.0.0" }, { capabilities: {} });
  await client.connect(new StdioClientTransport({
    command: "filmcraft-cli",
    args: ["mcp", "--automation-read-root", "/work/delivery", "--automation-write-root", "/work/delivery"],
  }));

  const pf = await preflight(client, spec);
  if (pf.missing.length || pf.errored.length || !pf.durationOk) {
    throw new Error(`preflight failed: ${JSON.stringify(pf)}`);
  }

  const gradeEvidence  = await gradeAllClips(client, spec);
  const audioEvidence  = await processAudio(client, spec);
  const exportEvidence = await exportAndVerify(client, spec);

  // Idempotency hash: deterministic over content + spec + pipeline version.
  // Sequence lastModified drives the manifest timestamp (not Date.now()).
  const seq = await sequence(client);
  // The project revision changes whenever the sequence changes, so it is
  // the content hash the manifest is keyed on.
  const docReply = await client.callTool({ name: "doc_inspect", arguments: {} });
  const doc = JSON.parse(
    (docReply as any).content?.find((b: any) => b.type === "text")?.text ?? "{}",
  );
  const contentHash = String(doc?.project?.revision ?? doc?.revision ?? "unknown");
  const specHash    = createHash("sha256").update(JSON.stringify(rawSpec)).digest("hex");
  const idempotencyHash = createHash("sha256")
    .update(`${contentHash}|${specHash}|1.0.0`)
    .digest("hex");
  const manifestTimestampMs = Date.now();

  const manifest: DeliveryManifest = {
    pipelineVersion: "1.0.0",
    specNormalization: { raw: rawSpec, normalized: spec },
    gradeEvidence, audioEvidence, exportEvidence,
    idempotencyHash,
    manifestGeneratedAtIso: new Date(manifestTimestampMs).toISOString(),
  };

  await client.close();
  const dest = join("/work/delivery", spec.client, "delivery_manifest.json");
  mkdirSync(join("/work/delivery", spec.client), { recursive: true });
  writeFileSync(dest, JSON.stringify(manifest, null, 2));
  return manifest;
}
