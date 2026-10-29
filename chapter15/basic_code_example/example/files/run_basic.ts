// run_basic.ts — deterministic harness for the Lottie → VP9 pipeline.
//
// The three stages run for real: EffectCraft exports the composition as
// Lottie JSON, headless Chromium rasterises it with lottie-web, and ffmpeg
// encodes the PNG sequence as a VP9 WebM with an alpha channel.

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { encodeVP9, exportLottie, renderFrames } from "./01_hello-lottie-vp9.js";

const run = promisify(execFile);
const OUTPUT = resolve(process.cwd(), "output");
const WORK = resolve(OUTPUT, "work");

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

/** The streams of a media file, as ffprobe reports them. */
async function probeStreams(path: string): Promise<{
  streams: Array<{
    codec_name: string;
    width?: number;
    height?: number;
    pix_fmt?: string;
    tags?: Record<string, string>;
  }>;
}> {
  return JSON.parse(
    (await run("ffprobe", [
      "-v", "error",
      "-print_format", "json",
      "-show_streams",
      path,
    ])).stdout,
  );
}

/**
 * Does the WebM carry an alpha plane?
 *
 * WebM signals the alpha plane with the `alpha_mode` container tag, and the
 * VP9 alpha is a second stream inside the same track: the decoded pixel
 * format of the *colour* plane stays `yuv420p` either way, so the tag is the
 * only honest check.
 */
function alphaMode(video: { tags?: Record<string, string> } | undefined): string {
  return video?.tags?.["alpha_mode"] ?? "0";
}

async function main(): Promise<void> {
  rmSync(OUTPUT, { recursive: true, force: true });
  const framesDir = resolve(WORK, "frames");
  mkdirSync(framesDir, { recursive: true });
  const lottiePath = resolve(WORK, "hello.lottie.json");
  const webmPath = resolve(WORK, "hello.webm");

  console.log("\n# 1/3 the Lottie export");
  await exportLottie(lottiePath);
  ok("lottie: the file exists", existsSync(lottiePath));
  const lottie = JSON.parse(readFileSync(lottiePath, "utf8")) as {
    fr: number; ip: number; op: number; w: number; h: number; layers: unknown[];
  };
  equal("lottie: it runs at 24 fps", lottie.fr, 24);
  equal("lottie: it is 640 wide", lottie.w, 640);
  equal("lottie: it is 360 tall", lottie.h, 360);
  equal("lottie: it starts at frame 0", lottie.ip, 0);
  equal("lottie: it ends at frame 48", lottie.op, 48);
  ok("lottie: it carries two layers", lottie.layers.length === 2, `${lottie.layers.length}`);

  console.log("\n# 2/3 the rasterisation");
  const frameCount = await renderFrames(lottiePath, framesDir);
  equal("frames: lottie-web reports 48 frames", frameCount, 48);
  const frames = readdirSync(framesDir).filter((f) => f.endsWith(".png")).sort();
  equal("frames: 48 PNGs were written", frames.length, 48);
  equal("frames: the first one is zero-padded", frames[0]!, "frame-00000.png");
  const first = readFileSync(resolve(framesDir, frames[0]!));
  ok("frames: it is a PNG", first.subarray(0, 8).toString("hex") === "89504e470d0a1a0a");
  ok("frames: it is not empty", statSync(resolve(framesDir, frames[0]!)).size > 100);

  console.log("\n# 3/3 the VP9 encode");
  await encodeVP9(resolve(framesDir, "frame-%05d.png"), frameCount, webmPath);
  ok("webm: it exists", existsSync(webmPath));
  ok("webm: it is not empty", statSync(webmPath).size > 1000, `${statSync(webmPath).size} bytes`);

  const probe = await probeStreams(webmPath);
  const video = probe.streams.find((s) => s.codec_name === "vp9");
  ok("webm: the codec is VP9", video !== undefined, probe.streams.map((s) => s.codec_name).join(", "));
  equal("webm: it is 640 wide", video?.width, 640);
  equal("webm: it is 360 tall", video?.height, 360);
  // WebM signals "this track carries an alpha plane" with the container
  // tag, which is what the encoder writes when it is asked for `yuva420p`.
  equal("webm: the track declares an alpha mode", alphaMode(video), "1");

  console.log("\n# the alpha variant");
  // The same pipeline with a transparent background: the frames carry an
  // alpha channel, and the VP9 keeps it.
  const alphaFrames = resolve(WORK, "frames-alpha");
  mkdirSync(alphaFrames, { recursive: true });
  const alphaLottie = resolve(WORK, "hello-alpha.lottie.json");
  const alphaWebm = resolve(WORK, "hello-alpha.webm");
  await exportLottie(alphaLottie, { transparentBackground: true });
  const alphaCount = await renderFrames(alphaLottie, alphaFrames);
  equal("alpha: it still renders 48 frames", alphaCount, 48);
  const alphaPng = readFileSync(resolve(alphaFrames, "frame-00000.png"));
  equal("alpha: the PNG carries an alpha channel", alphaPng[25], 6);
  await encodeVP9(resolve(alphaFrames, "frame-%05d.png"), alphaCount, alphaWebm);
  const alphaProbe = await probeStreams(alphaWebm);
  const alphaVideo = alphaProbe.streams.find((s) => s.codec_name === "vp9");
  equal("alpha: the WebM declares the alpha plane", alphaMode(alphaVideo), "1");
  ok("alpha: the frames really are transparent", alphaPng[25] === 6);

  assert.ok(existsSync(webmPath));
  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
