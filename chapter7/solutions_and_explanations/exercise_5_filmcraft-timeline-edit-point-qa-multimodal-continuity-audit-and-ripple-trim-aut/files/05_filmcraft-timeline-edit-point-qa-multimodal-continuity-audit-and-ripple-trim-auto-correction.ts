// 02_filmcraft-qa.ts
// ---------------------------------------------------------------------------
// Exercise 5 — FilmCraft timeline edit-point QA.
//
// The agent inspects the active sequence, renders the three frames that
// straddle every hard cut, asks a vision model one numeric question about the
// pair, and computes the audio discontinuity locally from the source media.
// Remediations are batched, guarded by a clip-table snapshot and a downstream
// raster comparison, and rolled back with one `edit.undo` per applied command.
// ---------------------------------------------------------------------------

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { PNG } from "pngjs";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// FilmCraft time base
// ---------------------------------------------------------------------------

export const TICKS_PER_SECOND = 254_016_000_000;
export const FPS = 24_000 / 1001;

export const ticksToSeconds = (ticks: number): number => ticks / TICKS_PER_SECOND;
export const secondsToTicks = (seconds: number): number => Math.round(seconds * TICKS_PER_SECOND);
export const framesToTicks = (frames: number): number => Math.round((frames / FPS) * TICKS_PER_SECOND);
export const ticksToFrames = (ticks: number): number => Math.round((ticks / TICKS_PER_SECOND) * FPS);

/** The frame that is on screen immediately before a cut. */
export const lastFrameTick = (cutTick: number): number => Math.max(0, cutTick - 1);

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

export interface EditPoint {
  /** The clip id of the outgoing clip. */
  clipA: number;
  /** The clip id of the incoming clip. */
  clipB: number;
  /** Sequence time of the cut, in FilmCraft ticks. */
  cutTick: number;
  /** Track label the cut lives on (e.g. "V1"). */
  track: string;
  /** Media in-point of clip B (needed to reason about source continuity). */
  clipBMediaInTick: number;
  /** Duration of clip B in ticks. */
  clipBDurationTick: number;
  /** Extra context used by the remediation solver. */
  clipAName: string;
  clipBName: string;
  clipADurationTick: number;
  trackIndex: number;
}

export interface JumpCutAssessment {
  /** True only when the model is confident the subject's silhouette shifted horizontally. */
  jump_detected: boolean;
  /** Horizontal shift of the subject's head as a fraction of frame width, [0, 1]. */
  horizontal_shift_fraction: number;
  /** Direction of the shift. */
  shift_direction: "left" | "right" | "none";
  /**
   * True when the model is reporting a numeric claim it actually derived from
   * measuring the frames; false when it is guessing. Agents must treat false
   * as a signal to re-prompt or escalate, NEVER as a low-but-usable confidence.
   */
  is_numeric_claim: boolean;
  /** Confidence in the assessment, [0, 1]. */
  confidence: number;
  /** Human-readable note, max 50 tokens. */
  note: string;
}

export interface LuminanceContinuityAssessment {
  luminance_delta_pct: number; // signed; negative means B is darker
  is_numeric_claim: boolean;
  confidence: number;
  note: string;
}

export interface AudioDiscontinuity {
  tick: number;
  /** Instantaneous amplitude delta in dBFS (always ≥ 0). */
  delta_dbfs: number;
  /** Whether the delta survives the psychoacoustic "pop" threshold. */
  is_pop: boolean;
}

export type Remediation =
  | { kind: "ripple_trim_a_out"; frames: number; rationale: string }
  | { kind: "crossfade"; frames: number; rationale: string }
  | { kind: "exposure_ramp"; durationSeconds: number; rationale: string }
  | { kind: "none"; rationale: string };

export interface RemediationPlan {
  remediations: Remediation[];
  /** Total number of clips touched — used for the > 2 escalation rule. */
  clipsTouched: number;
  /** Total frames trimmed across all remediations — used for the > 18 rule. */
  framesTrimmed: number;
  requiresHumanReview: boolean;
  reviewReason: string | null;
}

export interface SequenceSnapshot {
  sequenceId: number;
  clips: { id: number; track: string; startTick: number; durationTick: number; mediaInTick: number }[];
  downstreamRasterPath: string | null;
}

export interface RollbackVerdict {
  rolledBack: boolean;
  undoDepth: number;
  ssdDownstream: number;
  restoredExactly: boolean;
}

export interface EditPointAudit {
  editPoint: EditPoint;
  jumpCut: JumpCutAssessment | null;
  luminance: LuminanceContinuityAssessment | null;
  audio: AudioDiscontinuity | null;
  remediation: RemediationPlan | null;
  /** Set when the vision model refused to make a numeric claim twice. */
  unverifiable: boolean;
  /** Set when the remediation batch ran. */
  applied: boolean;
  rollback: RollbackVerdict | null;
  error: string | null;
}

