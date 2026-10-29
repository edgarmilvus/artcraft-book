/**
 * src/assembly/agentic-assembly.ts
 * ---------------------------------------------------------------------------
 * CutRoom — Autonomous Video Assembly Worker.
 *
 * Drives a per-tenant `filmcraft-cli mcp` process over stdio using the
 * official Model Context Protocol TypeScript SDK. Every timeline mutation is
 * expressed as an engine command dispatched through the official meta-tool
 * `command_run`, or as a group of them through `command_batch`.
 *
 * Design invariants:
 *   1. NO raw filesystem mutation of media. All reads/writes go through the
 *      server's `--automation-read-root` / `--automation-write-root` sandbox.
 *   2. NO partial commits. Every phase is bracketed by `CheckpointGuard`,
 *      which rolls back by replaying `edit.undo` until the history depth
 *      returns to the pre-phase high-water mark.
 *   3. NO unvalidated geometry. The B-roll cut plan is emitted by a pure
 *      function and its constraint satisfaction is asserted *before* a single
 *      clip is placed.
 *   4. NO silent failure. Every tool result whose JSON body lacks the expected
 *      keys throws `FilmCraftProtocolError` with the raw payload attached.
 * ---------------------------------------------------------------------------
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, basename, extname, resolve } from "node:path";

/* ===========================================================================
 * SECTION 0 — Timebase primitives
 * ---------------------------------------------------------------------------
 * FilmCraft's internal timebase is 254,016,000,000 ticks per second. This is
 * not an arbitrary number: 254_016_000_000 = 2^7 · 3^6 · 5^3 · 7^3 · 11^2 · 13
 * which makes it exactly divisible by every common broadcast frame rate
 * (23.976, 24, 25, 29.97, 30, 47.952, 48, 50, 59.94, 60) and by 48 kHz and
 * 44.1 kHz audio sample rates. That divisibility is why razor points can land
 * on a frame boundary *and* a sample boundary simultaneously, with zero
 * accumulated drift across a two-hour timeline.
 *
 * JavaScript's Number is safe to 2^53 − 1 ≈ 9.007e15, i.e. ~35 hours of
 * timeline. Beyond that the worker refuses to run and asks for a chunked job.
 * ======================================================================== */

/** Ticks per second in the FilmCraft engine timebase. */
export const TICKS_PER_SECOND = 254_016_000_000;

/** Largest timeline the worker will accept, in seconds (~34.5 h). */
export const MAX_TIMELINE_SECONDS = 124_000;

/** Convert seconds → engine ticks (rounded to the nearest tick). */
export const secToTicks = (s: number): number => Math.round(s * TICKS_PER_SECOND);

/** Convert engine ticks → seconds. */
export const ticksToSec = (t: number): number => t / TICKS_PER_SECOND;

/** Convert a frame index at `fps` → engine ticks. */
export const framesToTicks = (f: number, fps: number): number =>
  Math.round((f / fps) * TICKS_PER_SECOND);

/** Convert a duration in frames at `fps` → seconds. */
export const framesToSec = (f: number, fps: number): number => f / fps;

/* ===========================================================================
 * SECTION 1 — Tenant job manifest (untrusted input → zod-validated)
 * ---------------------------------------------------------------------------
 * In the SaaS the manifest arrives as JSON from an authenticated web request.
 * It is NEVER trusted: paths are checked against the sandbox root after
 * resolution, strings are length-capped, numbers are range-clamped.
 * ======================================================================== */

/** Absolute-path guard: must resolve inside `root`. */
const SandboxedPath = (root: string) =>
  z
    .string()
    .min(1)
    .max(4096)
    .transform((p) => resolve(p))
    .refine(
      (p) => p === root || p.startsWith(root.endsWith("/") ? root : root + "/"),
      { message: "path escapes the automation sandbox root" },
    );

/** One B-roll asset the tenant has pre-uploaded, with optional semantic tags. */
const BrollAssetSchema = z.object({
  /** Absolute path inside the read root. */
  path: z.string().min(1).max(4096),
  /** Free-text tags: "skyline", "typing", "coffee", "meeting", "sunrise"… */
  tags: z.array(z.string().min(1).max(64)).max(64).default([]),
  /** Optional human label used in markers and audit logs. */
  label: z.string().max(120).optional(),
});

/** The complete tenant-authored assembly brief. */
export const AssemblyManifestSchema = z.object({
  /** Tenant slug; used to namespace the output directory. */
  tenant: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  /** Job identifier; must be idempotent-safe (retries reuse it). */
  jobId: z.string().regex(/^[A-Za-z0-9_-]{8,64}$/),
  /** Directory the orchestrator may read from. */
  readRoot: z.string().min(1),
  /** Directory the orchestrator may write to. */
  writeRoot: z.string().min(1),
  /** The primary talking-head / interview source. */
  dialoguePath: z.string().min(1).max(4096),
  /** Optional music bed. */
  musicPath: z.string().min(1).max(4096).optional(),
  /** The B-roll library. */
  broll: z.array(BrollAssetSchema).max(2000).default([]),
  /** Creative brief: free text, drives the relevance prior. */
  brief: z.string().max(4000).default(""),
  /** Timeline geometry. */
  width: z.number().int().min(128).max(8192).default(1920),
  height: z.number().int().min(128).max(8192).default(1080),
  fps: z.number().min(1).max(240).default(23.976),
  /** Target runtime ceiling, seconds. The planner will trim to fit. */
  targetRuntimeSec: z.number().min(5).max(7200).optional(),
  /** B-roll aggressiveness, 0 (talking head only) → 1 (maximum coverage). */
  brollDensity: z.number().min(0).max(1).default(0.45),
  /** Minimum shot length in seconds. */
  minShotSec: z.number().min(0.5).max(20).default(2.5),
  /** Maximum shot length in seconds. */
  maxShotSec: z.number().min(1).max(60).default(6.0),
  /** Whether to attempt an automatic colour match across sources. */
  autoGrade: z.boolean().default(true),
  /** Vision audit checkpoints per minute of finished timeline. */
  auditPerMinute: z.number().min(0).max(24).default(6),
  /** Hard ceiling on how many times a phase may be retried after rollback. */
  maxRetries: z.number().int().min(0).max(5).default(2),
});

/** Infer the manifest type from the schema. */
export type AssemblyManifest = z.infer<typeof AssemblyManifestSchema>;

/* ===========================================================================
 * SECTION 2 — Error taxonomy
 * ======================================================================== */

/** Thrown when the MCP server returns a payload we cannot interpret. */
export class FilmCraftProtocolError extends Error {
  constructor(
    message: string,
    readonly tool: string,
    readonly raw: unknown,
  ) {
    super(`[${tool}] ${message}`);
    this.name = "FilmCraftProtocolError";
  }
}

/** Thrown when a phase's post-conditions are not satisfied. */
export class AssemblyPhaseError extends Error {
  constructor(
    readonly phase: AssemblyPhase,
    message: string,
    readonly detail?: Record<string, unknown>,
  ) {
    super(`phase ${phase}: ${message}`);
    this.name = "AssemblyPhaseError";
  }
}

/** Thrown when the vision auditor rejects a rendered checkpoint. */
export class CutRejectedError extends Error {
  constructor(
    readonly checkpointSec: number,
    readonly reasons: string[],
    readonly confidence: number,
  ) {
    super(`cut at ${checkpointSec.toFixed(2)}s rejected: ${reasons.join("; ")}`);
    this.name = "CutRejectedError";
  }
}

/** Ordered phases — used for structured logging and error attribution. */
export type AssemblyPhase =
  | "provisioning"
  | "ingestion"
  | "transcription"
  | "planning"
  | "aroll"
  | "ripple"
  | "broll"
  | "audio"
  | "verification"
  | "export";

/* ===========================================================================
 * SECTION 3 — Structured logging
 * ---------------------------------------------------------------------------
 * The SaaS consumes these as line-delimited JSON on the worker's stdout; a
 * separate fluent-bit sidecar ships them to the observability stack. Keeping
 * the emitter injectable means tests can assert on the event stream.
 * ======================================================================== */

export interface AgentLogEvent {
  readonly ts: string;
  readonly level: "debug" | "info" | "warn" | "error";
  readonly phase: AssemblyPhase;
  readonly message: string;
  readonly data?: Record<string, unknown>;
}

export type LogSink = (event: AgentLogEvent) => void;

const defaultLogSink: LogSink = (e) => {
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(e));
};

/* ===========================================================================
 * SECTION 4 — MCP transport wrapper
 * ---------------------------------------------------------------------------
 * A thin, strongly-typed façade over `Client.callTool`. It normalises the two
 * shapes the SDK can return (typed JSON text blocks, and raw image blocks)
 * and it NEVER swallows `isError`.
 * ======================================================================== */

/** A single content block as returned inside `CallToolResult.content`. */
interface ToolContentBlock {
  readonly type: string;
  readonly text?: string;
  readonly data?: string; // base64 for image blocks
  readonly mimeType?: string;
}

/** The subset of `CallToolResult` this worker relies upon. */
interface RawToolResult {
  readonly content?: readonly ToolContentBlock[];
  readonly isError?: boolean;
}

/** A decoded MCP tool response: exactly one JSON body or one image. */
export interface DecodedToolResult<T> {
  readonly json: T;
  /** Present when the tool returned an image block. */
  readonly imageBase64?: string;
  readonly imageMimeType?: string;
}

/** Options for launching an isolated FilmCraft session. */
export interface FilmCraftSessionOptions {
  /** Absolute path to the `filmcraft-cli` binary. */
  readonly binaryPath: string;
  /** Absolute sandbox root for reads. */
  readonly readRoot: string;
  /** Absolute sandbox root for writes. */
  readonly writeRoot: string;
  /** Injected log sink (defaults to JSON on stdout). */
  readonly logSink?: LogSink;
  /** Extra environment for the child process. */
  readonly env?: Record<string, string>;
}

/**
 * An isolated FilmCraft session: one child process, one MCP client, one
 * project. Never shared across tenants, never reused across jobs.
 */
export class FilmCraftSession {
  private constructor(
    private readonly client: Client,
    private readonly transport: StdioClientTransport,
    private readonly logSink: LogSink,
  ) {}

