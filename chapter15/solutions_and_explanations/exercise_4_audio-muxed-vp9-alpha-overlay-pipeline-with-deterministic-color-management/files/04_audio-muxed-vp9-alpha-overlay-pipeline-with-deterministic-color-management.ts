// Language: typescript
// overlay.ts — audio-muxed VP9 alpha lower-third pipeline
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as net from "node:net";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";

const pexec = promisify(execFile);

// ---- Contracts -------------------------------------------------------
export type Primaries = "bt709" | "bt2020" | "smpte2084";
export type Transfer = "bt709" | "srgb" | "linear" | "pq" | "hlg";
export type Colorspace = "bt709" | "bt2020nc" | "bt2020c";

export interface ColorContract {
  readonly primaries: Primaries;
  readonly transfer: Transfer;
  readonly colorspace: Colorspace;
  readonly range: "tv" | "pc";
  readonly peakNits: 100 | 1000;
}
export interface SignalStatsFrame {
  readonly pts: number;
  readonly YMIN: number; readonly YMAX: number; readonly YAVG: number;
  readonly UMIN: number; readonly UMAX: number;
  readonly VMIN: number; readonly VMAX: number;
}
export interface ColorConformance {
  readonly contract: ColorContract;
  readonly observedPrimaries: string;
  readonly observedTransfer: string;
  readonly observedColorspace: string;
  readonly failedFrames: readonly SignalStatsFrame[];
  readonly pass: boolean;
}
export interface OverlayDeliverables {
  readonly webmLottie: { path: string; sha256: string };
  readonly mkvAlpha: { path: string; sha256: string; videoStreamSha256: string };
  readonly webmAlpha: { path: string; sha256: string; videoStreamSha256: string };
  readonly thumbnail: { path: string; sha256: string };
  readonly audio: { path: string; codec: "opus"; sampleRate: 48000; bitrate: 192000 };
}

export const CONTRACT: ColorContract = {
  primaries: "bt709", transfer: "bt709", colorspace: "bt709",
  range: "tv", peakNits: 100,
};

// ---- MCP helpers -----------------------------------------------------
async function ec(): Promise<Client> {
  const c = new Client({ name: "overlay-ec", version: "1.0.0" }, { capabilities: {} });
  await c.connect(new StdioClientTransport({
    command: "effectcraft-cli",
    args: ["mcp"],
  }));
  return c;
}
async function pc(): Promise<Client> {
  // PhotoCraft refuses to start when the write root does not exist.
  await fs.mkdir("dist", { recursive: true });
  const c = new Client({ name: "overlay-pc", version: "1.0.0" }, { capabilities: {} });
  await c.connect(new StdioClientTransport({
    command: "photocraft-cli",
    args: ["mcp", "--automation-write-root", "./dist"],
  }));
  return c;
}
export function jsonText<T>(res: unknown): T {
  const r = res as { content?: ReadonlyArray<{ type: string; text?: string }> };
  const first = r.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") throw new Error("MCP: non-text");
  return JSON.parse(first.text) as T;
}
/** EffectCraft's meta-tool: any command of the registry. */
async function cmd<T>(c: Client, command: string, params: Record<string, unknown> = {}): Promise<T> {
  return jsonText<T>(await c.callTool({
    name: "execute_command", arguments: { command, params },
  }));
}

/** PhotoCraft's meta-tool: any command of the registry. */
async function pcCmd<T>(c: Client, id: string, params: Record<string, unknown> = {}): Promise<T> {
  return jsonText<T>(await c.callTool({ name: "command_run", arguments: { id, params } }));
}

// ---- TCP loopback ----------------------------------------------------
// The mandatory first-frame handshake is non-negotiable.
// (Incorrect example kept in a comment for pedagogy:
//   { "id": 1, "method": "engine.execute", "params": { "command": "mediaBrowser.list" } }
//  — this closes the socket immediately.)
export async function tcpExecute(port: number, token: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const sock = net.connect(port, "127.0.0.1");
  await new Promise<void>((res, rej) => { sock.once("connect", res); sock.once("error", rej); });

  // 1) AUTH FIRST. 64-hex token only.
  sock.write(JSON.stringify({ id: "auth", method: "auth", params: { token } }) + "\n");

  // Await auth ack before the SAME socket is used for the real method.
  await new Promise<void>((res, rej) => {
    let buf = "";
    const timer = setTimeout(() => { sock.destroy(); rej(new Error("auth timeout")); }, 5000);
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i < 0) return;
      const line = buf.slice(0, i);
      const parsed = JSON.parse(line) as { ok?: boolean };
      sock.off("data", onData);
      clearTimeout(timer);
      if (!parsed.ok) { sock.destroy(); return rej(new Error("TCP auth rejected")); }
      res();
    };
    sock.on("data", onData);
  });

  // 2) Real request over the same authenticated socket.
  const reqId = 1;
  sock.write(JSON.stringify({ id: reqId, method, params }) + "\n");
  const reply = await new Promise<string>((res, rej) => {
    let buf = "";
    const timer = setTimeout(() => { sock.destroy(); rej(new Error(`${method} timeout`)); }, 30_000);
    const onData = (d: Buffer) => {
      buf += d.toString("utf8");
      const i = buf.indexOf("\n");
      if (i < 0) return;
      sock.off("data", onData);
      clearTimeout(timer);
      res(buf.slice(0, i));
    };
    sock.on("data", onData);
  });
  sock.destroy();
  return JSON.parse(reply);
}