// ---------------------------------------------------------------------------
// Sequence model
// ---------------------------------------------------------------------------

export interface TrackClip {
  id: number;
  itemId: number;
  name: string;
  track: string;
  trackIndex: number;
  startTick: number;
  durationTick: number;
  mediaInTick: number;
  mediaOutTick: number;
}

export interface Track {
  id: number;
  label: string;
  kind: "video" | "audio";
  clips: TrackClip[];
  transitions: any[];
}

export interface SequenceView {
  id: number;
  name: string;
  fps: number;
  width: number;
  height: number;
  tracks: Track[];
  raw: any;
}

export function normaliseSequence(raw: any): SequenceView {
  const tracks: Track[] = [];
  const read = (kind: "video" | "audio", list: any[] | undefined, prefix: string) => {
    for (const [index, track] of (list ?? []).entries()) {
      tracks.push({
        id: track.id,
        label: `${prefix}${index + 1}`,
        kind,
        transitions: track.transitions ?? [],
        clips: (track.items ?? []).map((item: any) => ({
          id: item.clip,
          itemId: item.item,
          name: item.name,
          track: `${prefix}${index + 1}`,
          trackIndex: index,
          startTick: Number(item.start ?? 0),
          durationTick: Number(item.duration ?? 0),
          mediaInTick: Number(item.sourceIn ?? 0),
          mediaOutTick: Number(item.sourceOut ?? Number(item.sourceIn ?? 0) + Number(item.duration ?? 0)),
        })),
      });
    }
  };
  read("video", raw.video, "V");
  read("audio", raw.audio, "A");

  const settings = raw.settings ?? {};
  return {
    id: Number(raw.id),
    name: String(raw.name ?? ""),
    fps: settings.frame_rate ? settings.frame_rate.num / settings.frame_rate.den : FPS,
    width: Number(settings.width ?? 0),
    height: Number(settings.height ?? 0),
    tracks,
    raw,
  };
}

/**
 * A hard cut exists when the outgoing clip's end tick equals the incoming
 * clip's start tick. Gaps are not cuts; they are missing footage and belong to
 * a different QA pass.
 */
export function extractEditPoints(view: SequenceView, trackLabel = "V1"): EditPoint[] {
  const track = view.tracks.find((t) => t.kind === "video" && t.label === trackLabel);
  if (!track) return [];
  const sorted = [...track.clips].sort((a, b) => a.startTick - b.startTick);
  const points: EditPoint[] = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (a.startTick + a.durationTick !== b.startTick) continue;
    points.push({
      clipA: a.id,
      clipB: b.id,
      cutTick: a.startTick + a.durationTick,
      track: track.label,
      clipBMediaInTick: b.mediaInTick,
      clipBDurationTick: b.durationTick,
      clipAName: a.name,
      clipBName: b.name,
      clipADurationTick: a.durationTick,
      trackIndex: track.id,
    });
  }
  return points;
}

/** The audio clip that carries the cut, used by audio transitions. */
export function audioClipAtCut(view: SequenceView, cutTick: number): TrackClip | null {
  const clips = view.tracks
    .filter((track) => track.kind === "audio")
    .flatMap((track) => track.clips);
  return (
    clips.find((clip) => clip.startTick === cutTick) ??
    clips.find((clip) => clip.startTick < cutTick && clip.startTick + clip.durationTick > cutTick) ??
    null
  );
}

// ---------------------------------------------------------------------------
// MCP session
// ---------------------------------------------------------------------------

export interface FilmcraftSessionOptions {
  /** Extra arguments passed to `filmcraft-cli`, e.g. `--project edit.fcproj`. */
  args?: string[];
  command?: string;
}

export class FilmcraftSession {
  private readonly client = new Client({ name: "filmcraft-qa", version: "1.0.0" }, { capabilities: {} });
  private connected = false;
  private readonly options: FilmcraftSessionOptions;

  constructor(options: FilmcraftSessionOptions = {}) {
    this.options = options;
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(
      new StdioClientTransport({
        command: this.options.command ?? "filmcraft-cli",
        args: this.options.args ?? ["mcp"],
        stderr: "pipe",
      }),
    );
    this.connected = true;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.client.close();
  }

  /** Import absolute paths through the MCP media tool. */
  async importMedia(paths: string[]): Promise<{ items: number[]; errors: string[] }> {
    const text = await this.text("media_import", { text: paths.join("\n") });
    return JSON.parse(text);
  }