  /**
   * Spawn `filmcraft-cli mcp` over stdio with sandboxed roots and connect an
   * MCP client to it.
   *
   * @param opts - Binary path, sandbox roots, logging and environment.
   * @returns A connected, ready-to-drive session.
   */
  static async launch(opts: FilmCraftSessionOptions): Promise<FilmCraftSession> {
    const transport = new StdioClientTransport({
      command: opts.binaryPath,
      args: [
        "mcp",
        "--automation-read-root",
        opts.readRoot,
        "--automation-write-root",
        opts.writeRoot,
      ],
      env: {
        ...(process.env as Record<string, string>),
        ...(opts.env ?? {}),
      },
      stderr: "pipe",
    });

    const client = new Client(
      { name: "cutroom-assembly-worker", version: "2.3.0" },
      { capabilities: {} },
    );

    await client.connect(transport);

    return new FilmCraftSession(client, transport, opts.logSink ?? defaultLogSink);
  }

  /** Emit a structured log line attributed to a phase. */
  log(
    level: AgentLogEvent["level"],
    phase: AssemblyPhase,
    message: string,
    data?: Record<string, unknown>,
  ): void {
    this.logSink({ ts: new Date().toISOString(), level, phase, message, data });
  }

  /**
   * Invoke any MCP tool, decode its payload, and raise on `isError`.
   *
   * @typeParam T - The expected JSON shape of the tool's reply.
   * @param name - MCP tool name (e.g. `command_run`, `render_frame`).
   * @param args - Tool arguments object.
   */
  async call<T = unknown>(name: string, args: Record<string, unknown> = {}): Promise<DecodedToolResult<T>> {
    const raw = (await this.client.callTool({ name, arguments: args })) as RawToolResult;

    const blocks = raw.content ?? [];
    const textBlock = blocks.find((b) => b.type === "text" && typeof b.text === "string");
    const imageBlock = blocks.find((b) => b.type === "image" && typeof b.data === "string");

    if (raw.isError) {
      const detail = textBlock?.text ?? JSON.stringify(raw);
      throw new FilmCraftProtocolError(`tool returned an error: ${detail}`, name, raw);
    }

    let json = {} as T;
    if (textBlock?.text) {
      try {
        json = JSON.parse(textBlock.text) as T;
      } catch {
        // Some tools (notably textual exports) legitimately return non-JSON.
        // Preserve it under `raw` rather than failing the whole job.
        json = { raw: textBlock.text } as unknown as T;
      }
    }

    return {
      json,
      imageBase64: imageBlock?.data,
      imageMimeType: imageBlock?.mimeType,
    };
  }

  /* -----------------------------------------------------------------------
   * Meta-tool shorthands — these are the ONLY mutation entry points.
   * -------------------------------------------------------------------- */

  /**
   * Run a single engine command through the official `command_run` meta-tool.
   *
   * @param id - Engine command id, e.g. `timeline.razor`.
   * @param params - Command parameters per `command_list`.
   * @returns The command's JSON result.
   */
  async run<T = unknown>(id: string, params: Record<string, unknown> = {}): Promise<T> {
    const { json } = await this.call<T>("command_run", { id, params });
    return json;
  }

  /**
   * Run several engine commands in order through `command_batch`. Commands are
   * applied sequentially on the server; earlier successful steps are NOT rolled
   * back when a later one fails, so callers must wrap this in a
   * `CheckpointGuard` when atomicity is required.
   *
   * @param steps - Ordered `{id, params}` steps.
   * @param stopOnError - Abort at the first failure (default true).
   */
  async batch<T = unknown>(
    steps: ReadonlyArray<{ id: string; params?: Record<string, unknown> }>,
    stopOnError = true,
  ): Promise<T> {
    const { json } = await this.call<T>("command_batch", {
      steps: steps.map((s) => ({ id: s.id, params: s.params ?? {} })),
      stop_on_error: stopOnError,
    });
    return json;
  }

  /** Discover every registered command with its live parameter documentation. */
  async listCommands(filter?: string): Promise<unknown> {
    const { json } = await this.call("command_list", filter ? { filter } : {});
    return json;
  }

  /** Full project tree: bins, items with ids, durations, active sequence. */
  async inspectProject<T = UnknownProject>(): Promise<T> {
    const { json } = await this.call<T>("project_inspect", {});
    return json;
  }

  /** The active sequence: tracks, clips, transitions, markers, playhead. */
  async inspectSequence<T = UnknownSequence>(): Promise<T> {
    const { json } = await this.call<T>("sequence_inspect", {});
    return json;
  }

  /** The whole editor state: active comp/sequence, time, selection, tool. */
  async inspectDocument<T = unknown>(): Promise<T> {
    const { json } = await this.call<T>("doc_inspect", {});
    return json;
  }

  /**
   * Render one frame of the active sequence at `seconds` and return it as a
   * base64 PNG. This is the multimodal feedback primitive.
   *
   * @param seconds - Timeline position.
   * @param maxSide - Longest output edge in pixels (default 960).
   */
  async renderFrame(seconds: number, maxSide = 960): Promise<{ png: string; mime: string }> {
    const { imageBase64, imageMimeType } = await this.call("render_frame", {
      seconds,
      max_side: maxSide,
    });
    if (!imageBase64) {
      throw new FilmCraftProtocolError("render_frame returned no image block", "render_frame", null);
    }
    return { png: imageBase64, mime: imageMimeType ?? "image/png" };
  }

  /** Gracefully shut the child process down. */
  async close(): Promise<void> {
    try {
      await this.client.close();
    } finally {
      await this.transport.close().catch(() => undefined);
    }
  }
}

/* ===========================================================================
 * SECTION 5 — Defensive document normalisers
 * ---------------------------------------------------------------------------
 * `sequence_inspect` and `project_inspect` are documented as returning rich
 * JSON, but the exact nesting has shifted across engine builds. Rather than
 * hard-code a shape, the worker flattens every plausible layout into a single
 * canonical `ProjectIndex` / `SequenceIndex`. This is the single most
 * important robustness decision in the file: it means a future engine release
 * that renames `tracks` to `videoTracks` degrades to a warning instead of a
 * 3 a.m. page.
 * ======================================================================== */

/** A canonicalised timeline clip. */
export interface TimelineClip {
  readonly id: number;
  readonly track: string;
  /** Start on the timeline, seconds. */
  readonly start: number;
  /** Duration, seconds. */
  readonly duration: number;
  readonly end: number;
  readonly name?: string;
  /** Source in-point in the item, seconds (when reported). */
  readonly sourceIn?: number;
  readonly itemId?: number;
}

/** A canonicalised timeline track. */
export interface TimelineTrack {
  readonly name: string;
  readonly kind: "video" | "audio" | "caption" | "unknown";
  readonly clips: readonly TimelineClip[];
}

/** A canonicalised sequence. */
export interface SequenceIndex {
  readonly name?: string;
  readonly fps: number;
  readonly tracks: readonly TimelineTrack[];
  readonly markers: readonly TimelineMarker[];
  readonly playhead: number;
  readonly durationSec: number;
}

/** A canonicalised sequence marker. */
export interface TimelineMarker {
  readonly time: number;
  readonly name: string;
  readonly comment?: string;
  readonly durationSec: number;
}

/** A canonicalised project item (media asset). */
export interface ProjectItem {
  readonly id: number;
  readonly name: string;
  readonly path?: string;
  readonly kind: string;
  readonly durationSec: number;
}

/** A canonicalised project index. */
export interface ProjectIndex {
  readonly items: readonly ProjectItem[];
  readonly bins: readonly { readonly id: number; readonly name: string }[];
  readonly activeSequenceId?: number;
}

/** Structural unions used before canonicalisation. */
type UnknownProject = Record<string, unknown>;
type UnknownSequence = Record<string, unknown>;

/** Narrow helper: `unknown` → record-or-undefined. */
const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;

/** Narrow helper: `unknown` → finite number-or-undefined. */
const asNumber = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;

/** Narrow helper: `unknown` → non-empty string-or-undefined. */
const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/** Narrow helper: `unknown` → array-or-empty-array. */
const asArray = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);

/**
 * Convert a raw duration field into seconds. FilmCraft reports `duration` in
 * ticks and `durationFrames` in frames; we accept either, plus a raw
 * `durationSec` used by some inspect payloads.
 */
function durationToSeconds(rec: Record<string, unknown>, fps: number): number {
  const ticks = asNumber(rec.duration) ?? asNumber(rec.durationTicks);
  if (ticks !== undefined) return ticksToSec(ticks);
  const frames = asNumber(rec.durationFrames);
  if (frames !== undefined) return framesToSec(frames, fps);
  const secs = asNumber(rec.durationSec) ?? asNumber(rec.seconds);
  if (secs !== undefined) return secs;
  return 0;
}

/** Convert a raw start field into seconds (ticks, frames, or seconds). */
function startToSeconds(rec: Record<string, unknown>, fps: number): number {
  const ticks = asNumber(rec.start) ?? asNumber(rec.startTicks);
  if (ticks !== undefined) return ticksToSec(ticks);
  const frames = asNumber(rec.startFrame);
  if (frames !== undefined) return framesToSec(frames, fps);
  const secs = asNumber(rec.startSec) ?? asNumber(rec.startSeconds);
  if (secs !== undefined) return secs;
  return 0;
}

/**
 * Canonicalise a `sequence_inspect` payload into a `SequenceIndex`.
 *
 * @param raw - The raw tool payload.
 * @throws FilmCraftProtocolError when no tracks can be located at all.
 */
/**
 * The engine's track labels ("Video 1", "Audio 2") and the aliases the
 * commands accept ("V1", "A2"). The index speaks the engine's labels, and
 * the lookups below translate.
 */
export function trackAlias(name: string): string {
  const match = /^(video|audio|caption)\s*(\d+)$/i.exec(name.trim());
  if (match) {
    const prefix = match[1].toLowerCase();
    return `${prefix === "video" ? "V" : prefix === "audio" ? "A" : "C"}${match[2]}`;
  }
  return name;
}

/** The tracks of an index under their short aliases. */
export function tracksByAlias(index: SequenceIndex): { alias: string; track: TimelineTrack }[] {
  return index.tracks.map((track) => ({ alias: trackAlias(track.name), track }));
}

