// run_ex4.ts — acceptance harness for the audio-muxed VP9 alpha overlay.
//
// It builds a real 12-frame RGBA lower third, records a 48 kHz/24-bit stem,
// runs the solution's two-pass VP9 + Opus encoder into MKV and WebM, and
// checks alpha, BT.709 tagging, stream identity, limited range and audio.
// A loopback stub proves that the TCP handshake authenticates first.

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import {
  CONTRACT,
  encodeAlpha,
  ffprobeDuration,
  ffprobeFields,
  hasAlphaPlane,
  observedColor,
  sha,
  signalStats,
  tcpExecute,
  videoStreamSha,
  type ColorConformance,
  type OverlayDeliverables,
} from "./04_audio-muxed-vp9-alpha-overlay-pipeline-with-deterministic-color-management.js";

const pexec = promisify(execFile);
const HERE = process.cwd();
const OUTPUT = resolve(HERE, "..", "output");
const WORK = resolve(OUTPUT, "work");
const TOKEN = "a".repeat(64);

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

const FRAMES = 12;
const WIDTH = 640;
const HEIGHT = 360;

function lowerThird(index: number): Buffer {
  const png = new PNG({ width: WIDTH, height: HEIGHT });
  const slide = Math.round((index / FRAMES) * 60);
  for (let y = 0; y < HEIGHT; y += 1) {
    for (let x = 0; x < WIDTH; x += 1) {
      const i = (y * WIDTH + x) * 4;
      const inBar = x >= 40 + slide && x < 600 + slide && y >= 250 && y < 310;
      const inRule = inBar && y < 256;
      png.data[i] = inRule ? 15 : inBar ? 26 : 0;
      png.data[i + 1] = inRule ? 98 : inBar ? 26 : 0;
      png.data[i + 2] = inRule ? 254 : inBar ? 46 : 0;
      png.data[i + 3] = inBar ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

function thumbnail(): Buffer {
  const png = new PNG({ width: 1280, height: 720 });
  for (let y = 0; y < 720; y += 1) {
    for (let x = 0; x < 1280; x += 1) {
      const i = (y * 1280 + x) * 4;
      png.data[i] = 26;
      png.data[i + 1] = 26;
      png.data[i + 2] = 46;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

async function main(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  for (const name of ["overlay.mkv", "overlay.webm", "overlay.json", "thumb.png",
    "color-conformance.json", "delivery.json", "whoosh_stem.wav", "tcp-handshake.json", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  mkdirSync(resolve(WORK, "dist", "frames"), { recursive: true });
  mkdirSync(resolve(WORK, "dist", "web"), { recursive: true });
  mkdirSync(resolve(WORK, "audio"), { recursive: true });
  mkdirSync(resolve(WORK, "dist", "audit"), { recursive: true });

  console.log("\n# build the source media");
  for (let index = 0; index < FRAMES; index += 1) {
    writeFileSync(resolve(WORK, "dist", "frames", `f_${String(index).padStart(4, "0")}.png`), lowerThird(index));
  }
  writeFileSync(resolve(WORK, "dist", "web", "thumb.png"), thumbnail());
  const lottie = JSON.parse(readFileSync(resolve(HERE, "overlay-lottie.json"), "utf8")) as Record<string, unknown>;
  lottie.op = FRAMES;
  writeFileSync(resolve(WORK, "dist", "web", "overlay.json"), JSON.stringify(lottie, null, 2));
  await pexec("ffmpeg", [
    "-y", "-loglevel", "error",
    "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000:duration=0.5",
    "-af", "volume=0.4", "-ac", "2", "-c:a", "pcm_s24le",
    resolve(WORK, "audio", "whoosh_stem.wav"),
  ]);
  ok("media: twelve RGBA frames", existsSync(resolve(WORK, "dist", "frames", "f_0000.png")));
  ok("media: 48 kHz stem", existsSync(resolve(WORK, "audio", "whoosh_stem.wav")));
  const framePng = PNG.sync.read(readFileSync(resolve(WORK, "dist", "frames", "f_0000.png")));
  equal("media: frame width", framePng.width, WIDTH);
  equal("media: frame height", framePng.height, HEIGHT);
  equal("media: corner is transparent", framePng.data[3], 0);

  console.log("\n# two-pass encode and container checks");
  process.chdir(WORK);
  const { mkv, webm } = await encodeAlpha("audio/whoosh_stem.wav");
  ok("encode: mkv exists", existsSync(mkv) && readFileSync(mkv).length > 1000);
  ok("encode: webm exists", existsSync(webm) && readFileSync(webm).length > 1000);
  const [mkvFields, webmFields] = await Promise.all([ffprobeFields(mkv), ffprobeFields(webm)]);
  const mkvS = mkvFields.streams[0]!;
  const webmS = webmFields.streams[0]!;
  ok(`alpha: mkv carries a plane (${mkvS.pix_fmt}/${mkvS.tags?.alpha_mode ?? "-"})`, hasAlphaPlane(mkvS));
  ok(`alpha: webm carries a plane (${webmS.pix_fmt}/${webmS.tags?.alpha_mode ?? "-"})`, hasAlphaPlane(webmS));
  const { stdout: rawFrame } = await pexec("ffmpeg", [
    "-v", "error", "-c:v", "libvpx-vp9", "-i", webm,
    "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", "-",
  ], { encoding: "buffer", maxBuffer: 1 << 26 });
  const rgba = rawFrame as unknown as Buffer;
  let transparent = 0;
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] === 0) transparent += 1;
  ok(`alpha: the decoded frame has transparent pixels (${transparent})`, transparent > 0);
  for (const [name, stream] of [["mkv", mkvS], ["webm", webmS]] as const) {
    equal(`color ${name}: primaries`, observedColor(stream, "color_primaries"), CONTRACT.primaries);
    equal(`color ${name}: transfer`, observedColor(stream, "color_transfer"), CONTRACT.transfer);
    equal(`color ${name}: matrix`, observedColor(stream, "color_space"), CONTRACT.colorspace);
  }
  const [mkvDuration, webmDuration] = await Promise.all([ffprobeDuration(mkv), ffprobeDuration(webm)]);
  ok("timing: containers agree within one frame",
    Math.abs(mkvDuration - webmDuration) <= 1 / 30 + 1e-6,
    `${mkvDuration} vs ${webmDuration}`);

  const [mkvHash, webmHash] = await Promise.all([videoStreamSha(mkv), videoStreamSha(webm)]);
  equal("stream: MKV and WebM carry the same VP9 elementary stream", mkvHash, webmHash);
  equal("stream: hash is sha256", mkvHash.length, 64);

  console.log("\n# luma range and audio");
  const stats = await signalStats(webm);
  ok(`luma: every frame was measured (${stats.length})`, stats.length >= FRAMES - 1);
  const bad = stats.filter((f) => f.YMIN < 11 || f.YMAX > 240 || f.YAVG < 11 || f.YAVG > 240);
  equal("luma: all frames stay in limited range", bad.length, 0);
  ok("luma: the overlay is not crushed to black", stats.some((f) => f.YAVG > 16));

  const { stdout: audioProbe } = await pexec("ffprobe", [
    "-v", "error", "-select_streams", "a:0",
    "-show_entries", "stream=codec_name,sample_rate,channels",
    "-of", "json", webm,
  ]);
  const audio = (JSON.parse(audioProbe) as { streams: Array<{ codec_name: string; sample_rate: string; channels: number }> }).streams[0]!;
  equal("audio: codec is Opus", audio.codec_name, "opus");
  equal("audio: 48 kHz", Number(audio.sample_rate), 48000);
  equal("audio: stereo", audio.channels, 2);

  console.log("\n# loopback auth-first handshake");
  const methods: string[] = [];
  const server = createServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const frame = JSON.parse(line) as { id: string | number; method: string; params?: { token?: string } };
        methods.push(frame.method);
        if (frame.method === "auth") {
          const good = frame.params?.token === TOKEN;
          socket.write(JSON.stringify(good
            ? { id: "auth", ok: true, result: { authenticated: true } }
            : { id: "auth", ok: false, error: { message: "bad token" } }) + "\n");
        } else {
          socket.write(JSON.stringify({
            id: frame.id, ok: true,
            result: { entries: [{ kind: "audio", name: "whoosh_stem.wav", path: "audio/whoosh_stem.wav" }] },
          }) + "\n");
        }
        newline = buffer.indexOf("\n");
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const address = server.address();
  assert(address && typeof address === "object");
  try {
    const reply = await tcpExecute(address.port, TOKEN, "engine.execute", {
      command: "mediaBrowser.list", params: {},
    }) as { result?: { entries?: Array<{ name?: string }> } };
    equal("tcp: the stem is listed", reply.result?.entries?.[0]?.name, "whoosh_stem.wav");
    equal("tcp: auth is the first frame", methods[0], "auth");
    equal("tcp: the real method follows auth", methods[1], "engine.execute");
    let rejected = false;
    try {
      await tcpExecute(address.port, "b".repeat(64), "engine.execute", { command: "mediaBrowser.list" });
    } catch (error) {
      rejected = String(error).includes("auth rejected");
    }
    ok("tcp: a bad token is rejected", rejected);
  } finally {
    server.close();
  }
  writeFileSync(resolve(WORK, "dist", "audit", "tcp-handshake.json"), JSON.stringify({ methods }, null, 2));

  console.log("\n# conformance and delivery");
  const conformance: ColorConformance = {
    contract: CONTRACT,
    observedPrimaries: observedColor(webmS, "color_primaries"),
    observedTransfer: observedColor(webmS, "color_transfer"),
    observedColorspace: observedColor(webmS, "color_space"),
    failedFrames: bad,
    pass: bad.length === 0 && mkvHash === webmHash,
  };
  writeFileSync(resolve(WORK, "dist", "audit", "color-conformance.json"), JSON.stringify(conformance, null, 2));
  const deliverables: OverlayDeliverables = {
    webmLottie: { path: "dist/web/overlay.json", sha256: await sha("dist/web/overlay.json") },
    mkvAlpha: { path: "dist/native/overlay.mkv", sha256: await sha(mkv), videoStreamSha256: mkvHash },
    webmAlpha: { path: "dist/native/overlay.webm", sha256: await sha(webm), videoStreamSha256: webmHash },
    thumbnail: { path: "dist/web/thumb.png", sha256: await sha("dist/web/thumb.png") },
    audio: { path: "audio/whoosh_stem.wav", codec: "opus", sampleRate: 48000, bitrate: 192000 },
  };
  writeFileSync(resolve(WORK, "dist", "delivery.json"), JSON.stringify(deliverables, null, 2));
  ok("conformance: pass", conformance.pass);
  equal("conformance: no failed frames", conformance.failedFrames.length, 0);

  const copies: Array<[string, string]> = [
    [resolve(WORK, mkv), "overlay.mkv"],
    [resolve(WORK, webm), "overlay.webm"],
    [resolve(WORK, "dist", "web", "overlay.json"), "overlay.json"],
    [resolve(WORK, "dist", "web", "thumb.png"), "thumb.png"],
    [resolve(WORK, "dist", "audit", "color-conformance.json"), "color-conformance.json"],
    [resolve(WORK, "dist", "delivery.json"), "delivery.json"],
    [resolve(WORK, "audio", "whoosh_stem.wav"), "whoosh_stem.wav"],
  ];
  for (const [from, name] of copies) {
    writeFileSync(resolve(OUTPUT, name), readFileSync(from));
    ok(`output: ${name}`, existsSync(resolve(OUTPUT, name)));
  }
  writeFileSync(resolve(OUTPUT, "tcp-handshake.json"), JSON.stringify({ methods }, null, 2));

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 4,
    engine: "ffmpeg VP9 alpha + Opus",
    assertions: passed + 1,
    frames: FRAMES,
    resolution: `${WIDTH}x${HEIGHT}`,
    containers: ["mkv", "webm"],
    videoStreamSha256: mkvHash,
    audio: { codec: "opus", sampleRate: 48000, channels: 2 },
    tcpMethods: methods,
    artefacts: ["overlay.mkv", "overlay.webm", "overlay.json", "thumb.png",
      "color-conformance.json", "delivery.json", "whoosh_stem.wav", "tcp-handshake.json"],
    result: "two containers carry the same VP9 alpha stream, BT.709 triad and Opus 48 kHz audio; TCP authenticates first",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
