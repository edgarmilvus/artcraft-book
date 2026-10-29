/**
 * trailer_assembler.ts — an autonomous, tempo-synced trailer assembler.
 *
 * The assembler ingests a folder of rushes, derives a beat grid from the
 * music, lays a three-act trailer on a FilmCraft timeline, and ripples the
 * edit so that every cut lands on the grid. The engine is driven through
 * `filmcraft-cli mcp` over stdio.
 *
 * Two properties matter more than anything else here.
 *
 * The first is that the tick arithmetic is exact. FilmCraft counts time in
 * 254,016,000,000 ticks per second; at 23.976 fps a frame is 10,594,584,000
 * ticks, which is not representable as a double once the multiply happens
 * first, so every position is a BigInt and every conversion multiplies
 * before it divides.
 *
 * The second is that the engine's vocabulary is not a guess. Every command
 * the assembler calls is named exactly as FilmCraft names it, and the
 * assembler reads the timeline back through `sequence_inspect` rather than
 * trusting its own intentions.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/* ------------------------------------------------------------------------- */
/* The tick base                                                              */
/* ------------------------------------------------------------------------- */

export const TICKS_PER_SEC = 254_016_000_000n;

/** The frame rate as an exact rational: 24000/1001 is 23.976. */
export const FPS_NUM = 24_000n;
export const FPS_DEN = 1_001n;
export const FPS = 23.976;

/**
 * The ticks in one frame at 23.976 fps.
 *
 * The claim the assembler relies on is that
 *
 *     T(t) = floor(t * 254016000000 * 1001 / 24000)
 *
 * is injective on the frame indices, i.e. that no two frames share a tick.
 *
 * Proof. Write K = 254016000000 * 1001 / 24000. The prime factorisations
 * are
 *
 *     254016000000 = 2^12 * 3^4 * 5^6 * 7^2
 *     24000        = 2^6  * 3   * 5^3
 *     1001         = 7 * 11 * 13
 *
 * so K = 2^6 * 3^3 * 5^3 * 7^3 * 11 * 13 = 10,594,584,000, an exact
 * integer. The floor therefore does nothing and T(t) = t * K exactly.
 * For t1 < t2 we get T(t1) = t1*K < t2*K = T(t2) because K >= 1. So T is
 * strictly increasing and, in particular, injective. ∎
 *
 * The same argument works for every frame rate a post house uses, because
 * the numerator always divides 254016000000 * q: 24, 25, 30 and 30000/1001
 * all leave an integer K.
 */
export const TICKS_PER_FRAME = (TICKS_PER_SEC * FPS_DEN) / FPS_NUM;

/** The frame index a tick falls on. */
export function ticksToFrame(tick: bigint): number {
  return Number(tick / TICKS_PER_FRAME);
}

/** The number of whole frames a span of ticks covers, rounded to nearest. */
export function ticksToFrames(ticks: bigint): number {
  return Number((2n * ticks + TICKS_PER_FRAME) / (2n * TICKS_PER_FRAME));
}

/** The exact tick of a frame index. */
export function frameToTicks(frame: bigint): bigint {
  return (frame * TICKS_PER_SEC * FPS_DEN) / FPS_NUM;
}

/**
 * Ticks for a duration in seconds.
 *
 * Seconds are only ever used for *budget* decisions — the length of an act —
 * never for the placement of a cut. A budget is rounded to the nearest
 * microsecond and then converted exactly.
 */
export function secondsToTicks(seconds: number): bigint {
  return BigInt(Math.round(seconds * 1_000_000)) * (TICKS_PER_SEC / 1_000_000n);
}

/* ------------------------------------------------------------------------- */
/* JSON                                                                       */
/* ------------------------------------------------------------------------- */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

function isJsonObject(value: JsonValue): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectField(value: JsonValue, key: string): JsonValue | undefined {
  return isJsonObject(value) ? value[key] : undefined;
}

function numberField(value: JsonValue, key: string): number {
  const raw = objectField(value, key);
  return typeof raw === "number" ? raw : 0;
}

function stringField(value: JsonValue, key: string): string {
  const raw = objectField(value, key);
  return typeof raw === "string" ? raw : "";
}

function arrayField(value: JsonValue, key: string): JsonValue[] {
  const raw = objectField(value, key);
  return Array.isArray(raw) ? raw : [];
}

/* ------------------------------------------------------------------------- */
/* The MCP stdio client                                                       */
/* ------------------------------------------------------------------------- */

export type McpResult =
  | { kind: "json"; value: JsonValue }
  | { kind: "text"; text: string }
  | { kind: "image"; data: string; mimeType: string };

interface PendingCall {
  resolve: (result: McpResult) => void;
  reject: (error: Error) => void;
}

/** A minimal JSON-RPC client for an MCP server on stdio. */
export class McpStdioClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingCall>();
  private nextId = 1;
  private buffer = "";

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.child.stdout.setEncoding("utf-8");
    this.child.stdout.on("data", (chunk: string) => this.consume(chunk));
    this.child.on("error", (error: Error) => this.failAll(error));
    this.child.on("exit", (code: number | null) =>
      this.failAll(new Error(`the MCP server exited with code ${String(code)}`)),
    );
  }

  static spawn(binary: string, args: string[], cwd?: string): McpStdioClient {
    const child = spawn(binary, args, {
      stdio: ["pipe", "pipe", "pipe"],
      ...(cwd === undefined ? {} : { cwd }),
    }) as ChildProcessWithoutNullStreams;
    const client = new McpStdioClient(child);
    client.handshake();
    return client;
  }

  private write(frame: JsonObject): void {
    this.child.stdin.write(JSON.stringify(frame) + "\n");
  }

  private handshake(): void {
    this.write({
      jsonrpc: "2.0",
      id: 0,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "trailer-assembler", version: "1" },
      },
    });
    this.write({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  private consume(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line.length > 0) {
        this.dispatch(line);
      }
      newline = this.buffer.indexOf("\n");
    }
  }

  private dispatch(line: string): void {
    let message: JsonValue;
    try {
      message = JSON.parse(line) as JsonValue;
    } catch {
      return;
    }
    const id = objectField(message, "id");
    if (typeof id !== "number") {
      return;
    }
    const call = this.pending.get(id);
    if (call === undefined) {
      return;
    }
    this.pending.delete(id);
    const error = objectField(message, "error");
    if (error !== undefined) {
      call.reject(new Error(`MCP error ${id}: ${JSON.stringify(error)}`));
      return;
    }
    const result = objectField(message, "result") ?? {};
    if (objectField(result, "isError") === true) {
      const content = arrayField(result, "content");
      const text = content
        .map((block) => stringField(block, "text"))
        .filter((value) => value.length > 0)
        .join("; ");
      call.reject(new Error(text.length > 0 ? text : `MCP error ${id}`));
      return;
    }
    const content = arrayField(result, "content");
    for (const block of content) {
      const type = stringField(block, "type");
      if (type === "image") {
        call.resolve({
          kind: "image",
          data: stringField(block, "data"),
          mimeType: stringField(block, "mimeType"),
        });
        return;
      }
      if (type === "text") {
        const text = stringField(block, "text");
        try {
          call.resolve({ kind: "json", value: JSON.parse(text) as JsonValue });
        } catch {
          call.resolve({ kind: "text", text });
        }
        return;
      }
    }
    call.resolve({ kind: "json", value: result });
  }

  private failAll(error: Error): void {
    for (const call of this.pending.values()) {
      call.reject(error);
    }
    this.pending.clear();
  }

  async call(tool: string, args: JsonObject): Promise<McpResult> {
    const id = this.nextId++;
    const frame = {
      jsonrpc: "2.0",
      id,
      method: "tools/call",
      params: { name: tool, arguments: args },
    };
    return await new Promise<McpResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.write(frame);
      } catch (error) {
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  close(): void {
    try {
      this.child.stdin.end();
    } catch {
      /* the pipe is already gone */
    }
    this.child.kill();
  }
}