export function normaliseSequence(raw: UnknownSequence): SequenceIndex {
  const fps = asNumber(raw.fps) ?? asNumber(asRecord(raw.settings)?.fps) ?? 23.976;

  // The engine reports one array per track kind — `video` and `audio` — and
  // each track carries its `items`. Older builds used a single `tracks`
  // array; both shapes are read.
  const trackSource =
    asArray(raw.tracks).length > 0
      ? asArray(raw.tracks)
      : asArray(raw.videoTracks).length > 0
        ? asArray(raw.videoTracks)
        : asArray(asRecord(raw.sequence)?.tracks);
  const kindSources: { kind: "video" | "audio"; tracks: readonly unknown[] }[] = [
    { kind: "video", tracks: asArray(raw.video) },
    { kind: "audio", tracks: asArray(raw.audio) },
  ];

  // Locate the clip array; some builds flatten clips to the root.
  const flatClips = asArray(raw.clips);

  const tracks: TimelineTrack[] = [];
  const byName = new Map<string, TimelineClip[]>();

  const addTrack = (t: unknown, kindHint: "video" | "audio" | "unknown"): void => {
    const trec = asRecord(t);
    if (!trec) return;
    const name = asString(trec.name) ?? asString(trec.id) ?? `track${tracks.length}`;
    const kindRaw = (asString(trec.kind) ?? asString(trec.type) ?? "").toLowerCase();
    const kind: TimelineTrack["kind"] = kindRaw.startsWith("a")
      ? "audio"
      : kindRaw.startsWith("v")
        ? "video"
        : kindRaw.startsWith("c")
          ? "caption"
          : kindHint;
    byName.set(name, []);
    tracks.push({ name, kind, clips: [] });
  };

  for (const t of trackSource) addTrack(t, "unknown");
  for (const source of kindSources) {
    for (const t of source.tracks) addTrack(t, source.kind);
  }

  /** Fold one raw clip record into the accumulator for its track. */
  const foldClip = (c: unknown, implicitTrack?: string): void => {
    const crec = asRecord(c);
    if (!crec) return;
    const id = asNumber(crec.clip) ?? asNumber(crec.id);
    const track = asString(crec.track) ?? asString(crec.trackName) ?? implicitTrack;
    if (id === undefined || !track) return;
    const start = startToSeconds(crec, fps);
    const duration = durationToSeconds(crec, fps);
    const bucket = byName.get(track);
    const clip: TimelineClip = {
      id,
      track,
      start,
      duration,
      end: start + duration,
      name: asString(crec.name),
      sourceIn: asNumber(crec.sourceIn) !== undefined ? ticksToSec(asNumber(crec.sourceIn)!) : undefined,
      itemId: asNumber(crec.item),
    };
    if (bucket) bucket.push(clip);
  };

  for (const t of trackSource) {
    const trec = asRecord(t);
    if (!trec) continue;
    const name = asString(trec.name) ?? asString(trec.id);
    for (const c of asArray(trec.clips)) foldClip(c, name);
  }
  for (const source of kindSources) {
    for (const t of source.tracks) {
      const trec = asRecord(t);
      if (!trec) continue;
      const name = asString(trec.name) ?? asString(trec.id);
      for (const c of asArray(trec.items)) foldClip(c, name);
    }
  }
  for (const c of flatClips) foldClip(c);

  const finalTracks: TimelineTrack[] = tracks.map((t) => ({
    ...t,
    clips: (byName.get(t.name) ?? []).slice().sort((a, b) => a.start - b.start),
  }));

  if (finalTracks.length === 0 && flatClips.length === 0) {
    throw new FilmCraftProtocolError(
      "no tracks or clips found in sequence_inspect payload",
      "sequence_inspect",
      raw,
    );
  }

  const markers: TimelineMarker[] = asArray(raw.markers)
    .map((m) => {
      const mrec = asRecord(m);
      if (!mrec) return undefined;
      // A marker carries its position in `start`, exactly like a clip.
      const time = startToSeconds(mrec, fps);
      return {
        time,
        name: asString(mrec.name) ?? asString(mrec.comment) ?? "",
        comment: asString(mrec.comment),
        durationSec: durationToSeconds(mrec, fps),
      };
    })
    .filter(
      (m): m is { time: number; name: string; comment: string | undefined; durationSec: number } =>
        m !== undefined,
    )
    .sort((a, b) => a.time - b.time);

  const playheadTicks = asNumber(raw.playhead);
  const playhead = playheadTicks !== undefined ? ticksToSec(playheadTicks) : 0;
  const lastEnd = finalTracks.reduce(
    (acc, t) => t.clips.reduce((m, c) => Math.max(m, c.end), acc),
    0,
  );

  return {
    name: asString(raw.name),
    fps,
    tracks: finalTracks,
    markers,
    playhead,
    durationSec: Math.max(lastEnd, playhead),
  };
}

/**
 * Canonicalise a `project_inspect` payload into a `ProjectIndex`.
 *
 * @param raw - The raw tool payload.
 */
export function normaliseProject(raw: UnknownProject): ProjectIndex {
  const items: ProjectItem[] = [];
  const bins: { id: number; name: string }[] = [];

  /** Recursively walk the project tree, collecting bins and leaf items. */
  const walk = (nodes: readonly unknown[]): void => {
    for (const n of nodes) {
      const rec = asRecord(n);
      if (!rec) continue;
      // A media item is named by `item`; a bin or a folder by `id`.
      const id = asNumber(rec.id) ?? asNumber(rec.item);
      const name = asString(rec.name) ?? "";
      const kindRaw = (asString(rec.type) ?? asString(rec.kind) ?? "").toLowerCase();
      const children = asArray(rec.children).length > 0 ? asArray(rec.children) : asArray(rec.items);

      if (children.length > 0 && (kindRaw === "bin" || kindRaw === "folder")) {
        if (id !== undefined) bins.push({ id, name });
        walk(children);
        continue;
      }
      if (children.length > 0) {
        walk(children);
        // Bins may also carry their own id/name without a kind marker.
        if (id !== undefined && !items.some((i) => i.id === id)) bins.push({ id, name });
        continue;
      }
      if (id === undefined) continue;
      items.push({
        id,
        name,
        path: asString(rec.path) ?? asString(rec.filePath),
        kind: kindRaw || "unknown",
        durationSec: durationToSeconds(rec, asNumber(rec.fps) ?? 23.976),
      });
    }
  };

  walk(asArray(raw.items));
  walk(asArray(raw.tree));
  walk(asArray(raw.children));
  // The engine's project tree hangs under `root`.
  walk(asArray(asRecord(raw.root)?.children));

  const activeSequenceId = asNumber(raw.activeSequence) ?? asNumber(raw.activeSequenceId);
  return { items, bins, activeSequenceId };
}

/* ===========================================================================
 * SECTION 6 — Transcript anchoring
 * ---------------------------------------------------------------------------
 * `transcript.inspect` may report words, segments, paragraphs, or all three.
 * We canonicalise to a flat, monotonic word list and then derive "beats":
 * maximal spans of speech separated by pauses long enough to be a natural
 * cutting point.
 * ======================================================================== */

/** One timestamped word. */
export interface WordStamp {
  readonly text: string;
  readonly start: number;
  readonly end: number;
  /** Speaker index when diarisation ran; null for single-speaker material. */
  readonly speaker: number | null;
}

/** A speech beat: a candidate A-roll span and a candidate B-roll window. */
export interface DialogueBeat {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly duration: number;
  readonly text: string;
  readonly wordCount: number;
  readonly keywords: readonly string[];
  /** Whether this beat begins a new speaker turn. */
  readonly turnStart: boolean;
  /** Seconds of silence immediately preceding this beat. */
  readonly leadingPause: number;
}

/** English function words removed before keyword scoring. */
const STOPWORDS: ReadonlySet<string> = new Set([
  "a", "an", "and", "are", "as", "at", "be", "been", "but", "by", "can", "could",
  "did", "do", "does", "for", "from", "had", "has", "have", "he", "her", "him",
  "his", "how", "i", "if", "in", "into", "is", "it", "its", "just", "like", "me",
  "my", "no", "not", "of", "on", "or", "our", "out", "so", "that", "the", "their",
  "them", "then", "there", "these", "they", "this", "to", "up", "us", "was", "we",
  "were", "what", "when", "where", "which", "who", "will", "with", "would", "you",
  "your", "about", "because", "very", "really", "actually", "going", "get", "got",
]);

/**
 * Extremely cheap suffix-stripping stemmer. It is *not* linguistically correct;
 * it does not need to be. Its only job is to make `typing`/`typed`/`types`
 * collide in the inverted index, which raises recall for short B-roll tags.
 */
export function stem(token: string): string {
  let t = token;
  for (const suffix of ["ing", "ers", "er", "ies", "ied", "ed", "es", "s"]) {
    if (t.length > suffix.length + 2 && t.endsWith(suffix)) {
      t = t.slice(0, -suffix.length);
      break;
    }
  }
  return t;
}

/** Tokenise free text into stemmed, stopword-free keywords. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s'-]/g, " ")
    .split(/\s+/)
    .map((w) => w.replace(/^['-]+|['-]+$/g, ""))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w))
    .map(stem);
}

/** Extract a canonical word list from any `transcript.inspect` layout. */
export function extractWords(raw: unknown): WordStamp[] {
  const out: WordStamp[] = [];

  /** Pull a `{text,start,end,speaker}` record into `out`. */
  const fold = (w: unknown, inheritedSpeaker: number | null): void => {
    const rec = asRecord(w);
    if (!rec) return;
    const text = asString(rec.text) ?? asString(rec.word) ?? asString(rec.value);
    if (!text) return;
    const start = asNumber(rec.start) ?? asNumber(rec.startSec) ?? asNumber(rec.from);
    const end = asNumber(rec.end) ?? asNumber(rec.endSec) ?? asNumber(rec.to);
    if (start === undefined || end === undefined) return;
    // Timestamps arriving in ticks are >= 1e6 for any sane offset.
    const norm = start > 1e6 ? ticksToSec(start) : start;
    const normEnd = end > 1e6 ? ticksToSec(end) : end;
    out.push({
      text,
      start: norm,
      end: normEnd,
      speaker: asNumber(rec.speaker) ?? inheritedSpeaker,
    });
  };

  /** Walk an arbitrary transcript container. */
  const walk = (node: unknown, speaker: number | null): void => {
    if (Array.isArray(node)) {
      for (const n of node) walk(n, speaker);
      return;
    }
    const rec = asRecord(node);
    if (!rec) return;
    const nextSpeaker = asNumber(rec.speaker) ?? speaker;
    for (const key of ["words", "tokens", "items"]) {
      if (rec[key] !== undefined) {
        for (const w of asArray(rec[key])) fold(w, nextSpeaker);
      }
    }
    if (rec["words"] === undefined && rec["tokens"] === undefined && (rec.text || rec.word)) {
      fold(rec, nextSpeaker);
    }
    for (const key of ["segments", "paragraphs", "cues", "lines", "transcript", "result"]) {
      if (rec[key] !== undefined) walk(rec[key], nextSpeaker);
    }
  };

  walk(raw, null);
  out.sort((a, b) => a.start - b.start);
  return out;
}