  async inspectSequence(): Promise<SequenceView> {
    const text = await this.text("sequence_inspect", {});
    return normaliseSequence(JSON.parse(text));
  }

  async command<T = any>(id: string, params: Record<string, unknown> = {}): Promise<T> {
    const text = await this.text("command_run", { id, params });
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  async batch(steps: { id: string; params?: Record<string, unknown> }[]): Promise<{
    completed: number;
    failed: number;
    results: { ok: boolean; result?: any; error?: string }[];
  }> {
    const text = await this.text("command_batch", { steps, stop_on_error: true });
    return JSON.parse(text);
  }

  /** Raster frame at `seconds`, long edge capped at `maxSide`. */
  async renderFrame(seconds: number, maxSide = 640): Promise<{ png: string; width: number; height: number }> {
    const result: any = await this.client.callTool({
      name: "render_frame",
      arguments: { seconds, max_side: maxSide },
    });
    const image = result.content?.find((block: any) => block.type === "image");
    if (!image?.data) throw new Error(`FilmCraft returned no frame at ${seconds.toFixed(3)}s`);
    const decoded = PNG.sync.read(Buffer.from(image.data, "base64"));
    return { png: image.data, width: decoded.width, height: decoded.height };
  }

  async renderPreview(seconds: number, maxSide = 640): Promise<{ png: string; width: number; height: number }> {
    const result: any = await this.client.callTool({
      name: "render_preview",
      arguments: { seconds, max_side: maxSide },
    });
    const image = result.content?.find((block: any) => block.type === "image");
    if (!image?.data) throw new Error(`FilmCraft returned no preview at ${seconds.toFixed(3)}s`);
    const decoded = PNG.sync.read(Buffer.from(image.data, "base64"));
    return { png: image.data, width: decoded.width, height: decoded.height };
  }

  private async text(name: string, args: Record<string, unknown>): Promise<string> {
    const result: any = await this.client.callTool({ name, arguments: args });
    if (result.isError) {
      const message = result.content?.find((block: any) => block.type === "text")?.text ?? "unknown error";
      throw new Error(message);
    }
    return result.content?.find((block: any) => block.type === "text")?.text ?? "";
  }
}

// ---------------------------------------------------------------------------
// Local audio analysis
// ---------------------------------------------------------------------------

const AUDIO_SAMPLE_RATE = 48_000;

async function decodePcm(path: string, startSeconds: number, durationSeconds: number): Promise<Float32Array> {
  const { stdout } = await execFileAsync(
    "ffmpeg",
    [
      "-v", "error",
      "-ss", startSeconds.toFixed(6),
      "-t", durationSeconds.toFixed(6),
      "-i", path,
      "-ac", "1",
      "-ar", String(AUDIO_SAMPLE_RATE),
      "-f", "f32le",
      "pipe:1",
    ],
    { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 },
  );
  const buffer = stdout as Buffer;
  return new Float32Array(buffer.buffer, buffer.byteOffset, Math.floor(buffer.byteLength / 4));
}

function maxAdjacentDelta(samples: Float32Array): number {
  let max = 0;
  for (let i = 1; i < samples.length; i += 1) {
    max = Math.max(max, Math.abs(samples[i] - samples[i - 1]));
  }
  return max;
}

/**
 * Measure the program audio either side of a cut.
 *
 * A pop is an instantaneous sample discontinuity, so it needs sample-domain
 * math, not a vision model and not an FFT of the whole programme. We decode a
 * 30 ms window per audio clip that overlaps the cut, then measure both the
 * inside-window sample deltas and the boundary delta between the outgoing and
 * incoming segments. The result is the worst of those, in dBFS.
 */
export async function analyzeEditPointAudio(
  view: SequenceView,
  cutTick: number,
  resolveMedia: (clip: TrackClip) => string | null,
): Promise<AudioDiscontinuity | null> {
  const halfWindow = secondsToTicks(0.03);
  const from = cutTick - halfWindow;
  const to = cutTick + halfWindow;

  const segments: { startTick: number; endTick: number; samples: Float32Array }[] = [];
  for (const track of view.tracks.filter((t) => t.kind === "audio")) {
    for (const clip of track.clips) {
      const clipStart = clip.startTick;
      const clipEnd = clip.startTick + clip.durationTick;
      if (clipEnd <= from || clipStart >= to) continue;
      const media = resolveMedia(clip);
      if (!media) continue;
      const overlapStart = Math.max(clipStart, from);
      const overlapEnd = Math.min(clipEnd, to);
      const sourceSecond = ticksToSeconds(clip.mediaInTick + (overlapStart - clipStart));
      const duration = ticksToSeconds(overlapEnd - overlapStart);
      if (duration <= 0) continue;
      const samples = await decodePcm(media, sourceSecond, duration);
      if (samples.length === 0) continue;
      segments.push({ startTick: overlapStart, endTick: overlapEnd, samples });
    }
  }
  if (segments.length === 0) return null;

  segments.sort((a, b) => a.startTick - b.startTick);
  let worst = 0;
  for (const segment of segments) worst = Math.max(worst, maxAdjacentDelta(segment.samples));

  // A cut between two separate audio clips shows up only across the boundary.
  for (let i = 1; i < segments.length; i += 1) {
    const previous = segments[i - 1];
    const next = segments[i];
    if (Math.abs(previous.endTick - next.startTick) > 1) continue;
    const boundary = Math.abs(next.samples[0] - previous.samples[previous.samples.length - 1]);
    worst = Math.max(worst, boundary);
  }

  const deltaDbfs = 20 * Math.log10(Math.max(worst, 1e-7));
  return {
    tick: cutTick,
    delta_dbfs: Math.abs(deltaDbfs),
    is_pop: deltaDbfs > -24,
  };
}

// ---------------------------------------------------------------------------
// Vision
// ---------------------------------------------------------------------------

export interface RenderedFrame {
  png: string;
  width: number;
  height: number;
}

export interface VisionRequest {
  prior: RenderedFrame;
  aEnd: RenderedFrame;
  bStart: RenderedFrame;
  cutSeconds: number;
  /** Second attempt: the prompt must demand a measured number. */
  strictNumeric: boolean;
}

export interface VisionResult {
  jump: JumpCutAssessment;
  luminance: LuminanceContinuityAssessment;
}

export interface VisionClient {
  assess(request: VisionRequest): Promise<VisionResult>;
}

const jumpSchema = {
  type: "object",
  additionalProperties: false,
  required: ["jump_detected", "horizontal_shift_fraction", "shift_direction", "is_numeric_claim", "confidence", "note"],
  properties: {
    jump_detected: { type: "boolean" },
    horizontal_shift_fraction: { type: "number", minimum: 0, maximum: 1 },
    shift_direction: { type: "string", enum: ["left", "right", "none"] },
    is_numeric_claim: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    note: { type: "string", maxLength: 400 },
  },
} as const;

const luminanceSchema = {
  type: "object",
  additionalProperties: false,
  required: ["luminance_delta_pct", "is_numeric_claim", "confidence", "note"],
  properties: {
    luminance_delta_pct: { type: "number", minimum: -100, maximum: 100 },
    is_numeric_claim: { type: "boolean" },
    confidence: { type: "number", minimum: 0, maximum: 1 },
    note: { type: "string", maxLength: 400 },
  },
} as const;

export const VISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["jump", "luminance"],
  properties: {
    jump: jumpSchema,
    luminance: luminanceSchema,
  },
} as const;