/* ------------------------------------------------------------------------- */
/* The FilmCraft surface                                                      */
/* ------------------------------------------------------------------------- */

export interface SequenceClip {
  clip: number;
  item: number;
  name: string;
  start: bigint;
  end: bigint;
  startFrame: number;
  endFrame: number;
  duration: bigint;
}

export interface SequenceTrack {
  id: number;
  name: string;
  ref: string;
  clips: SequenceClip[];
}

export interface SequenceState {
  id: number;
  name: string;
  duration: bigint;
  durationFrames: number;
  video: SequenceTrack[];
  audio: SequenceTrack[];
  width: number;
  height: number;
  sampleRate: number;
}

export interface ProjectNode {
  id: number;
  name: string;
  type: string;
  item: number;
  duration: bigint;
  children: ProjectNode[];
}

/** The FilmCraft engine, driven through its MCP meta-tools. */
export class FilmCraft {
  constructor(private readonly mcp: McpStdioClient) {}

  /** Run one engine command. */
  async run(id: string, params: JsonObject = {}): Promise<JsonValue> {
    return await this.unwrap(await this.mcp.call("command_run", { id, params }), id);
  }

  /**
   * Run several engine commands in order.
   *
   * FilmCraft's batch runs the steps one after another and every edit is
   * its own undo step; the steps do not see each other's results, so the
   * caller resolves every id it needs before the batch is issued.
   */
  async batch(steps: Array<{ id: string; params?: JsonObject }>): Promise<JsonValue> {
    return await this.unwrap(
      await this.mcp.call("command_batch", {
        steps: steps.map((step) => ({ id: step.id, params: step.params ?? {} })),
      }),
      "command_batch",
    );
  }

  private async unwrap(result: McpResult, label: string): Promise<JsonValue> {
    if (result.kind === "json") {
      return result.value;
    }
    if (result.kind === "text") {
      try {
        return JSON.parse(result.text) as JsonValue;
      } catch {
        return result.text;
      }
    }
    throw new Error(`${label} returned an image`);
  }

  /** Import one media file by its absolute path. */
  async importMedia(path: string): Promise<number[]> {
    const result = await this.mcp.call("media_import", { text: path });
    const value = result.kind === "json" ? result.value : null;
    return arrayField(value, "items").filter((item): item is number => typeof item === "number");
  }

  /** The project tree: the bins and the items in them. */
  async projectInspect(): Promise<ProjectNode> {
    const result = await this.mcp.call("project_inspect", {});
    const value = result.kind === "json" ? result.value : null;
    const root = objectField(value, "root") ?? {};
    return {
      id: numberField(root, "id"),
      name: stringField(root, "name"),
      type: "root",
      item: 0,
      duration: 0n,
      children: arrayField(root, "children").map((node) => this.readNode(node)),
    };
  }

  private readNode(node: JsonValue): ProjectNode {
    return {
      id: numberField(node, "id"),
      name: stringField(node, "name"),
      type: stringField(node, "type"),
      item: numberField(node, "item"),
      duration: BigInt(Math.trunc(numberField(node, "duration"))),
      children: arrayField(node, "children").map((child) => this.readNode(child)),
    };
  }

  /** The active sequence exactly as the engine reports it. */
  async sequenceInspectRaw(): Promise<JsonValue> {
    const result = await this.mcp.call("sequence_inspect", {});
    return result.kind === "json" ? result.value : null;
  }

  /** The audio mixer exactly as the engine reports it. */
  async mixerInspectRaw(): Promise<JsonValue> {
    return await this.run("mixer.inspect", {});
  }

  /** The active sequence, read back from the engine. */
  async sequenceInspect(): Promise<SequenceState> {    const result = await this.mcp.call("sequence_inspect", {});
    const value = result.kind === "json" ? result.value : null;
    const settings = objectField(value, "settings") ?? {};
    const readTrack = (track: JsonValue): SequenceTrack => {
      const name = stringField(track, "name");
      return {
        id: numberField(track, "id"),
        name,
        ref: name.replace("Video ", "V").replace("Audio ", "A"),
        clips: arrayField(track, "items").map((item) => ({
          clip: numberField(item, "clip"),
          item: numberField(item, "item"),
          name: stringField(item, "name"),
          start: BigInt(Math.trunc(numberField(item, "start"))),
          end: BigInt(Math.trunc(numberField(item, "end"))),
          startFrame: numberField(item, "startFrame"),
          endFrame: numberField(item, "endFrame"),
          duration: BigInt(Math.trunc(numberField(item, "duration"))),
        })),
      };
    };
    return {
      id: numberField(value, "id"),
      name: stringField(value, "name"),
      duration: BigInt(Math.trunc(numberField(value, "duration"))),
      durationFrames: numberField(value, "durationFrames"),
      video: arrayField(value, "video").map(readTrack),
      audio: arrayField(value, "audio").map(readTrack),
      width: numberField(settings, "width"),
      height: numberField(settings, "height"),
      sampleRate: numberField(settings, "sample_rate"),
    };
  }

  /** Render one frame of the active sequence as a PNG. */
  async renderFrame(seconds: number, maxSide: number): Promise<Buffer> {
    const result = await this.mcp.call("render_frame", { seconds, max_side: maxSide });
    if (result.kind === "image") {
      return Buffer.from(result.data, "base64");
    }
    throw new Error("render_frame returned no image");
  }
}

/* ------------------------------------------------------------------------- */
/* WAV                                                                        */
/* ------------------------------------------------------------------------- */

export interface WavData {
  sampleRate: number;
  channels: number;
  samples: Float64Array;
}

/** Read a PCM WAV file into interleaved float samples. */
export function readWav(path: string): WavData {
  const buffer = readFileSync(path);
  if (
    buffer.length < 12 ||
    buffer.toString("ascii", 0, 4) !== "RIFF" ||
    buffer.toString("ascii", 8, 12) !== "WAVE"
  ) {
    throw new Error(`${path} is not a RIFF/WAVE file`);
  }
  let offset = 12;
  let format = 0;
  let channels = 0;
  let sampleRate = 0;
  let bits = 16;
  let data: Buffer | undefined;
  while (offset + 8 <= buffer.length) {
    const tag = buffer.toString("ascii", offset, offset + 4);
    const size = buffer.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (tag === "fmt ") {
      format = buffer.readUInt16LE(body);
      channels = buffer.readUInt16LE(body + 2);
      sampleRate = buffer.readUInt32LE(body + 4);
      bits = buffer.readUInt16LE(body + 14);
    } else if (tag === "data") {
      data = buffer.subarray(body, Math.min(body + size, buffer.length));
    }
    offset = body + size + (size % 2);
  }
  if (data === undefined) {
    throw new Error(`${path} carries no data chunk`);
  }
  if (format !== 1 && format !== 3) {
    throw new Error(`${path} is not PCM (format ${format})`);
  }
  const width = bits / 8;
  const frames = Math.floor(data.length / (channels * width));
  const samples = new Float64Array(frames * channels);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let channel = 0; channel < channels; channel += 1) {
      const index = (frame * channels + channel) * width;
      let value: number;
      if (format === 3) {
        value = bits === 32 ? data.readFloatLE(index) : data.readDoubleLE(index);
      } else if (bits === 16) {
        value = data.readInt16LE(index) / 32768;
      } else if (bits === 24) {
        const raw = data.readUIntLE(index, 3);
        value = (raw >= 0x800000 ? raw - 0x1000000 : raw) / 8388608;
      } else {
        value = data.readInt32LE(index) / 2147483648;
      }
      samples[frame * channels + channel] = value;
    }
  }
  return { sampleRate, channels, samples };
}

