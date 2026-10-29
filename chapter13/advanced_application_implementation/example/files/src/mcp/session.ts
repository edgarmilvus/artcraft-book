// src/mcp/session.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

/**
 * Thin wrapper around the SDK client that exposes FilmCraft's meta-tools
 * as strongly-typed methods. The wrapper owns the transport lifetime so
 * the orchestrator only ever talks to this class, never to the SDK.
 */
export interface FilmCraftSessionOptions {
  binary: string;               // e.g. "filmcraft-cli"
  readRoots: string[];          // automation read sandbox
  writeRoots: string[];         // automation write sandbox
  clientName: string;
  clientVersion: string;
}

/**
 * Result of any command_run invocation. FilmCraft returns `{ok, result |
 * error}` for a single run, but the MCP transport wraps that in a content
 * array, so we unwrap once here and never again downstream.
 */
export type CommandResult<T> =
  | { ok: true;  result: T }
  | { ok: false; error: string };

export class FilmCraftSession {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private connected = false;

  constructor(private readonly opts: FilmCraftSessionOptions) {
    const args = ["mcp"];
    for (const root of opts.readRoots)  args.push("--automation-read-root", root);
    for (const root of opts.writeRoots) args.push("--automation-write-root", root);

    this.transport = new StdioClientTransport({
      command: opts.binary,
      args,
      env: { ...(process.env as Record<string, string>) },
    });

    this.client = new Client(
      { name: opts.clientName, version: opts.clientVersion },
      { capabilities: {} },
    );
  }

  /** Establish the stdio handshake. Idempotent. */
  public async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(this.transport);
    this.connected = true;
  }

  /** Terminate the stdio pipe. Safe to call twice. */
  public async close(): Promise<void> {
    if (!this.connected) return;
    await this.client.close();
    this.connected = false;
  }

  /**
   * Execute one engine command. The `id` must be a registry id discovered
   * via `listCommands`; we never trust caller-provided ids from outside
   * the typed façade.
   */
  public async run<T = unknown>(
    id: string,
    params: Record<string, unknown> = {},
  ): Promise<CommandResult<T>> {
    const reply = await this.client.callTool({
      name: "command_run",
      arguments: { id, params },
    });
    return this.decode<T>(reply);
  }

  /**
   * Execute several commands in order. On FilmCraft this is NOT an atomic
   * transaction: earlier successful steps stay applied. The orchestrator
   * therefore relies on history.undo for rollback safety.
   */
  public async batch<T = unknown>(
    steps: Array<{ id: string; params: Record<string, unknown> }>,
    stopOnError = true,
  ): Promise<Array<CommandResult<T>>> {
    const reply = await this.client.callTool({
      name: "command_batch",
      arguments: { steps, stop_on_error: stopOnError },
    });
    const payload = this.unwrap<{
      completed: number;
      failed: number;
      results: Array<{ ok: boolean; result?: T; error?: string }>;
    }>(reply);
    return payload.results.map((r) =>
      r.ok
        ? ({ ok: true,  result: r.result as T })
        : ({ ok: false, error: r.error ?? "unknown error" }),
    );
  }

  /** Enumerate the engine registry with a filter. */
  public async listCommands(filter?: string): Promise<RegistryEntry[]> {
    const reply = await this.client.callTool({
      name: "command_list",
      arguments: filter ? { filter } : {},
    });
    return this.unwrap<RegistryEntry[]>(reply);
  }

  /** Inspect the project tree: bins, media items and their names. */
  public async projectInspect(): Promise<ProjectSnapshot> {
    const reply = await this.client.callTool({
      name: "project_inspect",
      arguments: {},
    });
    return this.unwrap<ProjectSnapshot>(reply);
  }

  /** Inspect the active sequence: tracks, clips, transitions, markers. */
  public async sequenceInspect(): Promise<SequenceSnapshot> {
    const reply = await this.client.callTool({
      name: "sequence_inspect",
      arguments: {},
    });
    return this.unwrap<SequenceSnapshot>(reply);
  }

  /** Render the current program monitor frame as PNG bytes. */
  public async renderFrame(seconds?: number, maxSide?: number): Promise<string> {
    const args: Record<string, unknown> = {};
    if (typeof seconds === "number") args.seconds = seconds;
    if (typeof maxSide === "number") args.max_side = maxSide;
    const reply = await this.client.callTool({
      name: "render_frame",
      arguments: args,
    });
    // MCP returns a content array; the first image block carries base64.
    const content = (reply as { content: Array<{ type: string; data?: string }> }).content;
    const image = content.find((c) => c.type === "image");
    if (!image?.data) throw new Error("filmcraft: render_frame returned no image");
    return image.data;
  }

  // -----------------------------------------------------------------
  // Internal decoding helpers. The SDK returns a loose shape; we coerce
  // it in exactly one place so no `any` escapes into the service layer.
  // -----------------------------------------------------------------

  private unwrap<T>(reply: unknown): T {
    const r = reply as { content?: Array<{ type: string; text?: string }> };
    const text = r.content?.find((c) => c.type === "text")?.text;
    if (typeof text !== "string") {
      throw new Error("filmcraft: MCP reply had no text content");
    }
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const err = (parsed as { error: unknown }).error;
      throw new Error(`filmcraft: ${String(err)}`);
    }
    return parsed as T;
  }

  private decode<T>(reply: unknown): CommandResult<T> {
    try {
      const value = this.unwrap<T>(reply);
      return { ok: true, result: value };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }
}