/**
 * The exact JSON schema string handed to `response_format`. `strict: true` plus
 * `additionalProperties: false` is what makes the numeric fields mandatory
 * instead of optional prose.
 */
export const VISION_RESPONSE_FORMAT = {
  type: "json_schema",
  json_schema: {
    name: "edit_point_continuity",
    strict: true,
    schema: VISION_SCHEMA,
  },
} as const;

export interface OpenAiVisionOptions {
  model?: string;
  apiKey?: string;
}

export function createOpenAiVision(options: OpenAiVisionOptions = {}): VisionClient {
  return {
    async assess(request) {
      // Imported lazily so the rest of the module (and its unit tests) does not
      // need an API key or a network connection.
      const { OpenAI } = await import("openai");
      const client = new OpenAI({ apiKey: options.apiKey });
      const prompt = [
        "Image 1 is the frame 0.5 s before the cut (context).",
        "Image 2 is the last frame of the outgoing clip A.",
        "Image 3 is the first frame of the incoming clip B.",
        "Measure the horizontal position of the subject's head silhouette in image 2 and image 3.",
        "Return horizontal_shift_fraction as the signed distance between those centres as a fraction of the frame width (0..1).",
        "Return shift_direction as left when the head moves left, right when it moves right, none when it does not move.",
        "Return jump_detected=true only when the shift exceeds 0.08.",
        "Measure mean L* of image 2 and image 3 and return (L*_B - L*_A) / L*_A * 100 as luminance_delta_pct.",
        request.strictNumeric
          ? "You MUST derive both numbers from the pixels. If you cannot measure them, return is_numeric_claim=false and explain why; do not estimate."
          : "Report only what you measured; set is_numeric_claim=false when the answer is an estimate.",
      ].join(" ");

      const response = await client.chat.completions.create({
        model: options.model ?? "gpt-4o",
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: prompt },
              { type: "image_url", image_url: { url: `data:image/png;base64,${request.prior.png}` } },
              { type: "image_url", image_url: { url: `data:image/png;base64,${request.aEnd.png}` } },
              { type: "image_url", image_url: { url: `data:image/png;base64,${request.bStart.png}` } },
            ],
          },
        ],
        response_format: VISION_RESPONSE_FORMAT as any,
      });
      const content = response.choices[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(content) as VisionResult;
      return { jump: parsed.jump, luminance: parsed.luminance };
    },
  };
}

