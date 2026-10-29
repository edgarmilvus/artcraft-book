/**
 * @file  filmcraft/filmcraft-mcp.ts
 * @module FilmCraftMCP
 *
 * Thin, strongly-typed wrapper over `filmcraft-cli mcp` speaking the
 * Model Context Protocol over stdio. Manages the child process, the
 * JSON-RPC framing (handled by the SDK), and the semantic schema of the
 * commands the sequencer actually uses.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/* ─── Result types for the FilmCraft commands we call ─────────────── */

export interface SequenceInfo {
  id: number;
  name: string;
  width: number;
  height: number;
  fps: number;         // decimal approximation, for display only
  sampleRate: number;
  tracks: Array<{ id: number; kind: "video" | "audio"; name: string; index: number }>;
  clips: Array<{
    id: number;
    track: number;
    item: number;
    start: bigint;      // ticks
    duration: bigint;   // ticks
    sourceIn: bigint;   // ticks
    name: string;
  }>;
  markers: Array<{ id: number; time: bigint; comment: string }>;
  playhead: bigint;
}

export interface RenderResult {
  /** Path on disk (if a path was requested). */
  path?: string;
  /** Base-64 PNG bytes for inline viewing. */
  dataBase64?: string;
  width: number;
  height: number;
}

/* ─── The client ──────────────────────────────────────────────────── */

export interface FilmCraftMCPOptions {
  /** Extra read roots the CLI is allowed to touch (for `file.import`). */
  readRoots?: string[];
  /** Write roots allowed for `file.exportMedia`. */
  writeRoots?: string[];
  /** Project root used as the working directory of the child process. */
  cwd?: string;
  /** Environment overrides (e.g. binary path, tokens). */
  env?: Record<string, string>;
}

export class FilmCraftMCP {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private connected = false;

  public constructor(opts: FilmCraftMCPOptions = {}) {
    const args = ["mcp"];
    for (const r of opts.readRoots ?? [])  args.push("--automation-read-root", r);
    for (const r of opts.writeRoots ?? []) args.push("--automation-write-root", r);

    this.transport = new StdioClientTransport({
      command: "filmcraft-cli",
      args,
      cwd: opts.cwd,
      env: opts.env,
    });
    this.client = new Client(
      { name: "cloudcut-zero-drift", version: "1.0.0" },
      { capabilities: {} },
    );
  }