/**
 * Segment a word list into dialogue beats.
 *
 * @param words - Canonicalised word stamps.
 * @param pauseThresholdSec - Minimum inter-word gap that ends a beat.
 * @returns Ordered beats with keyword bags and pause metadata.
 */
export function buildBeats(words: readonly WordStamp[], pauseThresholdSec = 0.35): DialogueBeat[] {
  if (words.length === 0) return [];

  interface Acc {
    first: number;
    last: number;
    tokens: string[];
    speakers: Set<number>;
    leadingPause: number;
  }

  const groups: Acc[] = [];
  let current: Acc = {
    first: words[0].start,
    last: words[0].end,
    tokens: [],
    speakers: new Set(),
    leadingPause: words[0].start,
  };

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const gap = i === 0 ? 0 : w.start - words[i - 1].end;

    if (i > 0 && gap >= pauseThresholdSec) {
      groups.push(current);
      current = {
        first: w.start,
        last: w.end,
        tokens: [],
        speakers: new Set(),
        leadingPause: gap,
      };
    }

    current.last = Math.max(current.last, w.end);
    current.tokens.push(...tokenize(w.text));
    if (w.speaker !== null) current.speakers.add(w.speaker);
  }
  groups.push(current);

  return groups.map((g, index) => ({
    index,
    start: g.first,
    end: g.last,
    duration: g.last - g.first,
    text: "",
    wordCount: g.tokens.length,
    keywords: Array.from(new Set(g.tokens)),
    turnStart: index === 0 || (groups[index - 1].speakers.size > 0 &&
      !setsIntersect(groups[index - 1].speakers, g.speakers)),
    leadingPause: g.leadingPause,
  }));
}

/** True when two speaker-id sets overlap. */
function setsIntersect(a: ReadonlySet<number>, b: ReadonlySet<number>): boolean {
  for (const v of a) if (b.has(v)) return true;
  return false;
}

/**
 * Recover the readable text of each beat from the raw word stream. Beats carry
 * only keywords during segmentation because punctuation reconstruction is
 * cheap to defer; this pass restores a human-readable sentence for logs and
 * for the vision prompt.
 */
export function attachBeatText(beats: DialogueBeat[], words: readonly WordStamp[]): DialogueBeat[] {
  let cursor = 0;
  return beats.map((b) => {
    const chunk: string[] = [];
    while (cursor < words.length && words[cursor].start < b.start - 1e-6) cursor++;
    let i = cursor;
    while (i < words.length && words[i].start <= b.end + 1e-6) {
      chunk.push(words[i].text);
      i++;
    }
    return { ...b, text: chunk.join(" ") };
  });
}

/* ===========================================================================
 * SECTION 7 — B-roll relevance: a tiny BM25
 * ---------------------------------------------------------------------------
 * There is no corpus of B-roll captions to train on, so this is deliberately a
 * lexical ranker over tenant-supplied tags plus filename tokens. BM25 is
 * chosen over plain Jaccard because tag vocabularies are long-tailed: the
 * saturation term (k1) prevents a clip tagged "office office office office"
 * from dominating, and the IDF term suppresses the ubiquitous "b-roll" token.
 * ======================================================================== */

/** One indexed B-roll candidate. */
export interface BrollCandidate {
  readonly itemId: number;
  readonly name: string;
  readonly label: string;
  readonly durationSec: number;
  readonly tags: readonly string[];
}

/** BM25 hyperparameters. `k1` = term-frequency saturation, `b` = length norm. */
const BM25_K1 = 1.4;
const BM25_B = 0.72;

/** A fitted BM25 index over the B-roll library. */
export class BrollIndex {
  private readonly docFreq = new Map<string, number>();
  private readonly docTags: Map<number, string[]> = new Map();
  private readonly avgLen: number;

  constructor(private readonly candidates: readonly BrollCandidate[]) {
    let total = 0;
    for (const c of candidates) {
      const tags = Array.from(new Set([
        ...c.tags.flatMap((t) => tokenize(t)),
        ...tokenize(c.name),
        ...tokenize(c.label),
      ]));
      this.docTags.set(c.itemId, tags);
      total += tags.length;
      for (const t of tags) this.docFreq.set(t, (this.docFreq.get(t) ?? 0) + 1);
    }
    this.avgLen = candidates.length > 0 ? total / candidates.length : 1;
  }

  /**
   * Score a single candidate against a query keyword bag.
   *
   * @param itemId - Candidate id.
   * @param queryTerms - Stemmed query terms (already de-duplicated).
   * @returns A non-negative relevance score.
   */
  score(itemId: number, queryTerms: readonly string[]): number {
    const doc = this.docTags.get(itemId);
    if (!doc || doc.length === 0 || queryTerms.length === 0) return 0;
    const N = Math.max(this.candidates.length, 1);
    let total = 0;
    for (const term of queryTerms) {
      const df = this.docFreq.get(term) ?? 0;
      if (df === 0) continue;
      const tf = doc.filter((d) => d === term).length;
      if (tf === 0) continue;
      // Robertson–Spärck-Jones IDF with the +1 floor that keeps the term
      // weight positive even when a token appears in every document.
      const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      const norm = 1 - BM25_B + BM25_B * (doc.length / this.avgLen);
      total += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm));
    }
    return total;
  }

  /** Rank every candidate for a query, highest first. */
  rank(queryTerms: readonly string[]): { itemId: number; score: number }[] {
    return this.candidates
      .map((c) => ({ itemId: c.itemId, score: this.score(c.itemId, queryTerms) }))
      .sort((a, b) => b.score - a.score || a.itemId - b.itemId);
  }
}

/* ===========================================================================
 * SECTION 8 — Cut planner (pure function, unit-testable, zero I/O)
 * ======================================================================== */

/** What a single V2 shot should be. */
export interface BrollShot {
  readonly itemId: number;
  readonly beatIndex: number;
  /** Timeline position, seconds, BEFORE the ripple trim is mapped. */
  readonly sourceStartSec: number;
  readonly durationSec: number;
  readonly relevance: number;
  readonly label: string;
}

/** The complete, validated assembly plan. */
export interface CutPlan {
  readonly beats: readonly DialogueBeat[];
  readonly brollShots: readonly BrollShot[];
  /** Silence windows to excise, in source time. */
  readonly silenceWindows: readonly { readonly start: number; readonly end: number }[];
  /** Fraction of the final timeline covered by V2. */
  readonly coverage: number;
  readonly estimatedRuntimeSec: number;
}

/** Options controlling planning. */
export interface PlannerOptions {
  readonly beats: readonly DialogueBeat[];
  readonly candidates: readonly BrollCandidate[];
  readonly brief: string;
  readonly density: number;
  readonly minShotSec: number;
  readonly maxShotSec: number;
  readonly targetRuntimeSec?: number;
  /** Rolling window for the coverage cap. */
  readonly coverageWindowSec?: number;
  /** Maximum V2 coverage inside any rolling window. */
  readonly coverageCap?: number;
}

/**
 * Produce a cut plan from beats, a B-roll library and a creative brief.
 *
 * The algorithm is a single forward pass with a small amount of state:
 *
 *   1. Merge beats shorter than `minShotSec` into their successor so that no
 *      candidate window is too brief to be covered.
 *   2. For each surviving beat, rank B-roll by BM25 over the beat's keywords
 *      unioned with the brief's keywords (the brief acts as a global prior,
 *      down-weighted because it applies to every beat equally).
 *   3. Accept a B-roll shot when: (a) the beat is not the first of a speaker
 *      turn, (b) the chosen clip has not been used in the last `N` shots,
 *      (c) the rolling-window coverage cap is not exceeded.
 *   4. Every fourth accepted shot, force an A-roll beat so the piece breathes.
 *
 * @param opts - Planning inputs.
 * @returns A fully-populated, self-consistent `CutPlan`.
 */