export interface AssessmentOutcome {
  jump: JumpCutAssessment;
  luminance: LuminanceContinuityAssessment;
  unverifiable: boolean;
  attempts: number;
}

/**
 * Ask once, and re-ask once with a stricter instruction when the model refuses
 * to make a numeric claim. A second refusal marks the edit point unverifiable;
 * it is never downgraded to "low confidence" and never remediated.
 */
export async function assessEditPoint(
  vision: VisionClient,
  frames: { prior: RenderedFrame; aEnd: RenderedFrame; bStart: RenderedFrame },
  cutSeconds: number,
): Promise<AssessmentOutcome> {
  let attempt = await vision.assess({ ...frames, cutSeconds, strictNumeric: false });
  if (attempt.jump.is_numeric_claim && attempt.luminance.is_numeric_claim) {
    return { jump: attempt.jump, luminance: attempt.luminance, unverifiable: false, attempts: 1 };
  }

  attempt = await vision.assess({ ...frames, cutSeconds, strictNumeric: true });
  const unverifiable = !attempt.jump.is_numeric_claim || !attempt.luminance.is_numeric_claim;
  return { jump: attempt.jump, luminance: attempt.luminance, unverifiable, attempts: 2 };
}

// ---------------------------------------------------------------------------
// Remediation solver
// ---------------------------------------------------------------------------

export const THRESHOLDS = {
  jumpFraction: 0.08,
  luminancePct: 12,
  popDbfs: -24,
  minTrimFrames: 4,
  maxTrimFrames: 12,
  humanFrames: 18,
  humanClips: 2,
  crossfadeFrames: 3,
  rampSeconds: 1,
} as const;

export function planRemediation(
  audit: Omit<EditPointAudit, "remediation">,
  availableOutFrames: number,
): RemediationPlan {
  const plans: Remediation[] = [];
  let clipsTouched = 0;
  let framesTrimmed = 0;
  const reasons: string[] = [];

  const jump = audit.jumpCut;
  if (jump?.jump_detected && jump.is_numeric_claim && jump.horizontal_shift_fraction > THRESHOLDS.jumpFraction) {
    const wanted = Math.max(
      THRESHOLDS.minTrimFrames,
      Math.min(THRESHOLDS.maxTrimFrames, Math.ceil(jump.horizontal_shift_fraction * 100)),
    );
    if (wanted > availableOutFrames) {
      reasons.push(`needs ${wanted} frames but clip A only exposes ${availableOutFrames}`);
    } else {
      plans.push({
        kind: "ripple_trim_a_out",
        frames: wanted,
        rationale: `Jump cut: head moved ${(jump.horizontal_shift_fraction * 100).toFixed(1)}% of the frame width.`,
      });
      clipsTouched += 2;
      framesTrimmed += wanted;
    }
  }

  if (audit.audio?.is_pop) {
    plans.push({
      kind: "crossfade",
      frames: THRESHOLDS.crossfadeFrames,
      rationale: `Audio discontinuity ${audit.audio.delta_dbfs.toFixed(1)} dBFS is louder than -24 dBFS.`,
    });
    clipsTouched += 2;
  }

  if (audit.luminance && Math.abs(audit.luminance.luminance_delta_pct) > THRESHOLDS.luminancePct) {
    plans.push({
      kind: "exposure_ramp",
      durationSeconds: THRESHOLDS.rampSeconds,
      rationale: `Luminance delta ${audit.luminance.luminance_delta_pct.toFixed(1)}% exceeds 12%.`,
    });
    clipsTouched += 1;
  }

  if (clipsTouched > THRESHOLDS.humanClips) reasons.push(`touches ${clipsTouched} clips in one batch (limit 2)`);
  if (framesTrimmed > THRESHOLDS.humanFrames) reasons.push(`${framesTrimmed} frames trimmed (limit 18)`);

  if (plans.length === 0) {
    plans.push({
      kind: "none",
      rationale: reasons.length > 0 ? `Escalated: ${reasons.join("; ")}.` : "No threshold crossed.",
    });
  }

  return {
    remediations: plans,
    clipsTouched,
    framesTrimmed,
    requiresHumanReview: reasons.length > 0,
    reviewReason: reasons.length > 0 ? reasons.join("; ") : null,
  };
}