  public async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(this.transport);
    this.connected = true;
  }

  public async disconnect(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
  }

  /* ─── Low-level dispatch ─────────────────────────────────────────── */

  /** Unwrap the first text content block returned by an MCP tool call. */
  private static async textOf(res: unknown): Promise<string> {
    const r = res as { content?: Array<{ type: string; text?: string }>; isError?: boolean };
    if (r.isError) {
      const message = r.content?.find((b) => b.type === "text")?.text;
      throw new Error(`MCP tool returned isError: ${message ?? "no message"}`);
    }
    const block = r.content?.find((b) => b.type === "text");
    return block?.text ?? "";
  }

  /**
   * Run a single FilmCraft command and parse its JSON result.
   * @throws If the command returns `{ok:false}` or a parse error.
   */
  public async run<T = unknown>(id: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.connect();
    const res = await this.client.callTool({
      name: "command_run",
      arguments: { id, params },
    });
    const text = await FilmCraftMCP.textOf(res);
    if (!text.trim()) return null as T;
    return JSON.parse(text) as T;
  }

  /**
   * Run several FilmCraft commands in sequence. `command_batch` stops at
   * the first error by default. Each command is its own undo step in the
   * FilmCraft history — the batch is not transactional at the engine
   * level, only stopped early.
   */
  public async batch<T = unknown>(
    steps: Array<{ id: string; params?: Record<string, unknown> }>,
    stopOnError = true,
  ): Promise<{ completed: number; failed: number; results: T[] }> {
    await this.connect();
    const res = await this.client.callTool({
      name: "command_batch",
      arguments: { steps: steps.map((s) => ({ id: s.id, params: s.params ?? {} })), stop_on_error: stopOnError },
    });
    const text = await FilmCraftMCP.textOf(res);
    return JSON.parse(text);
  }

  /* ─── Semantic wrappers for the sequence API ─────────────────────── */

  /** Create an empty sequence. FilmCraft defaults to 1920×1080 @ 23.976. */
  public async newSequence(opts: {
    name: string;
    width: number;
    height: number;
    fps: number;
    sampleRate: number;
    videoTracks?: number;
    audioTracks?: number;
    mix?: "Stereo" | "Mono" | "5.1" | "Adaptive";
  }): Promise<{ sequence: number }> {
    return this.run("file.newSequence", {
      name: opts.name,
      width: opts.width,
      height: opts.height,
      fps: opts.fps,
      sampleRate: opts.sampleRate,
      video: opts.videoTracks ?? 3,
      audio: opts.audioTracks ?? 3,
      mix: opts.mix ?? "Stereo",
    });
  }

  /**
   * Import media files (absolute paths). Returns the project tree so the
   * caller can resolve the new items' IDs by name.
   */
  public async import(paths: string[]): Promise<unknown> {
    return this.run("file.import", { paths });
  }

  /** Open (activate) a sequence as the timeline's active document. */
  public async openSequence(item: number): Promise<unknown> {
    return this.run("sequence.open", { item });
  }

  /**
   * Place a clip in a track. `time` is expressed in ticks. The sequencer
   * never uses the float `seconds` form of this parameter.
   */
  public async placeClip(opts: {
    item: number;
    videoTrack: string;    // "V1", "V2", ... or numeric id
    audioTrack?: string;
    time: bigint;          // ticks
    sourceIn?: bigint;     // ticks
    duration: bigint;      // ticks
    video: boolean;
    audio: boolean;
    insert?: boolean;
  }): Promise<{ clip: number }> {
    const result = await this.run<{ clips?: number[] }>("timeline.place", {
      item: opts.item,
      track: opts.videoTrack,
      audioTrack: opts.audioTrack,
      time: Number(opts.time),
      sourceIn: opts.sourceIn !== undefined ? Number(opts.sourceIn) : undefined,
      duration: Number(opts.duration),
      video: opts.video,
      audio: opts.audio,
      insert: opts.insert ?? false,
    });
    // `timeline.place` answers with the ids of the clips it created.
    return { clip: (result?.clips ?? [])[0] ?? 0 };
  }

  /** Add a hard cut at an exact tick on a given track. */
  public async razor(time: bigint, track?: string, clip?: number): Promise<unknown> {
    const params: Record<string, unknown> = { time: Number(time) };
    if (track) params.track = track;
    if (clip !== undefined) params.clip = clip;
    return this.run("timeline.razor", params);
  }

  /** Trim the head or tail of a clip by an exact tick count. */
  public async trim(
    clip: number,
    edge: "in" | "out",
    deltaTicks: bigint,
    mode: "regular" | "ripple" = "regular",
  ): Promise<unknown> {
    return this.run("timeline.trim", {
      clip, edge, mode, delta: Number(deltaTicks),
    });
  }

  /** Apply a video transition (e.g. `cross_dissolve`) across `frames`. */
  public async applyVideoTransition(clip: number, effect: string, frames: number): Promise<unknown> {
    return this.run("sequence.applyVideoTransition", { clip, effect, frames });
  }

  /** Apply an audio transition (e.g. `constant_power`) across `frames`. */
  public async applyAudioTransition(clip: number, effect: string, frames: number): Promise<unknown> {
    return this.run("sequence.applyAudioTransition", { clip, effect, frames });
  }

  /** Parameter set on a clip's effect at an exact tick (keyframe capable). */
  public async setEffectParam(opts: {
    clip: number;
    effect: string | number;
    param: string;
    value: unknown;
    time: bigint;
    merge?: boolean;
  }): Promise<unknown> {
    return this.run("effects.setParam", {
      clip: opts.clip,
      effect: opts.effect,
      param: opts.param,
      value: opts.value,
      time: Number(opts.time),
      merge: opts.merge ?? true,
    });
  }

  /** Sequence state as JSON, with clips and their tick positions. */
  public async inspectSequence(item?: number): Promise<SequenceInfo> {
    const raw = await this.run<unknown>("sequence.inspect", item !== undefined ? { item } : {});
    return normalizeSequence(raw);
  }

  /** Render a single frame to PNG for multimodal QA. */
  public async renderFrame(opts: { seconds?: number; maxSide?: number }): Promise<RenderResult> {
    await this.connect();
    const res = await this.client.callTool({
      name: "render_frame",
      arguments: { seconds: opts.seconds, max_side: opts.maxSide ?? 960 },
    });
    // render_frame returns an image content block plus a short text note; the
    // dimensions are read from the PNG header rather than from the note.
    const r = res as { content: Array<{ type: string; data?: string; mimeType?: string; text?: string }> };
    const image = r.content.find((b) => b.type === "image");
    const dims = image?.data ? pngSize(Buffer.from(image.data, "base64")) : { width: 0, height: 0 };
    return { dataBase64: image?.data, width: dims.width, height: dims.height };
  }

  /** Write an exported media file, using the write-root confinement. */
  public async exportMedia(opts: {
    path: string;
    format?: string;
    width?: number; height?: number;
    fps?: number;
    preset?: string;
    range?: "entire" | "inOut" | "workArea";
    wait?: boolean;
  }): Promise<{ path: string; bytes: number }> {
    return this.run("file.exportMedia", opts);
  }
}