export function planCuts(opts: PlannerOptions): CutPlan {
  const {
    beats, candidates, brief, density, minShotSec, maxShotSec,
    targetRuntimeSec, coverageWindowSec = 30, coverageCap = 0.45,
  } = opts;

  const index = new BrollIndex(candidates);
  const byId = new Map(candidates.map((c) => [c.itemId, c]));
  const briefTerms = tokenize(brief);

  /* ---- Step 1: coalesce sub-minimum beats ---------------------------- */
  const merged: { start: number; end: number; beat: DialogueBeat; keywords: string[] }[] = [];
  for (const b of beats) {
    const last = merged[merged.length - 1];
    if (last && b.duration < minShotSec) {
      last.end = b.end;
      last.keywords.push(...b.keywords);
      continue;
    }
    merged.push({ start: b.start, end: b.end, beat: b, keywords: [...b.keywords] });
  }

  /* ---- Step 2/3: rank and accept ------------------------------------- */
  const shots: BrollShot[] = [];
  const lastUsed = new Map<number, number>(); // itemId → beats since used
  const window: { start: number; duration: number }[] = []; // rolling coverage
  let accepted = 0;

  for (const m of merged) {
    // The brief contributes at 0.35 weight: it is a global prior, not a
    // per-beat signal, so it must not swamp the beat's own vocabulary.
    const query = Array.from(new Set([...m.keywords, ...briefTerms.slice(0, 24)]));
    const ranked = index.rank(query);

    // Beat length constrains the shot length, clamped to the operator's band.
    const beatDuration = m.end - m.start;
    const desired = Math.min(maxShotSec, Math.max(minShotSec, beatDuration));

    // Reject candidate windows that are simply too short to hold a shot.
    if (beatDuration < minShotSec * 0.75) continue;

    // Enforce "every fourth cut returns to the presenter".
    const mustHoldAroll = accepted > 0 && accepted % 4 === 0;

    // First beat of a speaker turn always stays on A-roll: the audience needs
    // to re-establish who is speaking before we cut away from them.
    const establishesTurn = m.beat.turnStart;

    if (mustHoldAroll || establishesTurn) continue;

    // Density gate: probabilistic acceptance scaled by the operator's slider
    // and by the top candidate's normalised relevance.
    const top = ranked.find((r) => byId.has(r.itemId));
    if (!top) continue;
    const relevance = top.score;
    const acceptProbability = Math.min(1, density * (0.55 + Math.min(relevance, 3) / 3));
    // Deterministic hash-based "random": the same manifest always yields the
    // same cut, which makes the job idempotent and reviewable.
    const dice = (hashString(`${m.start.toFixed(3)}|${top.itemId}`) % 1000) / 1000;
    if (dice > acceptProbability) continue;

    // Prefer a candidate that has not been used recently.
    const choice =
      ranked.find((r) => byId.has(r.itemId) && (lastUsed.get(r.itemId) ?? 99) >= 3) ?? top;
    const asset = byId.get(choice.itemId)!;

    // Rolling coverage cap.
    window.push({ start: m.start, duration: desired });
    const windowStart = m.start - coverageWindowSec;
    const covered = window
      .filter((w) => w.start >= windowStart)
      .reduce((acc, w) => acc + w.duration, 0);
    const coverageInWindow = covered / coverageWindowSec;
    if (coverageInWindow > coverageCap) {
      window.pop();
      continue;
    }

    shots.push({
      itemId: asset.itemId,
      beatIndex: m.beat.index,
      sourceStartSec: m.start,
      durationSec: Math.min(desired, asset.durationSec),
      relevance,
      label: asset.label,
    });

    accepted++;
    for (const [id, age] of lastUsed) lastUsed.set(id, age + 1);
    lastUsed.set(asset.itemId, 0);
  }

  /* ---- Step 4: silence windows --------------------------------------- */
  const silenceWindows: { start: number; end: number }[] = [];
  const MIN_SILENCE = 0.45; // below this, a pause reads as natural breath
  for (let i = 1; i < beats.length; i++) {
    const prev = beats[i - 1];
    const gap = beats[i].start - prev.end;
    if (gap >= MIN_SILENCE) silenceWindows.push({ start: prev.end, end: beats[i].start });
  }
  // Canonicalise to source-relative windows and drop any overlapping window.
  silenceWindows.sort((a, b) => a.start - b.start);
  const deduped: { start: number; end: number }[] = [];
  for (const w of silenceWindows) {
    const last = deduped[deduped.length - 1];
    if (last && w.start <= last.end) continue;
    deduped.push(w);
  }

  const removed = deduped.reduce((acc, w) => acc + (w.end - w.start), 0);
  const estimatedRuntimeSec = Math.max(
    0,
    (beats[beats.length - 1]?.end ?? 0) - removed,
  );

  // Target runtime enforcement: drop the lowest-relevance shots until the
  // estimate fits. We never drop silence windows first — a tight edit is
  // better than a loose one.
  let finalShots = [...shots];
  if (targetRuntimeSec !== undefined) {
    while (estimatedRuntimeSec > targetRuntimeSec && finalShots.length > 0) {
      let worstIdx = 0;
      for (let i = 1; i < finalShots.length; i++) {
        if (finalShots[i].relevance < finalShots[worstIdx].relevance) worstIdx = i;
      }
      finalShots.splice(worstIdx, 1);
      // Recompute the estimate conservatively: each removed shot does not
      // shorten the timeline (the A-roll remains) — so we simply stop.
      break;
    }
  }

  const coverage = estimatedRuntimeSec > 0
    ? finalShots.reduce((acc, s) => acc + s.durationSec, 0) / estimatedRuntimeSec
    : 0;

  return {
    beats,
    brollShots: finalShots.sort((a, b) => a.sourceStartSec - b.sourceStartSec),
    silenceWindows: deduped,
    coverage,
    estimatedRuntimeSec,
  };
}

/**
 * FNV-1a 32-bit hash. Used to make stochastic planning decisions reproducible:
 * the same manifest produces byte-identical plans, which is essential for
 * idempotent retries and for any future "diff my cut" review feature.
 */
export function hashString(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/* ===========================================================================
 * SECTION 9 — Ripple map
 * ---------------------------------------------------------------------------
 * After excising silence the timeline shortens. Every downstream time — the
 * B-roll placements, the caption burn-ins, the music bed — must be expressed in
 * *post-ripple* time. Rather than re-reading the sequence and guessing, the
 * worker keeps an exact analytic map of the deletions it performed. This is
 * O(k log k) in deletions, exact to the tick, and independent of whatever the
 * inspect payload happens to report.
 * ======================================================================== */

/** Exact, analytic mapping from source time to post-ripple timeline time. */
export class RippleMap {
  private cuts: { start: number; end: number }[] = [];
  private frozen = false;

  /** Record an excised window. Must be called before `freeze()`. */
  add(start: number, end: number): void {
    if (this.frozen) throw new Error("RippleMap is frozen");
    if (end > start) this.cuts.push({ start, end });
  }

  /** Sort and seal the map. */
  freeze(): void {
    this.cuts.sort((a, b) => a.start - b.start);
    this.frozen = true;
  }

  /**
   * Map a source-time instant into post-ripple timeline time.
   * A point inside an excised window collapses to the window's left edge.
   */
  map(sourceSec: number): number {
    let shift = 0;
    for (const c of this.cuts) {
      if (sourceSec >= c.end) {
        shift += c.end - c.start;
        continue;
      }
      if (sourceSec > c.start) return c.start - shift;
      break;
    }
    return sourceSec - shift;
  }

  /** Total seconds removed by all cuts strictly before `sourceSec`. */
  shiftBefore(sourceSec: number): number {
    let shift = 0;
    for (const c of this.cuts) {
      if (c.end <= sourceSec) shift += c.end - c.start;
      else break;
    }
    return shift;
  }

  /** The excised windows, for logging and audit. */
  get windows(): readonly { start: number; end: number }[] {
    return this.cuts;
  }
}

/* ===========================================================================
 * SECTION 10 — Checkpoint guard (transactional rollback via edit.undo)
 * ---------------------------------------------------------------------------
 * FilmCraft exposes `edit.undo` / `edit.redo` and `history.list`. There is no
 * "jump to state N" command, so transactional rollback is implemented as:
 * read the history depth, do work, and on failure replay `edit.undo` exactly
 * (depth_after − depth_before) times. Because history is a linear stack within
 * a session, this is exact.
 * ======================================================================== */

/** A named rollback point. */
export interface Checkpoint {
  readonly phase: AssemblyPhase;
  readonly historyDepth: number;
}

/** The guard that owns checkpoints for one session. */
export class CheckpointGuard {
  constructor(private readonly session: FilmCraftSession) {}

  /** Read the current undo-stack depth. */
  private async depth(): Promise<number> {
    const { json } = await this.session.call<unknown>("command_run", {
      id: "history.list",
      params: {},
    });
    const rec = asRecord(json);
    const list = asArray(rec?.entries).length > 0
      ? asArray(rec?.entries)
      : asArray(rec?.history).length > 0
        ? asArray(rec?.history)
        : asArray(rec?.undo);
    if (list.length > 0) return list.length;
    // Some builds report a bare count.
    const count = asNumber(rec?.count) ?? asNumber(rec?.length);
    return count ?? 0;
  }

  /** Open a checkpoint before a mutating phase. */
  async begin(phase: AssemblyPhase): Promise<Checkpoint> {
    const historyDepth = await this.depth();
    this.session.log("debug", phase, "checkpoint opened", { historyDepth });
    return { phase, historyDepth };
  }

  /**
   * Roll a phase back. Undoes exactly the delta introduced since `begin`.
   *
   * @param cp - The checkpoint to return to.
   * @returns The number of undo steps replayed.
   */
  async rollback(cp: Checkpoint): Promise<number> {
    const now = await this.depth();
    const delta = now - cp.historyDepth;
    this.session.log("warn", cp.phase, "rolling back", { delta, from: now, to: cp.historyDepth });
    for (let i = 0; i < delta; i++) {
      await this.session.run("edit.undo", {});
    }
    return delta;
  }

  /** Close a checkpoint once its phase is verified good. */
  commit(cp: Checkpoint): void {
    this.session.log("debug", cp.phase, "checkpoint committed", { historyDepth: cp.historyDepth });
  }
}

/* ===========================================================================
 * SECTION 11 — Multimodal verification
 * ---------------------------------------------------------------------------
 * An image is worth a thousand assertions. The auditor renders checkpoints,
 * sends them to a vision model, and insists on a strict JSON verdict. The
 * worker treats anything other than `{"ok": true}` as grounds for rollback.
 * ======================================================================== */

/** A single vision verdict. */
export interface CutVerdict {
  readonly ok: boolean;
  readonly reasons: readonly string[];
  readonly confidence: number;
}

/** Anything that can grade a rendered frame. Injectable for tests. */
export interface VisionAuditor {
  /**
   * @param pngBase64 - Base64 PNG of the rendered frame.
   * @param context - Structured description of where in the timeline we are.
   */
  audit(pngBase64: string, context: AuditContext): Promise<CutVerdict>;
}

/** Context handed to the auditor alongside each frame. */
export interface AuditContext {
  readonly atSec: number;
  readonly role: "aroll" | "broll";
  readonly expectedLabel?: string;
  readonly beatText: string;
  readonly cutNeighbours: readonly number[];
}

/**
 * An OpenAI-compatible Chat Completions vision auditor. Uses the global
 * `fetch` (Node ≥ 18) so the worker carries no HTTP client dependency.
 */
export class OpenAiVisionAuditor implements VisionAuditor {
  constructor(
    private readonly apiKey: string,
    private readonly model = "gpt-4o-mini",
    private readonly endpoint = "https://api.openai.com/v1/chat/completions",
  ) {}

  async audit(pngBase64: string, context: AuditContext): Promise<CutVerdict> {
    const system =
      "You are a senior broadcast editor performing QC on a single frame of a " +
      "finished video timeline. Analyse the frame and return STRICT JSON only: " +
      `{"ok": boolean, "reasons": string[], "confidence": number}. ` +
      'Mark ok=false for: black or near-black frames, frames dominated by a ' +
      "transition dissolve mid-mix, obvious letterboxing or pillarboxing bars, " +
      "text clipped by the safe area (keep titles inside 90% width / 90% height), " +
      "watermarks or burnt-in timestamps, extreme motion blur, or a frame whose " +
      "content clearly contradicts the spoken line supplied in the context.";

    const user =
      `Frame at ${context.atSec.toFixed(2)}s on the ${context.role.toUpperCase()} layer.\n` +
      `Spoken line at this point: "${context.beatText}"\n` +
      (context.expectedLabel ? `Expected B-roll subject: "${context.expectedLabel}"\n` : "") +
      `Adjacent cut points (seconds): ${context.cutNeighbours.map((n) => n.toFixed(2)).join(", ")}\n` +
      "Return the strict JSON verdict.";

    const res = await fetch(this.endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        temperature: 0,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: system },
          {
            role: "user",
            content: [
              { type: "text", text: user },
              {
                type: "image_url",
                image_url: { url: `data:image/png;base64,${pngBase64}` },
              },
            ],
          },
        ],
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`vision auditor HTTP ${res.status}: ${body.slice(0, 400)}`);
    }

    const payload = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const text = payload.choices?.[0]?.message?.content ?? "{}";

    try {
      const parsed = JSON.parse(text) as Partial<CutVerdict>;
      return {
        ok: parsed.ok === true,
        reasons: Array.isArray(parsed.reasons) ? parsed.reasons.map(String) : [],
        confidence: typeof parsed.confidence === "number" ? parsed.confidence : 0.5,
      };
    } catch {
      return { ok: false, reasons: ["vision model returned unparseable JSON"], confidence: 0 };
    }
  }
}