// ---------------------------------------------------------------------------
// Remediation commands
// ---------------------------------------------------------------------------

export interface CommandStep {
  id: string;
  params: Record<string, unknown>;
}

export function buildRemediationCommands(
  plan: RemediationPlan,
  editPoint: EditPoint,
  luminanceDeltaPct = 0,
  audioClipId?: number,
): CommandStep[] {
  const steps: CommandStep[] = [];
  for (const remediation of plan.remediations) {
    switch (remediation.kind) {
      case "ripple_trim_a_out":
        steps.push({ id: "trim.selectEditPoint", params: { clip: editPoint.clipA, edge: "out", kind: "ripple" } });
        steps.push({
          id: "timeline.trim",
          params: { clip: editPoint.clipA, edge: "out", mode: "ripple", deltaFrames: -remediation.frames },
        });
        break;
      case "crossfade":
        steps.push({
          id: "sequence.applyAudioTransition",
          params: { clip: audioClipId ?? editPoint.clipB, effect: "constant_power", frames: remediation.frames },
        });
        break;
      case "exposure_ramp": {
        // A one-second lift from the measured mismatch back to zero. The
        // exposure slider is in stops; 3 stops per 100% L* keeps the ramp
        // proportional without over-correcting midtones.
        const start = Math.max(-2, Math.min(2, -(luminanceDeltaPct / 100) * 3));
        steps.push({ id: "effects.apply", params: { clips: [editPoint.clipB], effect: "lumetri" } });
        steps.push({
          id: "effects.toggleAnimation",
          params: { clip: editPoint.clipB, effect: "lumetri", param: "exposure" },
        });
        steps.push({
          id: "effects.setParam",
          params: { clip: editPoint.clipB, effect: "lumetri", param: "exposure", value: start, time: editPoint.cutTick },
        });
        steps.push({
          id: "effects.setParam",
          params: {
            clip: editPoint.clipB,
            effect: "lumetri",
            param: "exposure",
            value: 0,
            time: editPoint.cutTick + secondsToTicks(remediation.durationSeconds),
          },
        });
        break;
      }
      case "none":
        break;
    }
  }
  return steps;
}

// ---------------------------------------------------------------------------
// Raster comparison
// ---------------------------------------------------------------------------

/** Mean absolute per-channel difference, normalised to 0..1. */
export function ssdBetweenPngs(a: string, b: string): number {
  const left = PNG.sync.read(Buffer.from(a, "base64"));
  const right = PNG.sync.read(Buffer.from(b, "base64"));
  if (left.width !== right.width || left.height !== right.height) return 1;
  let total = 0;
  let count = 0;
  for (let i = 0; i < left.data.length; i += 4) {
    total += Math.abs(left.data[i] - right.data[i]);
    total += Math.abs(left.data[i + 1] - right.data[i + 1]);
    total += Math.abs(left.data[i + 2] - right.data[i + 2]);
    count += 3;
  }
  return total / count / 255;
}

function flattenClips(view: SequenceView): SequenceSnapshot["clips"] {
  return view.tracks.flatMap((track) =>
    track.clips.map((clip) => ({
      id: clip.id,
      track: track.label,
      startTick: clip.startTick,
      durationTick: clip.durationTick,
      mediaInTick: clip.mediaInTick,
    })),
  );
}

export function clipsEqual(a: SequenceSnapshot["clips"], b: SequenceSnapshot["clips"]): boolean {
  if (a.length !== b.length) return false;
  const sort = (clips: typeof a) => [...clips].sort((left, right) => left.id - right.id);
  const [left, right] = [sort(a), sort(b)];
  return left.every((clip, index) => {
    const other = right[index];
    return (
      clip.id === other.id &&
      clip.track === other.track &&
      clip.startTick === other.startTick &&
      clip.durationTick === other.durationTick &&
      clip.mediaInTick === other.mediaInTick
    );
  });
}

// ---------------------------------------------------------------------------
// Guarded batch
// ---------------------------------------------------------------------------

export interface GuardOptions {
  track: string;
  /** Index of the downstream cut in the same track's cut list. */
  downstreamCutIndex: number | null;
  /** Used when there is no downstream cut. */
  fallbackDownstreamTick: number;
  threshold?: number;
  maxSide?: number;
}

export interface GuardedBatchResult {
  rollback: RollbackVerdict;
  batch: { completed: number; failed: number; results: { ok: boolean; result?: any; error?: string }[] };
  error: string | null;
}

/**
 * Apply a batch and verify that the downstream cut still shows the same image.
 *
 * Ripple trims move the downstream cut, so the comparison frame is re-derived
 * from the post-batch sequence rather than sampled at a fixed timeline tick.
 * That distinction is what stops every legitimate ripple trim from looking like
 * cascade damage.
 */