/* ─── Normalisation of the sequence_inspect payload ──────────────── */

function toBig(v: unknown): bigint {
  if (typeof v === "bigint") return v;
  if (typeof v === "string") return BigInt(v);
  if (typeof v === "number") return BigInt(Math.round(v));
  return 0n;
}

/**
 * Normalise a `sequence.inspect` payload.
 *
 * The engine reports one array per track kind — `video` and `audio` — and
 * each track carries its `items`; the settings carry the frame rate as an
 * exact ratio and the sample rate as an integer.
 */
function normalizeSequence(raw: unknown): SequenceInfo {
  const s = raw as Record<string, unknown>;
  const settings = (s.settings ?? {}) as Record<string, unknown>;
  const frameRate = (settings.frame_rate ?? {}) as { num?: number; den?: number };

  const tracks: SequenceInfo["tracks"] = [];
  const clips: SequenceInfo["clips"] = [];

  const readTrack = (kind: "video" | "audio", list: unknown, index: number): void => {
    for (const track of (list as Array<Record<string, unknown>>) ?? []) {
      const trackId = Number(track.id);
      tracks.push({ id: trackId, kind, name: String(track.name ?? ""), index });
      for (const item of (track.items as Array<Record<string, unknown>>) ?? []) {
        clips.push({
          id: Number(item.clip),
          track: trackId,
          item: Number(item.item),
          start: toBig(item.start),
          duration: toBig(item.duration),
          sourceIn: toBig(item.sourceIn ?? 0),
          name: String(item.name ?? ""),
        });
      }
    }
  };
  readTrack("video", s.video, 0);
  readTrack("audio", s.audio, 1);

  return {
    id: Number(s.id),
    name: String(s.name ?? ""),
    width: Number(settings.width ?? 0),
    height: Number(settings.height ?? 0),
    fps: frameRate.num && frameRate.den ? frameRate.num / frameRate.den : Number(s.fps ?? 0),
    sampleRate: Number(settings.sample_rate ?? 0),
    tracks,
    clips,
    markers: ((s.markers as Array<Record<string, unknown>>) ?? []).map((m) => ({
      id: Number(m.id),
      time: toBig(m.time),
      comment: String(m.comment ?? ""),
    })),
    playhead: toBig(s.playhead ?? 0),
  };
}

/** The width and height of a PNG, read from its IHDR chunk. */
function pngSize(buffer: Buffer): { width: number; height: number } {
  if (buffer.length < 24) return { width: 0, height: 0 };
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

/**
 * The media items of a project tree, flattened.
 *
 * The `project.inspect` command answers with the project object itself — its
 * `root.children` carry the media items — while the `project_inspect` tool
 * wraps the same tree in `{ project: ... }`. The walker accepts both, and the
 * id `timeline.place` wants is the `item`.
 */
export function projectItems(raw: unknown): Array<{ id: number; name: string; type: string }> {
  const out: Array<{ id: number; name: string; type: string }> = [];
  const visit = (node: unknown): void => {
    if (!node || typeof node !== "object") return;
    const n = node as Record<string, unknown>;
    const id = n.item ?? n.id;
    if (typeof id === "number" && typeof n.name === "string") {
      out.push({ id, name: n.name, type: String(n.type ?? "") });
    }
    for (const child of (n.children ?? []) as unknown[]) visit(child);
  };
  const payload = raw as Record<string, unknown>;
  const project = payload?.project as Record<string, unknown> | undefined;
  visit(project?.root ?? payload?.root ?? payload);
  return out;
}