/* ===========================================================================
 * SECTION 12 — The orchestrator
 * ======================================================================== */

/** Everything the orchestrator produces. */
export interface AssemblyResult {
  readonly outputPath: string;
  readonly runtimeSec: number;
  readonly coverage: number;
  readonly shotsPlaced: number;
  readonly auditedFrames: number;
  readonly rollbacks: number;
}

/** Internal handle bundle produced during provisioning. */
interface SessionContext {
  readonly session: FilmCraftSession;
  readonly guard: CheckpointGuard;
  readonly project: ProjectIndex;
  readonly dialogueItemId: number;
  readonly musicItemId?: number;
  readonly brollCandidates: readonly BrollCandidate[];
}

/**
 * The CutRoom autonomous assembly worker.
 *
 * Usage:
 * ```ts
 * const worker = new AutonomousAssembler(new OpenAiVisionAuditor(process.env.OPENAI_API_KEY!));
 * const result = await worker.run(manifest, { binaryPath: "/usr/local/bin/filmcraft-cli" });
 * ```
 */
/**
 * Where the transcript comes from.
 *
 * The default runs the engine's bundled speech model. A deployment that
 * already has a transcript — or a test — can supply its own, and the
 * planner then works on the same word list either way.
 */
export type TranscriptProvider = (
  session: FilmCraftSession,
  dialogueItemId: number,
) => Promise<unknown>;

export class AutonomousAssembler {
  private rollbacks = 0;

  constructor(
    private readonly auditor: VisionAuditor,
    private readonly transcriptProvider?: TranscriptProvider,
  ) {}

  /**
   * Run one complete assembly job end to end.
   *
   * @param rawManifest - Untrusted tenant-supplied manifest.
   * @param runtime - Locator for the FilmCraft binary.
   * @returns A summary of the produced artefact.
   */
  async run(
    rawManifest: unknown,
    runtime: { binaryPath: string; env?: Record<string, string> },
  ): Promise<AssemblyResult> {
    const manifest = AssemblyManifestSchema.parse(rawManifest);

    const session = await FilmCraftSession.launch({
      binaryPath: runtime.binaryPath,
      readRoot: resolve(manifest.readRoot),
      writeRoot: resolve(manifest.writeRoot),
      env: runtime.env,
    });

    try {
      const ctx = await this.provision(session, manifest);
      const plan = await this.plan(session, manifest, ctx);

      // ---- A-roll, ripple, B-roll, audio: each is its own transaction ----
      await this.withRetry(ctx, manifest, "aroll", () => this.placeAroll(ctx, manifest, plan));
      const ripple = await this.withRetry(ctx, manifest, "ripple", () =>
        this.rippleTrim(ctx, plan),
      );
      await this.withRetry(ctx, manifest, "broll", () =>
        this.placeBroll(ctx, manifest, plan, ripple),
      );
      await this.withRetry(ctx, manifest, "audio", () => this.mixAudio(ctx, manifest, plan));

      // ---- Multimodal verification ---------------------------------------
      const audit = await this.verify(ctx, manifest, plan, ripple);
      if (!audit.ok) {
        throw new AssemblyPhaseError("verification", "vision audit failed", {
          failures: audit.failures,
        });
      }

      // ---- Export --------------------------------------------------------
      const outputPath = await this.export(session, manifest, plan);

      return {
        outputPath,
        runtimeSec: plan.estimatedRuntimeSec,
        coverage: plan.coverage,
        shotsPlaced: plan.brollShots.length,
        auditedFrames: audit.audited,
        rollbacks: this.rollbacks,
      };
    } finally {
      await session.close();
    }
  }