/** Minimal registry entry shape we care about for grading dispatch. */
export interface RegistryEntry {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly params: string;
  readonly shortcut: string | null;
}

/**
 * Subset of sequence_inspect we depend on.
 *
 * The inspector reports one array per track kind — `video` and `audio` — and
 * every track carries its `items`. A clip is identified by `clip`, and its
 * position and length are `start` and `duration`, both in ticks. The frame
 * rate is an exact ratio under `settings.frame_rate`.
 */
export interface SequenceSnapshot {
  readonly id: number;
  readonly name: string;
  readonly video: ReadonlyArray<TrackSnapshot>;
  readonly audio: ReadonlyArray<TrackSnapshot>;
  readonly settings: {
    readonly frame_rate: { readonly num: number; readonly den: number };
    readonly sample_rate: number;
    readonly width: number;
    readonly height: number;
  };
  readonly markers: ReadonlyArray<MarkerSnapshot>;
  readonly playhead: number | null;
}

export interface TrackSnapshot {
  readonly id: number;
  /** The engine's own label: "Video 1", "Audio 2". */
  readonly name: string;
  readonly items: ReadonlyArray<ClipSnapshot>;
}

export interface ClipSnapshot {
  /** The clip id the commands want. */
  readonly clip: number;
  readonly start: number;
  readonly duration: number;
  readonly item?: number;
  readonly name?: string;
  /** The effects on the clip, with the value of every parameter. */
  readonly effects?: ReadonlyArray<{
    readonly effect: string;
    readonly enabled: boolean;
    readonly params?: Record<string, { readonly value?: unknown; readonly keyframes?: number }>;
  }>;
}

/** The project tree: the media items hang under `root.children`. */
export interface ProjectSnapshot {
  readonly root?: {
    readonly children?: ReadonlyArray<{
      readonly id?: number;
      readonly item?: number;
      readonly name?: string;
      readonly type?: string;
      readonly children?: ReadonlyArray<unknown>;
    }>;
  };
  readonly items?: ReadonlyArray<{ readonly id?: number; readonly item?: number; readonly name?: string }>;
}

export interface MarkerSnapshot {
  readonly id: number;
  readonly name: string;
  readonly start: number;
  readonly comment?: string;
  readonly color?: string;
}

/**
 * The short alias the engine commands use for a track label.
 *
 * The inspector reports "Video 1" and "Audio 2"; `timeline.place` and the
 * mixer commands want "V1" and "A2".
 */
export function trackAlias(name: string): string {
  const parts = name.trim().split(/\s+/);
  if (parts.length === 2 && /^(video|audio|caption)$/i.test(parts[0] ?? "") && /^\d+$/.test(parts[1] ?? "")) {
    const prefix = (parts[0] ?? "").toLowerCase() === "video" ? "V" : (parts[0] ?? "").toLowerCase() === "audio" ? "A" : "C";
    return prefix + parts[1];
  }
  return name;
}

/** The clips of the video or audio track with the given alias ("V1", "A2", ...). */
export function clipsOnTrack(
  snapshot: SequenceSnapshot,
  alias: string,
): ReadonlyArray<ClipSnapshot> {
  const tracks = alias.startsWith("V") ? snapshot.video : snapshot.audio;
  for (const track of tracks) {
    if (trackAlias(track.name) === alias) return track.items;
  }
  return [];
}

/** The frame rate of a sequence, as a float. */
export function sequenceFps(snapshot: SequenceSnapshot): number {
  const rate = snapshot.settings?.frame_rate ?? { num: 24, den: 1 };
  return rate.den === 0 ? 24 : rate.num / rate.den;
}