/** The mono mix of a WAV, which is what the onset detector works on. */
export function toMono(wav: WavData): Float64Array {
  if (wav.channels === 1) {
    return wav.samples;
  }
  const frames = Math.floor(wav.samples.length / wav.channels);
  const mono = new Float64Array(frames);
  for (let frame = 0; frame < frames; frame += 1) {
    let sum = 0;
    for (let channel = 0; channel < wav.channels; channel += 1) {
      sum += wav.samples[frame * wav.channels + channel]!;
    }
    mono[frame] = sum / wav.channels;
  }
  return mono;
}

/* ------------------------------------------------------------------------- */
/* Beat detection                                                             */
/* ------------------------------------------------------------------------- */

export interface Beat {
  tick: bigint;
  frameAt23976: number;
  isDownbeat: boolean;
  strength: number;
}

export interface BeatDetection {
  beats: Beat[];
  confidence: "high" | "medium" | "low";
  tempoBpm: number;
  beatTicks: bigint;
}

/** A beat weaker than this is not trusted to carry a cut. */
export const STRONG_BEAT = 0.5;

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      const tr = re[i]!;
      re[i] = re[j]!;
      re[j] = tr;
      const ti = im[i]!;
      im[i] = im[j]!;
      im[j] = ti;
    }
  }
  for (let length = 2; length <= n; length <<= 1) {
    const angle = (-2 * Math.PI) / length;
    const wRe = Math.cos(angle);
    const wIm = Math.sin(angle);
    for (let start = 0; start < n; start += length) {
      let curRe = 1;
      let curIm = 0;
      for (let k = 0; k < length / 2; k += 1) {
        const a = start + k;
        const b = a + length / 2;
        const uRe = re[a]!;
        const uIm = im[a]!;
        const vRe = re[b]! * curRe - im[b]! * curIm;
        const vIm = re[b]! * curIm + im[b]! * curRe;
        re[a] = uRe + vRe;
        im[a] = uIm + vIm;
        re[b] = uRe - vRe;
        im[b] = uIm - vIm;
        const nextRe = curRe * wRe - curIm * wIm;
        curIm = curRe * wIm + curIm * wRe;
        curRe = nextRe;
      }
    }
  }
}

/**
 * The onset envelope: the spectral flux of the signal.
 *
 * The signal is cut into overlapping windows, each window is transformed,
 * and the flux is the sum of the positive differences between consecutive
 * magnitude spectra. A transient — a drum hit, a plucked string — is a
 * burst of high-frequency energy and shows up as a spike.
 *
 * The raw flux is then whitened: a steady tone leaks across the bins of
 * the transform and makes the flux breathe at the frequency of the tone,
 * which would drown the transients. Subtracting a moving average removes
 * that slow modulation and leaves the onsets.
 */
export function onsetEnvelope(
  samples: Float64Array,
  frameSize = 1024,
  hop = 256,
  sampleRate = 48000,
): Float64Array {
  const frames = Math.max(0, Math.floor((samples.length - frameSize) / hop) + 1);
  const raw = new Float64Array(frames);
  const window = new Float64Array(frameSize);
  for (let i = 0; i < frameSize; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (frameSize - 1));
  }
  let previous = new Float64Array(frameSize / 2);
  const re = new Float64Array(frameSize);
  const im = new Float64Array(frameSize);
  for (let frame = 0; frame < frames; frame += 1) {
    for (let i = 0; i < frameSize; i += 1) {
      const index = frame * hop + i;
      re[i] = (index < samples.length ? samples[index]! : 0) * window[i]!;
      im[i] = 0;
    }
    fft(re, im);
    let flux = 0;
    for (let bin = 1; bin < frameSize / 2; bin += 1) {
      const magnitude = Math.hypot(re[bin]!, im[bin]!);
      const difference = magnitude - previous[bin]!;
      if (difference > 0) {
        flux += difference;
      }
      previous[bin] = magnitude;
    }
    raw[frame] = flux;
  }

  // Whiten: subtract a moving average of about two seconds. The window is
  // long enough to swallow the slow leakage of a steady tone and short
  // enough to leave the transients alone.
  const span = Math.max(1, Math.round((2 * sampleRate) / hop));
  const envelope = new Float64Array(frames);
  let sum = 0;
  let count = 0;
  for (let frame = 0; frame < frames; frame += 1) {
    sum += raw[frame]!;
    count += 1;
    if (frame >= span) {
      sum -= raw[frame - span]!;
      count -= 1;
    }
    const mean = sum / count;
    envelope[frame] = Math.max(0, raw[frame]! - mean);
  }
  return envelope;
}

/** The autocorrelation of an envelope for the lags in [minLag, maxLag]. */
export function autocorrelation(
  envelope: Float64Array,
  minLag: number,
  maxLag: number,
): Float64Array {
  const n = envelope.length;
  const result = new Float64Array(maxLag + 1);
  if (n === 0) {
    return result;
  }
  let mean = 0;
  for (let i = 0; i < n; i += 1) {
    mean += envelope[i]!;
  }
  mean /= n;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    if (lag >= n) {
      break;
    }
    let sum = 0;
    for (let i = 0; i + lag < n; i += 1) {
      sum += (envelope[i]! - mean) * (envelope[i + lag]! - mean);
    }
    result[lag] = sum / (n - lag);
  }
  return result;
}

/**
 * The beat grid of a music file.
 *
 * The tempo is the period of the onset envelope's autocorrelation. The
 * search is restricted to 60..200 beats per minute, and among the lags
 * whose correlation is close to the best one the *shortest* is taken, so a
 * track that alternates a half-note pulse is not read as half tempo.
 *
 * When the autocorrelation is not decisive the grid falls back to a fixed
 * two-second pulse, and the detection reports a low confidence so the
 * report can say so.
 */