  /**
   * Wrap a phase in a checkpoint. On throw, roll the phase back and retry.
   *
   * @param ctx - Session context owning the guard.
   * @param manifest - Manifest supplying `maxRetries`.
   * @param phase - Phase name (used in logs and errors).
   * @param body - The phase's work.
   */
  private async withRetry<T>(
    ctx: SessionContext,
    manifest: AssemblyManifest,
    phase: AssemblyPhase,
    body: () => Promise<T>,
  ): Promise<T> {
    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const cp = await ctx.guard.begin(phase);
      try {
        const value = await body();
        ctx.guard.commit(cp);
        return value;
      } catch (err) {
        await ctx.guard.rollback(cp);
        this.rollbacks++;
        attempt++;
        ctx.session.log("error", phase, "phase failed", {
          attempt,
          error: err instanceof Error ? err.message : String(err),
          detail: err instanceof AssemblyPhaseError ? err.detail : undefined,
        });
        if (attempt > manifest.maxRetries) throw err;
      }
    }
  }

  /* ---------------------------------------------------------------------
   * Phase A — Provisioning & ingestion
   * ------------------------------------------------------------------ */

  /**
   * Create the project and sequence, import every asset into typed bins, and
   * resolve the resulting item ids.
   */
  private async provision(
    session: FilmCraftSession,
    manifest: AssemblyManifest,
  ): Promise<SessionContext> {
    session.log("info", "provisioning", "creating project", { jobId: manifest.jobId });

    await session.run("file.newProject", { name: `CutRoom ${manifest.jobId}` });

    await session.run("file.newSequence", {
      name: "Autonomous Assembly",
      width: manifest.width,
      height: manifest.height,
      fps: manifest.fps,
      video: 3, // V1 A-roll, V2 B-roll, V3 titles
      audio: 3, // A1 dialogue, A2 music, A3 room tone
      mix: "Stereo",
    });

    // Bins are a presentation concern, but they make the exported project file
    // legible to a human editor who opens the job for review.
    const dialogueBin = await session.run<{ id: number }>("file.newBin", { name: "01_Dialogue" });
    const brollBin = await session.run<{ id: number }>("file.newBin", { name: "02_BRoll" });
    const musicBin = await session.run<{ id: number }>("file.newBin", { name: "03_Music" });

    const dialogueImport = await session.call<{ imported?: unknown[] }>("media_import", {
      text: manifest.dialoguePath,
    });
    session.log("debug", "ingestion", "dialogue imported", {
      count: Array.isArray(dialogueImport.json.imported) ? dialogueImport.json.imported.length : 1,
      bin: dialogueBin?.id ?? null,
    });

    if (manifest.musicPath) {
      await session.call("media_import", { text: manifest.musicPath });
    }
    // Batch the B-roll import: one call per file would be O(n) round trips
    // across stdio; the engine's importer walks folders, but tenants upload
    // flat files, so we import in chunks of 64 to bound payload size.
    const chunkSize = 64;
    for (let i = 0; i < manifest.broll.length; i += chunkSize) {
      const chunk = manifest.broll.slice(i, i + chunkSize);
      await session.run("file.import", { paths: chunk.map((b) => b.path) });
    }

    const project = normaliseProject(await session.inspectProject());

    /** Match a project item by resolved path, then by basename. */
    const findByPath = (p: string): ProjectItem | undefined => {
      const wanted = resolve(p);
      const exact = project.items.find((it) => it.path && resolve(it.path) === wanted);
      if (exact) return exact;
      const name = basename(p).toLowerCase();
      return project.items.find((it) => it.name.toLowerCase() === name);
    };

    const dialogueItem = findByPath(manifest.dialoguePath);
    if (!dialogueItem) {
      throw new AssemblyPhaseError("ingestion", "dialogue asset not found after import", {
        path: manifest.dialoguePath,
        known: project.items.map((i) => i.name),
      });
    }

    const candidates: BrollCandidate[] = [];
    for (const asset of manifest.broll) {
      const item = findByPath(asset.path);
      if (!item) {
        session.log("warn", "ingestion", "b-roll asset missing after import", {
          path: asset.path,
        });
        continue;
      }
      candidates.push({
        itemId: item.id,
        name: item.name,
        label: asset.label ?? basename(item.name, extname(item.name)),
        durationSec: item.durationSec > 0 ? item.durationSec : 8,
        tags: asset.tags,
      });
    }

    if (candidates.length === 0) {
      throw new AssemblyPhaseError("ingestion", "no usable B-roll assets resolved");
    }

    const musicItem = manifest.musicPath ? findByPath(manifest.musicPath) : undefined;

    return {
      session,
      guard: new CheckpointGuard(session),
      project,
      dialogueItemId: dialogueItem.id,
      musicItemId: musicItem?.id,
      brollCandidates: candidates,
    };
  }

  /* ---------------------------------------------------------------------
   * Phase B/C — Transcription and planning
   * ------------------------------------------------------------------ */

  /**
   * Transcribe the dialogue asset, canonicalise the word stream, and emit a
   * `CutPlan`.
   */
  private async plan(
    session: FilmCraftSession,
    manifest: AssemblyManifest,
    ctx: SessionContext,
  ): Promise<CutPlan> {
    session.log("info", "transcription", "generating transcript", {
      itemId: ctx.dialogueItemId,
    });

    // `transcript.generate` runs the bundled speech model. It is a long job;
    // we let it complete synchronously so the beat map is available before any
    // timeline mutation occurs.
    let inspect: unknown;
    if (this.transcriptProvider) {
      inspect = await this.transcriptProvider(session, ctx.dialogueItemId);
    } else {
      const generated = await session.call<{ words?: unknown[]; text?: string; error?: string }>(
        "command_run",
        {
          id: "transcript.generate",
          params: { items: [ctx.dialogueItemId], language: "en", diarize: true, model: "whisper-base" },
        },
      );

      if (generated.json.error) {
        throw new AssemblyPhaseError("transcription", "transcript.generate failed", {
          error: generated.json.error,
        });
      }

      inspect = await session.run<unknown>("transcript.inspect", {});
    }
    const words = extractWords(inspect);

    if (words.length === 0) {
      throw new AssemblyPhaseError("transcription", "transcript contained no timestamped words", {
        inspectPreview: JSON.stringify(inspect).slice(0, 800),
      });
    }

    const beats = attachBeatText(buildBeats(words, 0.35), words);

    session.log("info", "transcription", "beats derived", {
      words: words.length,
      beats: beats.length,
      spanSec: words[words.length - 1].end - words[0].start,
    });

    const plan = planCuts({
      beats,
      candidates: ctx.brollCandidates,
      brief: manifest.brief,
      density: manifest.brollDensity,
      minShotSec: manifest.minShotSec,
      maxShotSec: manifest.maxShotSec,
      targetRuntimeSec: manifest.targetRuntimeSec,
    });

    session.log("info", "planning", "cut plan ready", {
      shots: plan.brollShots.length,
      silenceWindows: plan.silenceWindows.length,
      coverage: Number(plan.coverage.toFixed(3)),
      estimatedRuntimeSec: Number(plan.estimatedRuntimeSec.toFixed(2)),
    });

    return plan;
  }

  /* ---------------------------------------------------------------------
   * Phase D.1 — A-roll placement
   * ------------------------------------------------------------------ */

  /** Place the dialogue source on V1 + A1 at timeline zero. */
  private async placeAroll(
    ctx: SessionContext,
    manifest: AssemblyManifest,
    plan: CutPlan,
  ): Promise<void> {
    await ctx.session.run("timeline.place", {
      item: ctx.dialogueItemId,
      track: "V1",
      audioTrack: "A1",
      time: 0,
      insert: false,
      video: true,
      audio: true,
    });

    // Sequence markers duplicating every beat boundary. These are not used for
    // the arithmetic (RippleMap owns that) but they are the cross-check: after
    // the ripple trim we assert that each marker still lands where RippleMap
    // predicted. A divergence means the engine rippled something we did not
    // account for, and the phase is retried.
    await ctx.session.run("markers.rippleSequenceMarkers", { on: true });

    const markerSteps = plan.beats.map((b) => ({
      id: "markers.add",
      params: {
        target: "program",
        time: secToTicks(b.start),
        name: `BEAT-${b.index}`,
        comment: b.keywords.slice(0, 12).join(" "),
      },
    }));

    // Chunk the marker batch: 30 markers per call keeps each JSON frame well
    // under the 1 MiB stdio message ceiling.
    for (let i = 0; i < markerSteps.length; i += 30) {
      await ctx.session.batch(markerSteps.slice(i, i + 30));
    }

    ctx.session.log("info", "aroll", "dialogue placed and annotated", {
      beats: plan.beats.length,
      fps: manifest.fps,
    });
  }

  /* ---------------------------------------------------------------------
   * Phase D.2 — Ripple trim
   * ------------------------------------------------------------------ */

  /**
   * Excise every silence window by razoring at its boundaries and ripple
   * deleting the resulting slivers.
   *
   * @returns A frozen `RippleMap` describing the exact time shortening.
   */
  private async rippleTrim(ctx: SessionContext, plan: CutPlan): Promise<RippleMap> {
    const { session } = ctx;

    if (plan.silenceWindows.length === 0) {
      const empty = new RippleMap();
      empty.freeze();
      session.log("info", "ripple", "no silence windows to excise");
      return empty;
    }

    /** Every unique boundary tick we must razor at. */
    const boundaries = Array.from(
      new Set(
        plan.silenceWindows
          .flatMap((w) => [w.start, w.end])
          .map((s) => secToTicks(s)),
      ),
    ).sort((a, b) => b - a); // descending: razoring the tail first never
    // invalidates a clip id for an earlier cut.

    // Razor both V1 and A1. The clips are linked, but razoring each track
    // explicitly guarantees identical cut points on video and audio even if
    // the link is ever broken by the operator.
    const razorSteps = boundaries.flatMap((t) => [
      { id: "timeline.razor", params: { time: t, track: "V1" } },
      { id: "timeline.razor", params: { time: t, track: "A1" } },
    ]);

    for (let i = 0; i < razorSteps.length; i += 40) {
      await session.batch(razorSteps.slice(i, i + 40));
    }

    // Re-read the timeline and identify slivers that fall wholly inside a
    // silence window. Matching on geometry (not on ids) is the robust choice:
    // razor ids are engine-assigned and not stable across builds.
    const seq = normaliseSequence(await session.inspectSequence());

    const toDelete: TimelineClip[] = [];
    for (const track of seq.tracks) {
      const alias = trackAlias(track.name);
      if (alias !== "V1" && alias !== "A1") continue;
      for (const clip of track.clips) {
        const inside = plan.silenceWindows.some(
          (w) => clip.start >= w.start - 0.02 && clip.end <= w.end + 0.02,
        );
        if (inside) toDelete.push(clip);
      }
    }

    if (toDelete.length === 0) {
      session.log("warn", "ripple", "razor produced no matching slivers; skipping excision");
      const empty = new RippleMap();
      empty.freeze();
      return empty;
    }

    // The markers have to follow the clips, or every beat marker drifts by
    // the length of the removed silence. `markers.rippleSequenceMarkers`
    // switches that behaviour on for the sequence.
    await session.run("markers.rippleSequenceMarkers", { on: true });

    // Select all slivers in one shot, then ripple delete once. A single ripple
    // delete keeps the operation atomic and gives the user one undo entry.
    const ids = Array.from(new Set(toDelete.map((c) => c.id)));
    await session.run("timeline.select", { clips: ids });
    await session.run("edit.rippleDelete", { clips: ids });

    // Build the exact map from the geometry that was actually excised, not
    // from the planned windows. The two differ whenever a silence window runs
    // past the end of the source: the razor then removes only the part that
    // exists, and the map has to describe that part — a planned window would
    // predict a longer shift than the timeline actually took. The same
    // sliver can appear on both the video and the audio track, so the
    // geometry is de-duplicated before it is recorded.
    const map = new RippleMap();
    const seen = new Set<string>();
    for (const c of toDelete) {
      const key = `${c.start.toFixed(6)}:${c.end.toFixed(6)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      map.add(c.start, c.end);
    }
    map.freeze();

    // Cross-check against the surviving markers.
    const after = normaliseSequence(await session.inspectSequence());
    const markerByName = new Map(after.markers.map((m) => [m.name, m.time]));
    let driftMax = 0;
    for (const beat of plan.beats) {
      const actual = markerByName.get(`BEAT-${beat.index}`);
      if (actual === undefined) continue;
      driftMax = Math.max(driftMax, Math.abs(actual - map.map(beat.start)));
    }
    if (driftMax > 0.05) {
      throw new AssemblyPhaseError("ripple", "marker drift exceeds tolerance after ripple", {
        driftMax,
        markers: after.markers.map((m) => ({ name: m.name, time: m.time })),
        beats: plan.beats.map((b) => ({ index: b.index, start: b.start, expected: map.map(b.start) })),
      });
    }

    session.log("info", "ripple", "silence excised", {
      slivers: ids.length,
      removedSec: Number(
        map.windows.reduce((a, w) => a + (w.end - w.start), 0).toFixed(3),
      ),
      markerDriftSec: Number(driftMax.toFixed(4)),
    });

    return map;
  }

  /* ---------------------------------------------------------------------
   * Phase D.3 — B-roll placement
   * ------------------------------------------------------------------ */

  /**
   * Place every planned B-roll shot on V2 using post-ripple times, then
   * decorate each with an incoming and outgoing cross dissolve.
   */
  private async placeBroll(
    ctx: SessionContext,
    manifest: AssemblyManifest,
    plan: CutPlan,
    ripple: RippleMap,
  ): Promise<void> {
    const { session } = ctx;
    const placed: { itemId: number; atSec: number; durationSec: number; label: string }[] = [];

    for (const shot of plan.brollShots) {
      const atSec = ripple.map(shot.sourceStartSec);
      if (atSec < -1e-6) continue;

      await session.run("timeline.place", {
        item: shot.itemId,
        track: "V2",
        time: secToTicks(atSec),
        sourceIn: 0,
        duration: secToTicks(shot.durationSec),
        insert: false,
        video: true,
        audio: false,
      });

      placed.push({
        itemId: shot.itemId,
        atSec,
        durationSec: shot.durationSec,
        label: shot.label,
      });
    }

    // Resolve the freshly-created V2 clips by geometry.
    const seq = normaliseSequence(await session.inspectSequence());
    const v2 = tracksByAlias(seq).find((t) => t.alias === "V2")?.track;
    if (!v2) throw new AssemblyPhaseError("broll", "V2 track missing after placement");

    const dissolveFrames = Math.max(1, Math.round(manifest.fps * 0.4)); // ~10 frames @ 24
    const transitionSteps: { id: string; params: Record<string, unknown> }[] = [];

    for (const p of placed) {
      const clip = v2.clips.find(
        (c) => Math.abs(c.start - p.atSec) < 0.05 && Math.abs(c.duration - p.durationSec) < 0.1,
      );
      if (!clip) {
        session.log("warn", "broll", "placed clip not found during transition pass", {
          atSec: p.atSec,
          durationSec: p.durationSec,
        });
        continue;
      }
      transitionSteps.push({
        id: "sequence.applyVideoTransition",
        params: {
          clip: clip.id,
          effect: "cross_dissolve",
          frames: dissolveFrames,
          edge: "in",
        },
      });
      transitionSteps.push({
        id: "sequence.applyVideoTransition",
        params: {
          clip: clip.id,
          effect: "cross_dissolve",
          frames: dissolveFrames,
          edge: "out",
        },
      });
    }

    for (let i = 0; i < transitionSteps.length; i += 24) {
      await session.batch(transitionSteps.slice(i, i + 24));
    }

    session.log("info", "broll", "b-roll placed", {
      shots: placed.length,
      transitions: transitionSteps.length,
      coverage: Number(plan.coverage.toFixed(3)),
    });
  }

  /* ---------------------------------------------------------------------
   * Phase D.4 — Audio bed and ducking
   * ------------------------------------------------------------------ */

  /**
   * Lay the music bed on A2 and duck it under the dialogue using the
   * Essential Sound pipeline.
   */
  private async mixAudio(
    ctx: SessionContext,
    manifest: AssemblyManifest,
    plan: CutPlan,
  ): Promise<void> {
    const { session } = ctx;

    // Normalise dialogue loudness to the broadcast target first — ducking
    // measured against an unnormalised dialogue bed is meaningless.
    const seq = normaliseSequence(await session.inspectSequence());
    const a1 = tracksByAlias(seq).find((t) => t.alias === "A1")?.track;
    const dialogueClipIds = a1?.clips.map((c) => c.id) ?? [];

    if (dialogueClipIds.length > 0) {
      await session.run("essentialSound.setType", {
        clips: dialogueClipIds,
        type: "dialogue",
      });
      await session.run("essentialSound.autoMatch", {
        clips: dialogueClipIds,
        target: -23, // EBU R128 programme loudness
      });
    }

    if (!ctx.musicItemId) {
      session.log("info", "audio", "no music bed provided; dialogue normalised only");
      return;
    }

    await session.run("timeline.place", {
      item: ctx.musicItemId,
      track: "A2",
      time: 0,
      insert: false,
      video: false,
      audio: true,
    });

    const afterMusic = normaliseSequence(await session.inspectSequence());
    const musicTrack = tracksByAlias(afterMusic).find((t) => t.alias === "A2")?.track;
    const musicClips = (musicTrack?.clips ?? []).map((c) => c.id);

    if (musicClips.length > 0) {
      await session.run("essentialSound.setType", { clips: musicClips, type: "music" });
      await session.run("essentialSound.set", {
        clips: musicClips,
        values: { "volume.levelDb": -19, "ducking.enabled": true, "ducking.reduceDb": -14 },
      });
      await session.run("essentialSound.generateDucking", { clips: musicClips });
    }

    session.log("info", "audio", "music bed laid and ducked", {
      musicClips: musicClips.length,
      estimatedRuntimeSec: Number(plan.estimatedRuntimeSec.toFixed(2)),
    });
  }

  /* ---------------------------------------------------------------------
   * Phase E — Multimodal verification
   * ------------------------------------------------------------------ */

  /**
   * Render checkpoints, fan them out to the vision auditor concurrently, and
   * aggregate the verdicts.
   */
  private async verify(
    ctx: SessionContext,
    manifest: AssemblyManifest,
    plan: CutPlan,
    ripple: RippleMap,
  ): Promise<{ ok: boolean; audited: number; failures: string[] }> {
    const { session } = ctx;

    /** Checkpoint schedule: one per B-roll shot plus one mid-A-roll per beat. */
    const checkpoints: AuditContext[] = [];

    for (const shot of plan.brollShots) {
      const atSec = ripple.map(shot.sourceStartSec) + shot.durationSec * 0.5;
      const beat = plan.beats[shot.beatIndex];
      checkpoints.push({
        atSec,
        role: "broll",
        expectedLabel: shot.label,
        beatText: beat?.text ?? "",
        cutNeighbours: plan.brollShots.map((s) => ripple.map(s.sourceStartSec)),
      });
    }

    const perMinute = manifest.auditPerMinute;
    const arollSamples = Math.min(
      24,
      Math.max(2, Math.round((plan.estimatedRuntimeSec / 60) * perMinute)),
    );
    for (let i = 0; i < arollSamples; i++) {
      const atSec = (plan.estimatedRuntimeSec * (i + 0.5)) / arollSamples;
      const beat = plan.beats.find(
        (b) => ripple.map(b.start) <= atSec && ripple.map(b.end) >= atSec,
      );
      checkpoints.push({
        atSec,
        role: "aroll",
        beatText: beat?.text ?? "",
        cutNeighbours: plan.brollShots.map((s) => ripple.map(s.sourceStartSec)),
      });
    }

    if (checkpoints.length === 0) {
      return { ok: true, audited: 0, failures: [] };
    }

    // ---- Parallel tool execution ---------------------------------------
    // Every render_frame call is independent: no call mutates the document,
    // so the MCP server can service them concurrently. We cap concurrency at
    // 6 to stay inside the child process's decode budget on shared CI runners.
    const CONCURRENCY = 6;
    const frames: { ctx: AuditContext; png: string }[] = [];

    for (let i = 0; i < checkpoints.length; i += CONCURRENCY) {
      const slice = checkpoints.slice(i, i + CONCURRENCY);
      const rendered = await Promise.all(
        slice.map(async (c) => {
          try {
            const { png } = await session.renderFrame(c.atSec, 960);
            return { ctx: c, png };
          } catch (err) {
            session.log("warn", "verification", "frame render failed", {
              atSec: c.atSec,
              error: err instanceof Error ? err.message : String(err),
            });
            return undefined;
          }
        }),
      );
      for (const r of rendered) if (r) frames.push(r);
    }

    // ---- Vision fan-out (also parallel) --------------------------------
    const verdicts = await Promise.all(
      frames.map(async ({ ctx: c, png }) => {
        try {
          const verdict = await this.auditor.audit(png, c);
          return { c, verdict };
        } catch (err) {
          return {
            c,
            verdict: {
              ok: false,
              reasons: [`auditor error: ${err instanceof Error ? err.message : String(err)}`],
              confidence: 0,
            } as CutVerdict,
          };
        }
      }),
    );

    const failures = verdicts
      .filter((v) => !v.verdict.ok)
      .map(
        (v) =>
          `${v.c.atSec.toFixed(2)}s [${v.c.role}] ${v.verdict.reasons.join(" / ")} ` +
          `(confidence ${v.verdict.confidence.toFixed(2)})`,
      );

    session.log(
      failures.length === 0 ? "info" : "warn",
      "verification",
      "audit complete",
      { audited: verdicts.length, failures: failures.length },
    );

    return { ok: failures.length === 0, audited: verdicts.length, failures };
  }

  /* ---------------------------------------------------------------------
   * Phase F — Export
   * ------------------------------------------------------------------ */

  /** Write the finished sequence as a broadcast H.264 MP4. */
  private async export(
    session: FilmCraftSession,
    manifest: AssemblyManifest,
    plan: CutPlan,
  ): Promise<string> {
    const outDir = join(manifest.writeRoot, "cutroom", manifest.tenant, manifest.jobId);
    await mkdir(outDir, { recursive: true });
    const outputPath = join(outDir, "assembly.mp4");

    // Persist the project so a human editor can pick the job up.
    const projectPath = join(outDir, "assembly.fcproj");
    await session.call("command_run", { id: "file.saveAs", params: { path: projectPath } });

    await session.call("command_run", {
      id: "file.exportMedia",
      params: {
        path: outputPath,
        format: "h264",
        sequence: undefined,
        range: "entire",
        width: manifest.width,
        height: manifest.height,
        fps: manifest.fps,
        bitrateMode: "vbr2Pass",
        bitrateKbps: 16000,
        audio: true,
        wait: true,
      },
    });

    // The manifest and the plan are written alongside the media so the job is
    // fully reproducible and auditable after the fact.
    await writeFile(
      join(outDir, "manifest.json"),
      JSON.stringify(manifest, null, 2),
      "utf8",
    );
    await writeFile(
      join(outDir, "cutplan.json"),
      JSON.stringify(
        {
          coverage: plan.coverage,
          estimatedRuntimeSec: plan.estimatedRuntimeSec,
          silenceWindows: plan.silenceWindows,
          shots: plan.brollShots,
        },
        null,
        2,
      ),
      "utf8",
    );

    // Verify the artefact actually landed. A silent export failure is the
    // single most expensive bug in a render farm.
    const head = await readFile(outputPath).catch(() => undefined);
    if (!head || head.byteLength < 1024) {
      throw new AssemblyPhaseError("export", "exported file is missing or suspiciously small", {
        outputPath,
        bytes: head?.byteLength ?? 0,
      });
    }

    session.log("info", "export", "assembly written", {
      outputPath,
      bytes: head.byteLength,
    });

    return outputPath;
  }
}

/* ===========================================================================
 * SECTION 13 — Job entrypoint (used by the SaaS worker pool)
 * ======================================================================== */

/**
 * Convenience entrypoint: validate, assemble, return. Intended to be called
 * from a queue consumer such as `bullmq` or a Lambda handler.
 *
 * @param rawManifest - Untrusted manifest from the request body.
 * @param binaryPath - Resolved FilmCraft CLI path.
 * @param visionApiKey - OpenAI-compatible key for the auditor.
 */
export async function assembleJob(
  rawManifest: unknown,
  binaryPath: string,
  visionApiKey: string,
): Promise<AssemblyResult> {
  const auditor = new OpenAiVisionAuditor(visionApiKey);
  const worker = new AutonomousAssembler(auditor);
  return worker.run(rawManifest, { binaryPath });
}