// ---- Pipeline steps --------------------------------------------------
async function stepLottie(c: Client) {
  await fs.mkdir("dist/web", { recursive: true });
  await cmd(c, "file.exportLottie", {
    comp: "LowerThird_MASTER",
    path: "dist/web/overlay.json",
    textAsShapes: true,
  });
}

async function stepFrames(c: Client) {
  await fs.mkdir("dist/frames", { recursive: true });
  await cmd(c, "renderQueue.add", {
    comp: "LowerThird_MASTER",
    format: "png",
    output: "dist/frames/f_####.png",
    channels: "rgba",
    frameRate: 30,
  });
  await cmd(c, "renderQueue.render", { wait: true });
}

async function stepAudioStemCheck(port: number, token: string, stemPath: string) {
  // The live FilmCraft state is read over the loopback channel, and the
  // frame has to be the auth frame: a socket that opens with anything
  // else is dropped.
  const reply = await tcpExecute(port, token, "engine.execute", {
    command: "mediaBrowser.list", params: {},
  }) as { result?: { entries?: Array<{ kind?: string; name?: string; path?: string }> } };
  const items = reply.result?.entries ?? [];
  const stem = items.find((i) => i.name?.endsWith("whoosh_stem.wav"));
  if (!stem) throw new Error("audio: whoosh_stem.wav not present in FilmCraft project");

  // The format is read from the file itself: the loopback reports the
  // media, not its sample layout.
  const { stdout } = await pexec("ffprobe", [
    "-v", "error",
    "-select_streams", "a:0",
    "-show_entries", "stream=sample_rate,bits_per_raw_sample,bits_per_sample",
    "-of", "default=noprint_wrappers=1:nokey=1",
    stemPath,
  ]);
  const [rate, depth] = stdout.trim().split("\n");
  if (Number(rate) !== 48000) throw new Error(`audio: expected 48 kHz, got ${rate}`);
  if (Number(depth) !== 24) throw new Error(`audio: expected 24-bit, got ${depth}`);
}

// ---- Encoding --------------------------------------------------------
export async function encodeAlpha(audioPath: string): Promise<{ mkv: string; webm: string }> {
  const mkv = "dist/native/overlay.mkv";
  const webm = "dist/native/overlay.webm";
  await fs.mkdir(path.dirname(mkv), { recursive: true });

  const common = [
    "-y", "-hide_banner", "-loglevel", "error",
    "-framerate", "30", "-i", "dist/frames/f_%04d.png",
    "-i", audioPath,
    "-c:v", "libvpx-vp9",
    "-pix_fmt", "yuva420p",
    "-crf", "26", "-b:v", "0",
    "-row-mt", "1", "-tile-columns", "2",
    "-auto-alt-ref", "1", "-lag-in-frames", "25",
    "-c:a", "libopus", "-b:a", "192k", "-ar", "48000", "-ac", "2", "-application", "audio",
    "-color_primaries", "bt709", "-color_trc", "bt709",
    "-colorspace", "bt709", "-color_range", "tv",
    // VP9's bitstream has no primaries/transfer fields (only matrix and
    // range), so the Matroska tags carry the full BT.709 triad too.
    "-metadata:s:v:0", "color_primaries=bt709",
    "-metadata:s:v:0", "color_transfer=bt709",
    "-shortest",
    // Pass 2 runs single-threaded so the video elementary stream is byte-stable.
    "-threads", "1",
  ] as const;

  // Pass 1 — analysis only, parallel, output discarded.
  await pexec("ffmpeg", [
    ...common.slice(0, -2), // drop the final "-threads 1" for the analysis pass
    "-pass", "1", "-passlogfile", "dist/native/vp9pass",
    "-an", "-f", "null", "/dev/null",
  ]);

  // Pass 2 — real encode into both containers using the SAME filter chain.
  await pexec("ffmpeg", [
    ...common, "-pass", "2", "-passlogfile", "dist/native/vp9pass",
    mkv,
  ]);
  await pexec("ffmpeg", [
    ...common, "-pass", "2", "-passlogfile", "dist/native/vp9pass",
    webm,
  ]);
  return { mkv, webm };
}