export async function applyGuardedBatch(
  session: FilmcraftSession,
  steps: CommandStep[],
  options: GuardOptions,
): Promise<GuardedBatchResult> {
  const beforeView = await session.inspectSequence();
  const beforeClips = flattenClips(beforeView);
  const beforeCuts = extractEditPoints(beforeView, options.track);
  const beforeTick =
    options.downstreamCutIndex !== null && beforeCuts[options.downstreamCutIndex]
      ? beforeCuts[options.downstreamCutIndex].cutTick
      : options.fallbackDownstreamTick;
  const beforeFrame = await session.renderPreview(ticksToSeconds(beforeTick) + 1 / FPS, options.maxSide ?? 640);

  const batch = await session.batch(steps);
  if (batch.failed > 0) {
    let undone = 0;
    for (let i = 0; i < batch.completed; i += 1) {
      try {
        await session.command("edit.undo", {});
        undone += 1;
      } catch {
        break;
      }
    }
    const now = await session.inspectSequence();
    return {
      batch,
      error: batch.results.find((result) => !result.ok)?.error ?? "batch failed",
      rollback: {
        rolledBack: undone > 0,
        undoDepth: undone,
        ssdDownstream: 1,
        restoredExactly: clipsEqual(beforeClips, flattenClips(now)),
      },
    };
  }

  const afterView = await session.inspectSequence();
  const afterCuts = extractEditPoints(afterView, options.track);
  const afterTick =
    options.downstreamCutIndex !== null && afterCuts[options.downstreamCutIndex]
      ? afterCuts[options.downstreamCutIndex].cutTick
      : beforeTick;
  const afterFrame = await session.renderPreview(ticksToSeconds(afterTick) + 1 / FPS, options.maxSide ?? 640);

  const ssdDownstream = ssdBetweenPngs(beforeFrame.png, afterFrame.png);
  if (ssdDownstream <= (options.threshold ?? 0.08)) {
    return {
      batch,
      error: null,
      rollback: { rolledBack: false, undoDepth: 0, ssdDownstream, restoredExactly: true },
    };
  }

  let undone = 0;
  for (let i = 0; i < batch.completed; i += 1) {
    try {
      await session.command("edit.undo", {});
      undone += 1;
    } catch {
      break;
    }
  }
  const restored = await session.inspectSequence();
  const restoredClips = flattenClips(restored);
  return {
    batch,
    error: null,
    rollback: {
      rolledBack: true,
      undoDepth: undone,
      ssdDownstream,
      restoredExactly: clipsEqual(beforeClips, restoredClips),
    },
  };
}

// ---------------------------------------------------------------------------
// Audit loop
// ---------------------------------------------------------------------------

export interface QaOptions {
  track?: string;
  vision: VisionClient;
  mediaRoot?: string;
  resolveMedia?: (clip: TrackClip) => string | null;
  outputDir?: string;
  maxSide?: number;
  autoApply?: boolean;
  apply?: boolean;
  log?: (message: string) => void;
}

export interface QaReport {
  sequence: { id: number; name: string; fps: number; width: number; height: number; tracks: string[] };
  editPoints: EditPointAudit[];
  summary: {
    cuts: number;
    jumpCuts: number;
    pops: number;
    luminanceJumps: number;
    remediated: number;
    rolledBack: number;
    escalated: number;
    unverifiable: number;
  };
}