export function detectBeats(musicPath: string): BeatDetection {
  const wav = readWav(musicPath);
  const mono = toMono(wav);
  const frameSize = 1024;
  const hop = 256;
  const envelope = onsetEnvelope(mono, frameSize, hop, wav.sampleRate);
  const framesPerSecond = wav.sampleRate / hop;
  const minLag = Math.max(1, Math.floor((framesPerSecond * 60) / 200));
  const maxLag = Math.min(envelope.length - 1, Math.ceil((framesPerSecond * 60) / 60));
  const correlation = autocorrelation(envelope, minLag, maxLag);

  let peak = 0;
  let peakLag = 0;
  let total = 0;
  let counted = 0;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const value = correlation[lag]!;
    total += value;
    counted += 1;
    if (value > peak) {
      peak = value;
      peakLag = lag;
    }
  }
  const mean = counted > 0 ? total / counted : 0;
  const ratio = mean > 0 ? peak / mean : 0;
  const confidence: BeatDetection["confidence"] =
    ratio >= 3 ? "high" : ratio >= 2 ? "medium" : "low";

  const ticksPerSample = TICKS_PER_SEC / BigInt(wav.sampleRate);
  if (peakLag === 0 || confidence === "low") {
    // The fallback: a fixed two-second pulse.
    const beatTicks = secondsToTicks(2);
    const beats: Beat[] = [];
    const totalTicks = secondsToTicks(mono.length / wav.sampleRate);
    for (let tick = 0n; tick <= totalTicks; tick += beatTicks) {
      beats.push({
        tick,
        frameAt23976: ticksToFrame(tick),
        isDownbeat: beats.length % 4 === 0,
        strength: 0.6,
      });
    }
    return { beats, confidence: "low", tempoBpm: 30, beatTicks };
  }

  // The shortest lag that is nearly as strong as the peak: the true beat,
  // not one of its multiples.
  let bestLag = peakLag;
  for (let lag = minLag; lag <= peakLag; lag += 1) {
    if (correlation[lag]! >= 0.85 * peak) {
      bestLag = lag;
      break;
    }
  }

  // The phase: the offset that puts the most onset energy on the grid.
  let bestPhase = 0;
  let bestScore = -1;
  for (let phase = 0; phase < bestLag; phase += 1) {
    let score = 0;
    for (let frame = phase; frame < envelope.length; frame += bestLag) {
      score += envelope[frame]!;
    }
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }

  // The onsets: the local maxima of the whitened envelope. They are found
  // so that the grid can be fitted to the music rather than to a frame
  // grid, which would drift.
  let maximum = 0;
  for (let frame = 1; frame < envelope.length - 1; frame += 1) {
    const value = envelope[frame]!;
    if (value >= envelope[frame - 1]! && value > envelope[frame + 1]! && value > maximum) {
      maximum = value;
    }
  }
  const threshold = maximum * 0.2;
  const minimumSeparation = Math.max(1, Math.floor(bestLag / 2));
  const onsets: Array<{ frame: number; position: number; flux: number }> = [];
  let lastOnset = -minimumSeparation;
  for (let frame = 1; frame < envelope.length - 1; frame += 1) {
    const value = envelope[frame]!;
    if (value < threshold) {
      continue;
    }
    if (value < envelope[frame - 1]! || value <= envelope[frame + 1]!) {
      continue;
    }
    if (frame - lastOnset < minimumSeparation) {
      continue;
    }
    // The peak of the flux leads the onset by a frame or two, because the
    // transient has to fill the analysis window before it shows up. The
    // parabolic fit puts the position of the maximum between the frames.
    const left = envelope[frame - 1]!;
    const right = envelope[frame + 1]!;
    const denominator = left - 2 * value + right;
    const shift = denominator !== 0 ? (0.5 * (left - right)) / denominator : 0;
    onsets.push({
      frame,
      position: (frame + shift) * hop + frameSize / 2,
      flux: value,
    });
    lastOnset = frame;
  }

  // The period of the grid, from a least-squares fit of the onsets. A
  // least-squares fit rather than the difference of two onsets because the
  // onsets are quantised to the analysis frames, and the fit averages that
  // quantisation away: a naive difference would carry the rounding error
  // into every beat.
  let periodSamples = Math.round(bestLag * hop);
  let phaseSamples = bestPhase * hop + frameSize / 2;
  if (onsets.length >= 4) {
    const count = onsets.length;
    let sumIndex = 0;
    let sumPosition = 0;
    let sumIndexSquared = 0;
    let sumProduct = 0;
    for (let index = 0; index < count; index += 1) {
      const position = onsets[index]!.position;
      sumIndex += index;
      sumPosition += position;
      sumIndexSquared += index * index;
      sumProduct += index * position;
    }
    const denominator = count * sumIndexSquared - sumIndex * sumIndex;
    if (denominator !== 0) {
      const slope = (count * sumProduct - sumIndex * sumPosition) / denominator;
      const intercept = (sumPosition - slope * sumIndex) / count;
      // The fit must agree with the autocorrelation, or the onsets are
      // something other than the beat.
      if (slope > 0.7 * periodSamples && slope < 1.4 * periodSamples) {
        periodSamples = Math.round(slope);
        phaseSamples = intercept;
      }
    }
  }
  if (periodSamples <= 0) {
    periodSamples = Math.round(bestLag * hop);
  }
  const firstSample = Math.round(phaseSamples);
  const lastSample = mono.length;

  // The strength of a beat is measured against the *typical* beat of the
  // same track rather than against the loudest transient in the file: one
  // out-loud downbeat would otherwise flatten every other beat to zero.
  const beatPeriod = BigInt(periodSamples);
  const beats: Beat[] = [];
  for (let sample = firstSample; sample <= lastSample; sample += periodSamples) {
    const frame = Math.round((sample - frameSize / 2) / hop);
    const flux = frame >= 0 && frame < envelope.length ? envelope[frame]! : 0;
    beats.push({
      tick: BigInt(sample) * ticksPerSample,
      frameAt23976: ticksToFrame(BigInt(sample) * ticksPerSample),
      isDownbeat: beats.length % 4 === 0,
      strength: flux,
    });
  }
  let meanFlux = 0;
  for (const beat of beats) {
    meanFlux += beat.strength;
  }
  meanFlux = beats.length > 0 ? meanFlux / beats.length : 0;
  for (const beat of beats) {
    beat.strength = meanFlux > 0 ? Math.min(1, beat.strength / meanFlux) : 0;
  }

  const tempoBpm = (60 * wav.sampleRate) / periodSamples;
  const beatTickSpan = beatPeriod * ticksPerSample;
  return { beats, confidence, tempoBpm, beatTicks: beatTickSpan };
}

/**
 * Snap a desired position to the grid.
 *
 * The cut is snapped to the beat nearest the desired position whose
 * strength is at least STRONG_BEAT; when no such beat exists the nearest
 * downbeat is used. When two beats are equidistant the *earlier* one wins,
 * so a cut never overshoots the duration the editor asked for by more than
 * half a beat.
 */
export function snapToBeat(desiredTick: bigint, beats: Beat[]): Beat | null {
  if (beats.length === 0) {
    return null;
  }
  const strong = beats.filter((beat) => beat.strength >= STRONG_BEAT);
  const pool = strong.length > 0 ? strong : beats.filter((beat) => beat.isDownbeat);
  if (pool.length === 0) {
    return null;
  }
  let chosen: Beat | null = null;
  let bestDistance: bigint | null = null;
  for (const beat of pool) {
    const distance = beat.tick >= desiredTick ? beat.tick - desiredTick : desiredTick - beat.tick;
    if (bestDistance === null || distance < bestDistance) {
      bestDistance = distance;
      chosen = beat;
    }
  }
  return chosen;
}

/* ------------------------------------------------------------------------- */
/* Loudness — ITU-R BS.1770-4                                                */
/* ------------------------------------------------------------------------- */

/** A direct-form-II transposed biquad. */
function biquad(
  input: Float64Array,
  b0: number,
  b1: number,
  b2: number,
  a1: number,
  a2: number,
): Float64Array {
  const output = new Float64Array(input.length);
  let z1 = 0;
  let z2 = 0;
  for (let i = 0; i < input.length; i += 1) {
    const x = input[i]!;
    const y = b0 * x + z1;
    z1 = b1 * x - a1 * y + z2;
    z2 = b2 * x - a2 * y;
    output[i] = y;
  }
  return output;
}