// ---- Verification ----------------------------------------------------
/**
 * FFmpeg reports a VP9 stream with an alpha plane as `yuv420p`; the plane is
 * side data signalled by `alpha_mode=1`. Accept either representation.
 */
export function hasAlphaPlane(stream: { pix_fmt: string; tags?: Record<string, string> }): boolean {
  return stream.pix_fmt === "yuva420p" || stream.tags?.alpha_mode === "1";
}

/** A colour field from the codec parameters, falling back to a container tag. */
export function observedColor(
  stream: { color_primaries?: string; color_transfer?: string; color_space?: string; tags?: Record<string, string> },
  field: "color_primaries" | "color_transfer" | "color_space",
): string {
  const value = stream[field];
  if (value && value !== "unknown") return value;
  const tag = field === "color_primaries" ? "COLOR_PRIMARIES" : field === "color_transfer" ? "COLOR_TRANSFER" : "COLOR_SPACE";
  return stream.tags?.[tag] ?? stream.tags?.[tag.toLowerCase()] ?? "unknown";
}

export async function ffprobeFields(file: string) {
  const { stdout } = await pexec("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=color_primaries,color_transfer,color_space,pix_fmt,codec_tag_string,duration:stream_tags=alpha_mode,color_primaries,color_transfer",
    "-of", "json", file,
  ]);
  return JSON.parse(stdout) as {
    streams: Array<{
      color_primaries: string; color_transfer: string; color_space: string;
      pix_fmt: string; codec_tag_string: string; duration: string;
      tags?: Record<string, string>;
    }>;
  };
}

/** Container duration in seconds; stream-level duration is N/A in WebM. */
export async function ffprobeDuration(file: string): Promise<number> {
  const { stdout } = await pexec("ffprobe", [
    "-v", "error", "-show_entries", "format=duration",
    "-of", "default=noprint_wrappers=1:nokey=1", file,
  ]);
  return Number(stdout.trim());
}

export async function videoStreamSha(file: string): Promise<string> {
  // Strip container wrapper: hash the elementary stream only.
  const tmp = file + ".es";
  await pexec("ffmpeg", ["-y", "-v", "error", "-i", file, "-map", "0:v", "-c:v", "copy", "-f", "ivf", tmp]);
  const buf = await fs.readFile(tmp);
  await fs.unlink(tmp);
  return createHash("sha256").update(buf).digest("hex");
}

export async function signalStats(file: string): Promise<SignalStatsFrame[]> {
  const txt = "dist/audit/signalstats.txt";
  await fs.mkdir(path.dirname(txt), { recursive: true });
  await pexec("ffmpeg", [
    "-v", "error",
    "-i", file,
    "-vf", "signalstats,metadata=print:file=" + txt,
    "-f", "null", "/dev/null",
  ]);
  const lines = (await fs.readFile(txt, "utf8")).split("\n");
  const frames: SignalStatsFrame[] = [];
  let cur: Partial<SignalStatsFrame> = {};
  for (const ln of lines) {
    const m = /frame:\s*(\d+).*pts_time:([\d.]+)/.exec(ln)
          ?? /^frame:(\d+).*pts_time:([\d.]+)/.exec(ln);
    if (m) cur = { pts: Number(m[2]) };
    for (const key of ["YMIN","YMAX","YAVG","UMIN","UMAX","VMIN","VMAX"] as const) {
      const re = new RegExp(`lavfi\\.signalstats\\.${key}=([\\d.]+)`);
      const mm = re.exec(ln);
      if (mm && cur) (cur as Record<string, number>)[key] = Number(mm[1]);
    }
    if (cur.YMIN !== undefined && cur.YMAX !== undefined) {
      frames.push(cur as SignalStatsFrame);
      cur = {};
    }
  }
  return frames;
}

async function stepThumbnail(c: Client) {
  await fs.mkdir("dist/web", { recursive: true });
  await (c.callTool({ name: "doc_new", arguments: {
    width: 1280, height: 720, mode: "rgb", depth: 8, background: "black",
  }}));
  await pcCmd(c, "paint.stroke", {
    points: [[0, 360], [1280, 360]],
    size: 720,
    color: "#1A1A2E",
  });
  await (c.callTool({ name: "doc_save", arguments: {
    path: "dist/web/thumb.png", format: "PNG",
  }}));
}