export async function runFilmcraftQA(session: FilmcraftSession, options: QaOptions): Promise<QaReport> {
  const track = options.track ?? "V1";
  const maxSide = options.maxSide ?? 640;
  const log = options.log ?? (() => {});
  if (options.outputDir) mkdirSync(options.outputDir, { recursive: true });

  let view = await session.inspectSequence();
  let editPoints = extractEditPoints(view, track);
  const resolveMedia =
    options.resolveMedia ??
    ((clip: TrackClip) => (options.mediaRoot ? join(options.mediaRoot, clip.name) : null));

  const audits: EditPointAudit[] = [];

  for (let index = 0; index < editPoints.length; index += 1) {
    // A ripple trim moves every downstream cut. Re-read the sequence after each
    // applied batch so the next edit point is audited where it now lives.
    const editPoint = editPoints[index];
    log(`cut ${index + 1}/${editPoints.length} at ${ticksToSeconds(editPoint.cutTick).toFixed(2)}s`);

    const cutSeconds = ticksToSeconds(editPoint.cutTick);
    const [prior, aEnd, bStart] = await Promise.all([
      session.renderFrame(ticksToSeconds(Math.max(0, lastFrameTick(editPoint.cutTick) - secondsToTicks(0.5))), maxSide),
      session.renderFrame(ticksToSeconds(lastFrameTick(editPoint.cutTick)), maxSide),
      // FilmCraft resolves the exact cut tick to the outgoing clip, so the
      // first reachable frame of B is one frame after the cut.
      session.renderFrame(cutSeconds + 1 / (view.fps || FPS), maxSide),
    ]);

    if (options.outputDir) {
      writeFileSync(join(options.outputDir, `cut-${index + 1}-prior.png`), Buffer.from(prior.png, "base64"));
      writeFileSync(join(options.outputDir, `cut-${index + 1}-a-end.png`), Buffer.from(aEnd.png, "base64"));
      writeFileSync(join(options.outputDir, `cut-${index + 1}-b-start.png`), Buffer.from(bStart.png, "base64"));
    }

    const vision = await assessEditPoint(options.vision, { prior, aEnd, bStart }, cutSeconds);
    const audio = await analyzeEditPointAudio(view, editPoint.cutTick, resolveMedia).catch(() => null);

    const partial: Omit<EditPointAudit, "remediation"> = {
      editPoint,
      jumpCut: vision.jump,
      luminance: vision.luminance,
      audio,
      unverifiable: vision.unverifiable,
      applied: false,
      rollback: null,
      error: null,
    };

    const availableOutFrames = Math.max(0, ticksToFrames(editPoint.clipADurationTick) - 1);
    const plan = planRemediation(partial, availableOutFrames);
    const audit: EditPointAudit = { ...partial, remediation: plan };

    if (vision.unverifiable) {
      audit.remediation = {
        ...plan,
        remediations: [{ kind: "none", rationale: "Unverifiable: the vision model did not make a numeric claim twice." }],
        requiresHumanReview: true,
        reviewReason: "unverifiable vision claim",
      };
      audits.push(audit);
      continue;
    }

    if (plan.requiresHumanReview) {
      log(`cut ${index + 1}: escalated — ${plan.reviewReason}`);
      audits.push(audit);
      continue;
    }

    const audioClip = audioClipAtCut(view, editPoint.cutTick);
    const steps = buildRemediationCommands(
      plan,
      editPoint,
      vision.luminance.luminance_delta_pct,
      audioClip?.id,
    );
    if (steps.length === 0 || options.apply === false) {
      audits.push(audit);
      continue;
    }

    // The engine applies transitions to the edit point under the playhead, so
    // park the playhead on the cut and target the audio track first.
    if (plan.remediations.some((remediation) => remediation.kind === "crossfade")) {
      await session.command("playhead.set", { time: editPoint.cutTick });
      await session.command("timeline.setTargeting", { track: audioClip?.track ?? "A1", targeted: true });
    }

    const result = await applyGuardedBatch(session, steps, {
      track,
      downstreamCutIndex: index + 1 < editPoints.length ? index + 1 : null,
      fallbackDownstreamTick: editPoint.cutTick + secondsToTicks(2),
      maxSide,
    });

    audit.applied = result.error === null && !result.rollback.rolledBack;
    audit.rollback = result.rollback;
    audit.error = result.error;
    if (result.rollback.rolledBack) {
      log(`cut ${index + 1}: rolled back after SSD ${result.rollback.ssdDownstream.toFixed(3)}`);
      audit.remediation = {
        ...plan,
        requiresHumanReview: true,
        reviewReason: `downstream changed by ${result.rollback.ssdDownstream.toFixed(3)} SSD; batch rolled back`,
      };
    }
    audits.push(audit);

    if (audit.applied) {
      view = await session.inspectSequence();
      const refreshed = extractEditPoints(view, track);
      if (refreshed.length === editPoints.length) editPoints = refreshed;
    }
  }

  const summary = {
    cuts: audits.length,
    jumpCuts: audits.filter((audit) => audit.jumpCut?.jump_detected).length,
    pops: audits.filter((audit) => audit.audio?.is_pop).length,
    luminanceJumps: audits.filter((audit) => Math.abs(audit.luminance?.luminance_delta_pct ?? 0) > THRESHOLDS.luminancePct).length,
    remediated: audits.filter((audit) => audit.applied).length,
    rolledBack: audits.filter((audit) => audit.rollback?.rolledBack).length,
    escalated: audits.filter((audit) => audit.remediation?.requiresHumanReview).length,
    unverifiable: audits.filter((audit) => audit.unverifiable).length,
  };

  return {
    sequence: {
      id: view.id,
      name: view.name,
      fps: view.fps,
      width: view.width,
      height: view.height,
      tracks: view.tracks.map((track) => track.label),
    },
    editPoints: audits,
    summary,
  };
}