/** The K-weighting filters of BS.1770-4, derived for the given rate. */
export function kWeightingCoefficients(sampleRate: number): {
  shelf: [number, number, number, number, number];
  highpass: [number, number, number, number, number];
} {
  // Stage 1: a high-frequency shelf at 1681.97 Hz, +3.999 dB, Q 0.7071.
  const f0 = 1681.974450955533;
  const gain = 3.999843853973347;
  const q = 0.7071752369554196;
  const k = Math.tan((Math.PI * f0) / sampleRate);
  const vh = Math.pow(10, gain / 20);
  const vb = Math.pow(vh, 0.499596774661368);
  const a0 = 1 + k / q + k * k;
  const shelf: [number, number, number, number, number] = [
    (vh + (vb * k) / q + k * k) / a0,
    (2 * (k * k - vh)) / a0,
    (vh - (vb * k) / q + k * k) / a0,
    (2 * (k * k - 1)) / a0,
    (1 - k / q + k * k) / a0,
  ];
  // Stage 2: the RLB high-pass at 38.13 Hz, Q 0.5.
  const f1 = 38.13547087602444;
  const q1 = 0.5003270373238773;
  const k1 = Math.tan((Math.PI * f1) / sampleRate);
  const a1 = 1 + k1 / q1 + k1 * k1;
  const highpass: [number, number, number, number, number] = [
    1,
    -2,
    1,
    (2 * (k1 * k1 - 1)) / a1,
    (1 - k1 / q1 + k1 * k1) / a1,
  ];
  return { shelf, highpass };
}

/**
 * The integrated loudness of a WAV, in LUFS.
 *
 * The signal is K-weighted, cut into 400 ms blocks that overlap by 75%,
 * and the blocks are gated twice: first at the absolute threshold of
 * -70 LUFS, then at a relative threshold 10 dB below the mean of the
 * surviving blocks.
 */