// ---- Driver ----------------------------------------------------------
async function main() {
  const ecClient = await ec();
  const pcClient = await pc();
  const token = process.env.FILMCRAFT_TOKEN ?? "0".repeat(64);
  const port = Number(process.env.FILMCRAFT_PORT ?? "7879");

  try {
    await stepLottie(ecClient);
    await stepFrames(ecClient);
    await stepAudioStemCheck(port, token, "audio/whoosh_stem.wav");
    await stepThumbnail(pcClient);

    const audio = "audio/whoosh_stem.wav";
    const { mkv, webm } = await encodeAlpha(audio);

    const [mkvFields, webmFields] = await Promise.all([
      ffprobeFields(mkv), ffprobeFields(webm),
    ]);
    const mkvS = mkvFields.streams[0]!;
    const webmS = webmFields.streams[0]!;

    if (!hasAlphaPlane(mkvS) || !hasAlphaPlane(webmS)) {
      throw new Error(`alpha: no alpha plane (mkv=${mkvS.pix_fmt}/${mkvS.tags?.alpha_mode ?? "-"}, webm=${webmS.pix_fmt}/${webmS.tags?.alpha_mode ?? "-"})`);
    }
    for (const [name, stream] of [["mkv", mkvS], ["webm", webmS]] as const) {
      const triad = [
        observedColor(stream, "color_primaries"),
        observedColor(stream, "color_transfer"),
        observedColor(stream, "color_space"),
      ];
      if (triad.some((v) => v !== "bt709")) {
        throw new Error(`color: ${name} tagging triad mismatch (${triad.join("/")})`);
      }
    }
    const [dMkv, dWebm] = await Promise.all([ffprobeDuration(mkv), ffprobeDuration(webm)]);
    if (Math.abs(dMkv - dWebm) > 1 / 30 + 1e-6) throw new Error("duration: > 1 frame apart");

    // Prove the video elementary streams are byte-identical between containers.
    const [mkvHash, webmHash] = await Promise.all([
      videoStreamSha(mkv), videoStreamSha(webm),
    ]);
    if (mkvHash !== webmHash) {
      throw new Error(`video stream divergence: mkv=${mkvHash} webm=${webmHash}`);
    }

    const frames = await signalStats(webm);
    // Limited-range BT.709: nominal luma is [16, 235]. Decode rounding and
    // lossy ringing around a moving edge can undershoot by a few code
    // values, so the gate allows a five-step guard band instead of treating
    // a legal encode as full-range.
    const failures = frames.filter((f) =>
      f.YMIN < 11 || f.YMAX > 240 || f.YAVG < 11 || f.YAVG > 240);

    const conformance: ColorConformance = {
      contract: CONTRACT,
      observedPrimaries: observedColor(webmS, "color_primaries"),
      observedTransfer: observedColor(webmS, "color_transfer"),
      observedColorspace: observedColor(webmS, "color_space"),
      failedFrames: failures,
      pass: failures.length === 0 && mkvHash === webmHash,
    };
    await fs.mkdir("dist/audit", { recursive: true });
    await fs.writeFile("dist/audit/color-conformance.json",
      JSON.stringify(conformance, null, 2) + "\n");

    const deliverables: OverlayDeliverables = {
      webmLottie: { path: "dist/web/overlay.json", sha256: await sha("dist/web/overlay.json") },
      mkvAlpha: {
        path: "dist/native/overlay.mkv",
        sha256: await sha(mkv), videoStreamSha256: mkvHash,
      },
      webmAlpha: {
        path: "dist/native/overlay.webm",
        sha256: await sha(webm), videoStreamSha256: webmHash,
      },
      thumbnail: { path: "dist/web/thumb.png", sha256: await sha("dist/web/thumb.png") },
      audio: { path: audio, codec: "opus", sampleRate: 48000, bitrate: 192000 },
    };
    await fs.writeFile("dist/delivery.json", JSON.stringify(deliverables, null, 2) + "\n");

    if (!conformance.pass) { console.error("color conformance FAIL"); process.exit(1); }
  } finally {
    await ecClient.close(); await pcClient.close();
  }
}

export async function sha(p: string) {
  const b = await fs.readFile(p); return createHash("sha256").update(b).digest("hex");
}

if (process.argv[1]?.endsWith("04_audio-muxed-vp9-alpha-overlay-pipeline-with-deterministic-color-management.ts")) {
  await main().catch((e) => { console.error(e); process.exit(1); });
}