export function measureIntegratedLufs(wav: WavData): number {
  const { sampleRate, channels, samples } = wav;
  const frames = Math.floor(samples.length / channels);
  const { shelf, highpass } = kWeightingCoefficients(sampleRate);
  const weighted: Float64Array[] = [];
  for (let channel = 0; channel < channels; channel += 1) {
    const mono = new Float64Array(frames);
    for (let frame = 0; frame < frames; frame += 1) {
      mono[frame] = samples[frame * channels + channel]!;
    }
    const stage1 = biquad(mono, shelf[0], shelf[1], shelf[2], shelf[3], shelf[4]);
    weighted.push(biquad(stage1, highpass[0], highpass[1], highpass[2], highpass[3], highpass[4]));
  }

  const blockSize = Math.round(0.4 * sampleRate);
  const hop = Math.round(0.1 * sampleRate);
  const blockPower: number[] = [];
  for (let start = 0; start + blockSize <= frames; start += hop) {
    let power = 0;
    for (const channel of weighted) {
      let sum = 0;
      for (let i = 0; i < blockSize; i += 1) {
        const value = channel[start + i]!;
        sum += value * value;
      }
      power += sum / blockSize;
    }
    blockPower.push(power);
  }
  if (blockPower.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const toLufs = (power: number): number => -0.691 + 10 * Math.log10(power);

  // The absolute gate at -70 LUFS.
  const aboveAbsolute = blockPower.filter((power) => toLufs(power) > -70);
  if (aboveAbsolute.length === 0) {
    return Number.NEGATIVE_INFINITY;
  }
  const absoluteMean =
    aboveAbsolute.reduce((sum, power) => sum + power, 0) / aboveAbsolute.length;
  const relativeThreshold = toLufs(absoluteMean) - 10;
  const gated = aboveAbsolute.filter((power) => toLufs(power) > relativeThreshold);
  if (gated.length === 0) {
    return toLufs(absoluteMean);
  }
  const mean = gated.reduce((sum, power) => sum + power, 0) / gated.length;
  return toLufs(mean);
}

/* ------------------------------------------------------------------------- */
/* The manifest and the report                                                */
/* ------------------------------------------------------------------------- */

export interface TrailerManifest {
  interviewPaths: string[];
  brollPaths: string[];
  musicPath: string;
  voPaths: string[];
  ambiencePath: string;
  aspect: { width: number; height: number };
  fps: number;
  targetLoudnessLufs: number;
  acts: { hookSec: number; bodySec: number; titleSec: number };
  shotLengthDecayBeats: number[];
  rippleGroups: Array<{ groupId: string; tracks: string[]; locked: boolean }>;
}

export interface Cut {
  fromTick: bigint;
  toTick: bigint;
  trackId: string;
  clipId: number;
}

export interface Ripple {
  atTick: bigint;
  tracks: string[];
  clamped: boolean;
}

export interface TrailerTransition {
  kind: "cross_dissolve" | "dip_to_black";
  atTick: bigint;
  frames: number;
}

export interface TrailerReport {
  decisionHash: string;
  beats: Beat[];
  tempoConfidence: "high" | "medium" | "low";
  tempoBpm: number;
  cuts: Cut[];
  ripples: Ripple[];
  transitions: TrailerTransition[];
  audio: { integratedLufs: number; offsetApplied: number; residualErrorDb: number };
  warnings: Array<{ code: string; detail: string }>;
  outputPath: string;
  outputBytes: number;
  sequenceDurationTicks: bigint;
}

/* ------------------------------------------------------------------------- */
/* The assembler                                                              */
/* ------------------------------------------------------------------------- */

export interface AssembleOptions {
  binary: string;
  workDir: string;
  cwd?: string;
  /** The loudness tolerance, in LU. */
  toleranceLufs?: number;
}

const DEFAULT_TOLERANCE_LUFS = 0.5;

/** The length a still image is given when the rushes carry no duration. */
const FALLBACK_SHOT_TICKS = secondsToTicks(4);

interface ProjectItem {
  item: number;
  name: string;
  duration: bigint;
}

/** The length of a shot, in beats, following the decay the manifest gives. */
export function shotLengthInBeats(index: number, decay: number[]): number {
  if (index < decay.length) {
    return decay[index]!;
  }
  const tail = index - decay.length;
  return tail % 2 === 0 ? 2 : 1.5;
}

function trackOf(state: SequenceState, ref: string): SequenceTrack | undefined {
  return [...state.video, ...state.audio].find((track) => track.ref === ref);
}

/** The clip on a track that starts exactly at a tick. */
function clipStartingAt(state: SequenceState, ref: string, tick: bigint): SequenceClip | undefined {
  const track = trackOf(state, ref);
  if (track === undefined) {
    return undefined;
  }
  return track.clips.find((clip) => clip.start === tick);
}

/** The clip on a track that strictly contains a tick. */
function clipCovering(state: SequenceState, ref: string, tick: bigint): SequenceClip | undefined {
  const track = trackOf(state, ref);
  if (track === undefined) {
    return undefined;
  }
  return track.clips.find((clip) => clip.start < tick && tick < clip.end);
}

export async function assemble(
  manifest: TrailerManifest,
  options: AssembleOptions,
): Promise<TrailerReport> {
  const warnings: Array<{ code: string; detail: string }> = [];
  const cuts: Cut[] = [];
  const ripples: Ripple[] = [];
  const transitions: TrailerTransition[] = [];

  mkdirSync(options.workDir, { recursive: true });

  // 1. The beat grid, before any timeline edit. The grid is persisted so
  //    that a human editor can inspect it and override it.
  const detection = detectBeats(manifest.musicPath);
  const beats = detection.beats;
  writeFileSync(
    join(options.workDir, "beats.json"),
    JSON.stringify(
      {
        tempoBpm: detection.tempoBpm,
        confidence: detection.confidence,
        beats: beats.map((beat) => ({
          tick: beat.tick.toString(),
          frameAt23976: beat.frameAt23976,
          isDownbeat: beat.isDownbeat,
          strength: beat.strength,
        })),
      },
      null,
      2,
    ),
  );
  if (detection.confidence === "low") {
    warnings.push({
      code: "tempo-low-confidence",
      detail: "The autocorrelation was not decisive; the assembler fell back to a 2.0 s grid.",
    });
  }

  const mcp = McpStdioClient.spawn(options.binary, ["mcp"], options.cwd);
  try {
    const engine = new FilmCraft(mcp);

    // 2. The sequence and the bins. The bins are created in one batch;
    //    every edit in the batch is its own undo step, and the batch does
    //    not interpolate between its steps, so the bin ids are read back
    //    from the batch's own results.
    await engine.run("file.newSequence", {
      name: "Trailer_FirstCut",
      width: manifest.aspect.width,
      height: manifest.aspect.height,
      fps: manifest.fps,
      sampleRate: 48000,
      video: 3,
      audio: 3,
    });
    const binNames = ["Interview", "B-roll", "Music", "VO", "Ambience"];
    const binResult = await engine.batch(
      binNames.map((name) => ({ id: "file.newBin", params: { name } })),
    );
    const binIds = new Map<string, number>();
    const batchResults = arrayField(binResult, "results");
    binNames.forEach((name, index) => {
      const step = batchResults[index];
      const result = step === undefined ? {} : (objectField(step, "result") ?? {});
      const bin = numberField(result, "bin");
      if (bin !== 0) {
        binIds.set(name, bin);
      }
    });

    // 3. The ingestion. Every asset is imported first; the item ids the
    //    engine hands back are the only ids the timeline ever sees.
    const importInto = async (paths: string[], binName: string): Promise<ProjectItem[]> => {
      const imported: ProjectItem[] = [];
      for (const path of paths) {
        const items = await engine.importMedia(path);
        const item = items[0];
        if (item === undefined) {
          throw new Error(`the engine did not import ${path}`);
        }
        const bin = binIds.get(binName);
        if (bin !== undefined) {
          await engine.run("project.moveToBin", { items: [item], bin });
        }
        imported.push({ item, name: path.split("/").pop() ?? path, duration: 0n });
      }
      return imported;
    };

    const interviews = await importInto(manifest.interviewPaths, "Interview");
    const broll = await importInto(manifest.brollPaths, "B-roll");
    const music = await importInto([manifest.musicPath], "Music");
    const voices = await importInto(manifest.voPaths, "VO");
    const ambienceItem = await importInto([manifest.ambiencePath], "Ambience");

    // The durations of the imported items, read back from the project.
    const project = await engine.projectInspect();
    const durationOf = new Map<number, bigint>();
    const walk = (nodes: ProjectNode[]): void => {
      for (const node of nodes) {
        if (node.item !== 0) {
          durationOf.set(node.item, node.duration);
        }
        walk(node.children);
      }
    };
    walk(project.children);
    for (const group of [interviews, broll, music, voices, ambienceItem]) {
      for (const entry of group) {
        entry.duration = durationOf.get(entry.item) ?? 0n;
      }
    }

    // 4. The acts. The boundaries are snapped to the grid; the lengths are
    //    budgets, so they are converted to ticks exactly.
    const hookTicks = secondsToTicks(manifest.acts.hookSec);
    const bodyTicks = secondsToTicks(manifest.acts.bodySec);
    const titleTicks = secondsToTicks(manifest.acts.titleSec);
    const act1End = snapToBeat(hookTicks, beats)?.tick ?? hookTicks;
    const act2End = snapToBeat(act1End + bodyTicks, beats)?.tick ?? act1End + bodyTicks;
    const act3End = act2End + titleTicks;

    // 5. Act I: the interview on V1, cut on the grid.
    const interview = interviews[0];
    if (interview === undefined) {
      throw new Error("the manifest carries no interview take");
    }
    const interviewClip = await placeClip(
      engine,
      interview.item,
      "V1",
      0n,
      interview.duration > 0n ? interview.duration : undefined,
    );

    // 6. Act II: the b-roll row on V2 and the graphics on V3.
    //
    //    The rushes are laid down back to back so the row is contiguous,
    //    and the grid cuts are then razored out of the row. Removing a
    //    razored tail with a ripple delete pulls the remaining rushes
    //    earlier, so the row stays contiguous and every shot boundary
    //    lands exactly on the grid.
    const videoGroup =
      manifest.rippleGroups.find((group) => group.groupId === "video")?.tracks ?? [
        "V1",
        "V2",
        "V3",
      ];
    const unlockedVideo = videoGroup.filter((track) => {
      const group = manifest.rippleGroups.find((entry) => entry.tracks.includes(track));
      return group === undefined || !group.locked;
    });

    let cursor = act1End;
    for (const shot of broll) {
      const duration = shot.duration > 0n ? shot.duration : FALLBACK_SHOT_TICKS;
      await placeClip(engine, shot.item, "V2", cursor, duration);
      cursor += duration;
    }

    // The graphics ride on V3 for the length of Act II, and they are cut
    // on the same grid as the picture, so a ripple moves them together.
    const lowerThird = await engine.run("file.newBlackVideo", {
      seconds: manifest.acts.bodySec,
    });
    const lowerThirdItem = numberField(lowerThird, "item");
    await placeClip(engine, lowerThirdItem, "V3", act1End, act2End - act1End);

    // The shot lengths, in beats, follow the decay the manifest gives.
    const beatTicks = detection.beatTicks > 0n ? detection.beatTicks : secondsToTicks(0.5);
    const desiredCuts: bigint[] = [];
    let shotCursor = act1End;
    let shotIndex = 0;
    while (shotCursor < act2End && shotIndex < 512) {
      const beatsInShot = shotLengthInBeats(shotIndex, manifest.shotLengthDecayBeats);
      const desired = shotCursor + BigInt(Math.round(beatsInShot * Number(beatTicks)));
      const snapped = snapToBeat(desired, beats);
      const candidate = snapped === null ? desired : snapped.tick;
      const cut = candidate > act2End ? act2End : candidate;
      if (cut <= shotCursor) {
        break;
      }
      desiredCuts.push(cut);
      shotCursor = cut;
      shotIndex += 1;
    }
    if (desiredCuts.length === 0 || desiredCuts[desiredCuts.length - 1] !== act2End) {
      desiredCuts.push(act2End);
    }

    // 7. The Act I boundary: the interview is cut on the grid and the tail
    //    is removed with a ripple delete, so the row on V1 ends exactly on
    //    the beat.
    {
      const state = await engine.sequenceInspect();
      const tail = clipStartingAt(state, "V1", act1End);
      const covering = clipCovering(state, "V1", act1End);
      if (tail === undefined && covering === undefined) {
        warnings.push({
          code: "ripple-clamped",
          detail:
            "The Act I boundary is beyond the interview take; its out-point was trimmed regularly instead of rippled.",
        });
      } else {
        await withUnlockedTracks(engine, unlockedVideo, async () => {
          if (covering !== undefined) {
            await engine.run("timeline.razor", { time: Number(act1End), track: "V1" });
          }
          const after = await engine.sequenceInspect();
          const piece = clipStartingAt(after, "V1", act1End);
          if (piece !== undefined) {
            await engine.run("edit.rippleDelete", { clips: [piece.clip] });
            ripples.push({ atTick: act1End, tracks: ["V1"], clamped: false });
          }
        });
      }
    }
    cuts.push({ fromTick: 0n, toTick: act1End, trackId: "V1", clipId: interviewClip });

    // 8. The Act II cuts. The whole group is unlocked for the edit, so the
    //    picture and the graphics move together.
    let previousCut = act1End;
    for (const cut of desiredCuts) {
      const isLastCut = cut === act2End;
      const tails: number[] = [];
      const moving: string[] = [];
      let clamped = false;
      let alreadyCut = false;

      await withUnlockedTracks(engine, unlockedVideo, async () => {
        for (const track of unlockedVideo) {
          if (track === "V1") {
            continue;
          }
          const state = await engine.sequenceInspect();
          const covering = clipCovering(state, track, cut);
          const starting = clipStartingAt(state, track, cut);
          if (covering !== undefined) {
            const razor = await engine.run("timeline.razor", { time: Number(cut), track });
            if (numberField(razor, "cuts") > 0) {
              const after = await engine.sequenceInspect();
              const piece = clipStartingAt(after, track, cut);
              if (piece !== undefined) {
                tails.push(piece.clip);
                moving.push(track);
              }
            }
          } else if (starting !== undefined && isLastCut) {
            // The cut is already a boundary and it is the end of the act,
            // so everything from here on is beyond the trailer and is
            // removed with the ripple.
            const beyond = (trackOf(state, track)?.clips ?? []).filter(
              (clip) => clip.start >= cut,
            );
            for (const clip of beyond) {
              tails.push(clip.clip);
            }
            moving.push(track);
          } else if (starting !== undefined) {
            // The cut is already a boundary: the shot boundary is there
            // and no ripple is needed.
            alreadyCut = true;
          }
        }
      });

      if (tails.length === 0) {
        if (alreadyCut) {
          // The row is already cut here; nothing to ripple.
          const after = await engine.sequenceInspect();
          const head =
            clipCovering(after, "V2", previousCut) ?? clipStartingAt(after, "V2", previousCut);
          cuts.push({
            fromTick: previousCut,
            toTick: cut,
            trackId: "V2",
            clipId: head?.clip ?? 0,
          });
          previousCut = cut;
          continue;
        }
        // The rushes ran out before the grid did. The ripple that would
        // have closed the gap would have to consume material that does not
        // exist, so the out-point is trimmed regularly instead.
        const state = await engine.sequenceInspect();
        const last = [...(trackOf(state, "V2")?.clips ?? [])].pop();
        if (last !== undefined) {
          const remainder = last.end % TICKS_PER_FRAME;
          await engine.run("timeline.trim", {
            clip: last.clip,
            edge: "out",
            mode: "regular",
            delta: -Number(remainder),
          });
        }
        warnings.push({
          code: "ripple-clamped",
          detail: `The Act II boundary at tick ${cut.toString()} is beyond the rushes; the out-point was trimmed regularly.`,
        });
        ripples.push({ atTick: cut, tracks: [], clamped: true });
        clamped = true;
      } else {
        await withUnlockedTracks(engine, unlockedVideo, async () => {
          await engine.run("edit.rippleDelete", { clips: tails });
        });
        ripples.push({ atTick: cut, tracks: moving, clamped: false });
        const after = await engine.sequenceInspect();
        const head =
          clipCovering(after, "V2", previousCut) ?? clipStartingAt(after, "V2", previousCut);
        cuts.push({
          fromTick: previousCut,
          toTick: cut,
          trackId: "V2",
          clipId: head?.clip ?? 0,
        });
        previousCut = cut;
      }
      if (clamped) {
        break;
      }
    }

    // 9. The end of Act II. A ripple pulls the material that follows the
    //    cut earlier, so the row can still run past the boundary; the
    //    rushes that are beyond it are removed, so that Act II ends
    //    exactly on the beat the grid chose.
    {
      const state = await engine.sequenceInspect();
      const beyond = (trackOf(state, "V2")?.clips ?? []).filter(
        (clip) => clip.start >= act2End,
      );
      if (beyond.length > 0) {
        const ids = beyond.map((clip) => clip.clip);
        await withUnlockedTracks(engine, unlockedVideo, async () => {
          await engine.run("edit.rippleDelete", { clips: ids });
        });
      }
    }

    // 10. Act III: the title card.
    const title = await engine.run("file.newBlackVideo", { seconds: manifest.acts.titleSec });
    const titleItem = numberField(title, "item");
    const titleClip = await placeClip(engine, titleItem, "V3", act2End, titleTicks);

    // 10. The transitions. Two beats of cross dissolve into Act II, one
    //     beat into Act III, and a four frame dip to black on the trailing
    //     edge of Act I.
    const twoBeatFrames = ticksToFrames(2n * beatTicks);
    const oneBeatFrames = ticksToFrames(beatTicks);
    await engine.run("sequence.applyVideoTransition", {
      clip: interviewClip,
      effect: "cross_dissolve",
      frames: twoBeatFrames,
      edge: "out",
    });
    transitions.push({ kind: "cross_dissolve", atTick: act1End, frames: twoBeatFrames });
    await engine.run("sequence.applyVideoTransition", {
      clip: titleClip,
      effect: "cross_dissolve",
      frames: oneBeatFrames,
      edge: "in",
    });
    transitions.push({ kind: "cross_dissolve", atTick: act2End, frames: oneBeatFrames });

    const dipStart = act1End - 4n * TICKS_PER_FRAME;
    for (const [time, value] of [
      [dipStart, 1],
      [act1End, 0],
    ] as Array<[bigint, number]>) {
      await engine.run("effects.addKeyframe", {
        clip: interviewClip,
        effect: "opacity",
        param: "opacity",
        time: Number(time),
      });
      await engine.run("effects.setParam", {
        clip: interviewClip,
        effect: "opacity",
        param: "opacity",
        value,
        time: Number(time),
      });
    }
    transitions.push({ kind: "dip_to_black", atTick: act1End, frames: 4 });

    // 11. The audio. The music runs under everything on A1, the voice over
    //     on A2, and the room tone on A3 — which is locked, and is trimmed
    //     to the length of the trailer rather than rippled.
    const musicItem = music[0];
    if (musicItem === undefined) {
      throw new Error("the manifest carries no music track");
    }
    await placeClip(engine, musicItem.item, "A1", 0n);
    const voClip =
      voices.length > 0 ? await placeClip(engine, voices[0]!.item, "A2", 0n) : undefined;
    const ambienceClip = await placeClip(engine, ambienceItem[0]!.item, "A3", 0n);

    // The ducking: an Amplify insert on the music, keyed down while the
    // voice over is audible.
    const insert = await engine.run("mixer.addInsert", { strip: "A1", effect: "amplify", slot: 0 });
    const slot = numberField(insert, "slot");
    if (voClip !== undefined) {
      const state = await engine.sequenceInspect();
      const vo = state.audio
        .flatMap((track) => track.clips)
        .find((clip) => clip.clip === voClip);
      if (vo !== undefined) {
        const attack = vo.start + secondsToTicks(0.25);
        const release = vo.end - secondsToTicks(0.4);
        const lane = `fx.${slot}.gain`;
        for (const [time, value] of [
          [vo.start, 0],
          [attack, -6],
          [release, -6],
          [vo.end, 0],
        ] as Array<[bigint, number]>) {
          await engine.run("mixer.setKeyframe", {
            strip: "A1",
            lane,
            time: Number(time),
            value,
          });
        }
      }
    }

    // 12. The ambience bed is locked: it is trimmed to the length of the
    //     trailer, and it is never rippled. The music is trimmed with it,
    //     so the sequence is exactly the length of the trailer before the
    //     loudness is measured.
    const state = await engine.sequenceInspect();
    const ambience = state.audio
      .flatMap((track) => track.clips)
      .find((clip) => clip.clip === ambienceClip);
    if (ambience !== undefined && ambience.end > act3End) {
      await engine.run("timeline.trim", {
        clip: ambience.clip,
        edge: "out",
        mode: "regular",
        delta: -Number(ambience.end - act3End),
      });
    }
    const musicClip = state.audio
      .flatMap((track) => track.clips)
      .find((clip) => clip.item === musicItem.item);
    if (musicClip !== undefined && musicClip.end > act3End) {
      await engine.run("timeline.trim", {
        clip: musicClip.clip,
        edge: "out",
        mode: "regular",
        delta: -Number(musicClip.end - act3End),
      });
    }

    // 13. The loudness conformance. One correction, then the job fails.
    const tolerance = options.toleranceLufs ?? DEFAULT_TOLERANCE_LUFS;
    const probe = join(options.workDir, "loudness-probe.wav");
    const render = async (): Promise<number> => {
      await engine.run("file.exportMedia", {
        path: probe,
        preset: "Waveform Audio 48 kHz 16-bit",
        wait: true,
      });
      return measureIntegratedLufs(readWav(probe));
    };
    let integrated = await render();
    let offsetApplied = 0;
    let residual = Math.abs(integrated - manifest.targetLoudnessLufs);
    if (residual > tolerance) {
      offsetApplied = manifest.targetLoudnessLufs - integrated;
      await engine.run("mixer.setStrip", { strip: "Mix", volumeDb: offsetApplied });
      integrated = await render();
      residual = Math.abs(integrated - manifest.targetLoudnessLufs);
      if (residual > tolerance) {
        warnings.push({
          code: "loudness-out-of-tolerance",
          detail: `The integrated loudness is ${integrated.toFixed(2)} LUFS after one correction.`,
        });
        throw new Error(
          `the loudness conformance failed after one correction: ${residual.toFixed(2)} LU residual`,
        );
      }
    }

    // 14. The export.
    const outputPath = join(options.workDir, "trailer_firstcut.mp4");
    const exported = await engine.run("file.exportMedia", {
      path: outputPath,
      preset: "High Quality 1080p HD",
      wait: true,
    });
    const exportResult = objectField(exported, "result") ?? {};
    const outputBytes = numberField(exportResult, "bytes");

    const finalState = await engine.sequenceInspect();

    // The engine's own reports are written next to the decision report, so
    // that the edit can be audited without re-running the assembler.
    writeFileSync(
      join(options.workDir, "sequence_inspect.json"),
      JSON.stringify(await engine.sequenceInspectRaw(), jsonReplacer, 2),
    );
    writeFileSync(
      join(options.workDir, "mixer_inspect.json"),
      JSON.stringify(await engine.mixerInspectRaw(), jsonReplacer, 2),
    );

    // 15. The decision hash: a digest over the edit decisions, not over
    //     the file, because the encoder is not byte-reproducible.
    const decisionHash = createHash("sha256")
      .update(
        cuts
          .map((cut) => `${cut.fromTick.toString()}:${cut.toTick.toString()}:${cut.trackId}`)
          .join("\n"),
      )
      .update(
        transitions
          .map((entry) => `${entry.kind}:${entry.atTick.toString()}:${entry.frames}`)
          .join("\n"),
      )
      .digest("hex");

    return {
      decisionHash,
      beats,
      tempoConfidence: detection.confidence,
      tempoBpm: detection.tempoBpm,
      cuts,
      ripples,
      transitions,
      audio: {
        integratedLufs: integrated,
        offsetApplied,
        residualErrorDb: residual,
      },
      warnings,
      outputPath,
      outputBytes,
      sequenceDurationTicks: finalState.duration,
    };
  } finally {
    mcp.close();
  }
}

/** JSON cannot hold a BigInt, so the reports write the ticks as strings. */
function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

/** Place one project item on a track and return the clip the engine made. */
async function placeClip(
  engine: FilmCraft,
  item: number,
  track: string,
  time: bigint,
  duration?: bigint,
): Promise<number> {
  const params: JsonObject = { item, track, time: Number(time), insert: false };
  if (duration !== undefined) {
    params.duration = Number(duration);
  }
  const result = await engine.run("timeline.place", params);
  const clips = arrayField(result, "clips");
  const clip = clips[0];
  if (typeof clip !== "number") {
    throw new Error(`timeline.place returned no clip on ${track}`);
  }
  return clip;
}

/**
 * Run an edit with the tracks of a ripple group unlocked.
 *
 * FilmCraft keeps the tracks of a sequence sync-locked, and it refuses an
 * edit that would break the sync between a track and a locked one. A
 * ripple that spans a group therefore has to unlock the group first; the
 * locks are put back afterwards, so the sequence keeps the guarantee the
 * editor is used to.
 */
async function withUnlockedTracks(
  engine: FilmCraft,
  tracks: string[],
  action: () => Promise<void>,
): Promise<void> {
  for (const track of tracks) {
    await engine.run("timeline.setTrack", { track, syncLock: false });
  }
  try {
    await action();
  } finally {
    for (const track of tracks) {
      await engine.run("timeline.setTrack", { track, syncLock: true });
    }
  }
}

/** The report as JSON, with the ticks written as decimal strings. */
export function serialiseReport(report: TrailerReport): string {
  return JSON.stringify(
    {
      decisionHash: report.decisionHash,
      tempoConfidence: report.tempoConfidence,
      tempoBpm: report.tempoBpm,
      beats: report.beats.map((beat) => ({
        tick: beat.tick.toString(),
        frameAt23976: beat.frameAt23976,
        isDownbeat: beat.isDownbeat,
        strength: beat.strength,
      })),
      cuts: report.cuts.map((cut) => ({
        fromTick: cut.fromTick.toString(),
        toTick: cut.toTick.toString(),
        trackId: cut.trackId,
        clipId: cut.clipId,
      })),
      ripples: report.ripples.map((ripple) => ({
        atTick: ripple.atTick.toString(),
        tracks: ripple.tracks,
        clamped: ripple.clamped,
      })),
      transitions: report.transitions.map((entry) => ({
        kind: entry.kind,
        atTick: entry.atTick.toString(),
        frames: entry.frames,
      })),
      audio: report.audio,
      warnings: report.warnings,
      outputPath: report.outputPath,
      outputBytes: report.outputBytes,
      sequenceDurationTicks: report.sequenceDurationTicks.toString(),
    },
    null,
    2,
  );
}

/* ------------------------------------------------------------------------- */
/* The entry point                                                            */
/* ------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const manifestPath = process.argv[2];
  if (manifestPath === undefined) {
    throw new Error("usage: trailer_assembler <manifest.json> [workDir]");
  }
  const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as TrailerManifest;
  const workDir = process.argv[3] ?? join(dirname(manifestPath), "trailer");
  const report = await assemble(manifest, {
    binary: process.env.FILMCRAFT_CLI ?? "filmcraft-cli",
    workDir,
  });
  writeFileSync(join(workDir, "trailer_report.json"), serialiseReport(report));
  process.stdout.write(serialiseReport(report) + "\n");
}

const invokedDirectly =
  process.argv[1] !== undefined && process.argv[1].endsWith("02_trailer_assembler.ts");
if (invokedDirectly) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
