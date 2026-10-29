// @studio/lottie-delivery/types.ts
// Compiled with: strict, noImplicitAny, noUncheckedIndexedAccess, exactOptionalPropertyTypes.
export interface LottieAsset { id: string; u: string; p: string; w?: number; h?: number; e?: 0 | 1 }
export interface LottieJson {
  v: string;
  fr: number;
  ip: number;
  op: number;
  w: number;
  h: number;
  nm: string;
  ddd: 0 | 1;
  assets?: readonly LottieAsset[];
  layers: readonly unknown[];
}

export interface WebBundleOptions {
  readonly outputDir: string;
  readonly minify: boolean;
  readonly stripExpressions: true;
}
export interface NativeBundleOptions {
  readonly outputDir: string;
  readonly targetFps: 30 | 60 | 120;
  readonly crf: number;
  readonly lottieFrameBudget: number;
  readonly alphaMode: "straight" | "premultiplied";
}
export interface WebBundle {
  readonly jsonPath: string;
  readonly jsPath: string;
  readonly frameCount: number;
  readonly fr: number;
}
export interface NativeBundle {
  readonly webmPath: string;
  readonly frameCount: number;
  readonly sourcePngs: readonly string[];
}
export interface FrameSample {
  readonly index: number;
  readonly webHash: string;
  readonly nativeHash: string;
  readonly hamming: number;
}
export interface ParityReport {
  readonly samples: readonly FrameSample[];
  readonly maxDelta: number;
  readonly pass: boolean;
  readonly histogram: Readonly<Record<string, number>>;
}

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import puppeteer, { type Browser } from "puppeteer-core";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";

const pexec = promisify(execFile);

/** Names the temporary files the perceptual hash stages its input in. */
let hashCounter = 0;

declare global {
  interface Window {
    /** Handle lottie-web hands back from `loadAnimation`. */
    __anim?: {
      goToAndStop: (value: number, isFrame: boolean) => void;
      readonly totalFrames: number;
    };
    /** The lottie-web global injected by the player bundle. */
    lottie?: {
      loadAnimation: (opts: {
        container: HTMLElement | null;
        renderer: "canvas";
        loop: boolean;
        autoplay: boolean;
        animationData: unknown;
        rendererSettings: { clearCanvas: boolean; preserveAspectRatio: string };
      }) => {
        goToAndStop: (value: number, isFrame: boolean) => void;
        readonly totalFrames: number;
      };
    };
  }
}

// ---------------------------------------------------------------------
// MCP bootstrap
// ---------------------------------------------------------------------
async function spawnEffectCraft() {
  const transport = new StdioClientTransport({
    command: "effectcraft-cli",
    args: ["mcp"],
  });
  const client = new Client({ name: "lottie-dual-deliver", version: "2.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

// ---------------------------------------------------------------------
// Web bundle
// ---------------------------------------------------------------------
export async function renderWebBundle(
  lottie: LottieJson, opts: WebBundleOptions,
): Promise<WebBundle> {
  // Any live expression means the export is non-deterministic downstream.
  // We refuse the source rather than silently strip.
  if (hasExpressions(lottie)) {
    throw new Error(
      "renderWebBundle: source contains live expressions — design must bake them " +
      "before delivery (Lottie endpoint cannot guarantee deterministic output)");
  }
  const client = await spawnEffectCraft();
  try {
    const jsonPath = path.join(opts.outputDir, "hero.json");
    await fs.mkdir(path.dirname(jsonPath), { recursive: true });
    const res = await client.callTool({
      name: "execute_command",
      arguments: {
        command: "file.exportLottie",
        params: {
          comp: "Main_HeroLoop", path: jsonPath,
          textAsShapes: true, includeExpressions: false,
        },
      },
    });
    void res;

    const raw = await fs.readFile(jsonPath, "utf8");
    const parsed = JSON.parse(raw) as LottieJson;
    const frameCount = Math.max(1, Math.round(parsed.op - parsed.ip));

    // The web path is the browser playing the Lottie. Its frames are
    // the reference the native path is audited against.
    await rasteriseLottie(
      parsed,
      path.join(opts.outputDir, "frames"),
      parsed.w,
      parsed.h,
    );

    // The .js wrapper (a UMD shim some teams need; keeps jsPath in the contract).
    const jsPath = path.join(opts.outputDir, "hero.js");
    await fs.writeFile(jsPath, makeUmd(jsonPath, opts.minify));
    return {
      jsonPath, jsPath, frameCount, fr: parsed.fr,
    };
  } finally {
    await client.close();
  }
}

export function hasExpressions(lottie: LottieJson): boolean {
  // Walk every property node; `x` means a live expression string in Lottie.
  const walk = (v: unknown): boolean => {
    if (Array.isArray(v)) return v.some(walk);
    if (v && typeof v === "object") {
      const o = v as Record<string, unknown>;
      if (typeof o["x"] === "string" && o["x"].length > 0) return true;
      return Object.values(o).some(walk);
    }
    return false;
  };
  return walk(lottie.layers);
}

export function makeUmd(jsonPath: string, minify: boolean): string {
  const body = `module.exports={jsonUrl:new URL(${JSON.stringify(path.basename(jsonPath))},import.meta.url).href};`;
  return minify ? body : `/* generated */\n${body}\n`;
}


// ---------------------------------------------------------------------
// VP9 encode + decode (single pass, frame-count gated)
// ---------------------------------------------------------------------
export interface Vp9SequenceOptions {
  readonly pngDir: string;
  readonly webmPath: string;
  readonly decodedDir: string;
  readonly frameCount: number;
  readonly targetFps: 30 | 60 | 120;
  readonly crf: number;
  readonly alphaMode: "straight" | "premultiplied";
}

/**
 * Encode a PNG sequence to VP9 with an alpha plane, verify the encoded frame
 * count and decode it back to PNGs for the parity audit. Straight alpha is
 * what the rasteriser produces, so a premultiplied pipeline multiplies on
 * the way in and divides back out on the way out.
 */
export async function encodeVp9Sequence(opts: Vp9SequenceOptions): Promise<void> {
  const premultiplied = opts.alphaMode === "premultiplied";
  await fs.mkdir(path.dirname(opts.webmPath), { recursive: true });
  await pexec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-framerate", String(opts.targetFps),
    "-i", path.join(opts.pngDir, "f_%05d.png"),
    ...(premultiplied ? ["-vf", "premultiply=inplace=1"] : []),
    "-c:v", "libvpx-vp9",
    "-pix_fmt", "yuva420p",
    "-auto-alt-ref", "0",
    "-crf", String(opts.crf), "-b:v", "0",
    "-deadline", "good", "-cpu-used", "2",
    "-row-mt", "1",
    "-color_primaries", "bt709", "-color_trc", "bt709",
    "-colorspace", "bt709", "-color_range", "tv",
    opts.webmPath,
  ]);

  const { stdout } = await pexec("ffprobe", [
    "-v", "error", "-count_frames",
    "-select_streams", "v:0",
    "-show_entries", "stream=nb_read_frames",
    "-of", "default=noprint_wrappers=1:nokey=1",
    opts.webmPath,
  ]);
  const encoded = Number(stdout.trim());
  if (encoded !== opts.frameCount) {
    throw new Error(`VP9 frame-count mismatch: encoded ${encoded}, expected ${opts.frameCount}`);
  }

  await fs.mkdir(opts.decodedDir, { recursive: true });
  await pexec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-i", opts.webmPath,
    ...(premultiplied ? ["-vf", "unpremultiply=inplace=1"] : []),
    "-pix_fmt", "rgba",
    "-start_number", "0",
    path.join(opts.decodedDir, "f_%05d.png"),
  ]);
}

// ---------------------------------------------------------------------
// Native bundle
// ---------------------------------------------------------------------
export async function renderNativeBundle(
  lottie: LottieJson, opts: NativeBundleOptions,
): Promise<NativeBundle> {
  const frameCount = Math.max(1, Math.round(lottie.op - lottie.ip));
  if (frameCount > opts.lottieFrameBudget) {
    throw new Error(`native: ${frameCount} frames exceeds budget ${opts.lottieFrameBudget}`);
  }

  const client = await spawnEffectCraft();
  try {
    const pngDir = path.join(opts.outputDir, "png");
    await fs.mkdir(pngDir, { recursive: true });

    // The native path rasterises the same Lottie and encodes the
    // sequence. Both paths start from the same source, so the audit
    // measures the encode round trip rather than the renderer.
    let sourcePngs: string[];
    try {
      sourcePngs = await rasteriseLottie(
        lottie,
        pngDir,
        lottie.w,
        lottie.h,
      );
    } catch (err) {
      // Fallback diagnostic per the exercise spec: list the render
      // commands the engine does expose, so the maintainer can see
      // the state without leaving the terminal.
      const listRes = await client.callTool({
        name: "list_commands",
        arguments: { filter: "render" },
      });
      console.error("Reachable render commands:", JSON.stringify(listRes, null, 2));
      throw err;
    }

    const webmPath = path.join(opts.outputDir, "hero.webm");
    await encodeVp9Sequence({
      pngDir,
      webmPath,
      decodedDir: path.join(opts.outputDir, "decoded"),
      frameCount,
      targetFps: opts.targetFps,
      crf: opts.crf,
      alphaMode: opts.alphaMode,
    });

    return { webmPath, frameCount, sourcePngs };
  } finally {
    await client.close();
  }
}

// ---------------------------------------------------------------------
// Headless rasteriser
// ---------------------------------------------------------------------
/**
 * `puppeteer-core` never downloads a browser: it drives the Chrome that
 * is already installed, which keeps a 150 MB download out of every CI
 * image.
 */
const CHROME_PATH =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/**
 * Render every frame of a Lottie animation into `outDir` as
 * `f_00000.png`, `f_00001.png`, … and return the paths in order.
 *
 * The frame count comes from the document itself (`op - ip`), which is
 * the only definition both playback paths can agree on.
 */
export async function rasteriseLottie(
  lottie: LottieJson,
  outDir: string,
  width: number,
  height: number,
): Promise<string[]> {
  await fs.mkdir(outDir, { recursive: true });

  // `require.resolve` gives us the absolute path of the lottie-web
  // bundle inside node_modules, so the render never touches the network.
  const require = createRequire(import.meta.url);
  const lottieScriptPath = require.resolve(
    "lottie-web/build/player/lottie.min.js",
  );

  const browser: Browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME_PATH,
    args: [
      "--no-sandbox",            // required inside most CI containers
      "--disable-dev-shm-usage", // avoids /dev/shm exhaustion under Docker
      "--force-color-profile=srgb",
      "--disable-gpu-compositing",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width, height, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html>
       <html>
         <head><meta charset="utf-8" /></head>
         <body style="margin:0;background:transparent">
           <div id="stage" style="width:${width}px;height:${height}px"></div>
         </body>
       </html>`,
      { waitUntil: "domcontentloaded" },
    );
    // The bundle is injected rather than linked: a page created by
    // `setContent` has an `about:blank` origin and Chromium refuses to
    // load a `file://` subresource from it.
    const bundle = await fs.readFile(lottieScriptPath, "utf8");
    await page.addScriptTag({ content: bundle });

    await page.evaluate((data: unknown): void => {
      const stage = document.getElementById("stage");
      if (!stage) throw new Error("#stage is missing from the DOM");
      if (!window.lottie) throw new Error("lottie-web did not load");
      window.__anim = window.lottie.loadAnimation({
        container: stage,
        renderer: "canvas",
        loop: false,
        autoplay: false,
        animationData: data,
        rendererSettings: { clearCanvas: true, preserveAspectRatio: "xMidYMid meet" },
      });
    }, lottie as unknown);

    const totalFrames: number = await page.evaluate((): number => {
      const anim = window.__anim;
      if (!anim) throw new Error("animation handle was never assigned");
      return Math.round(anim.totalFrames);
    });

    const paths: string[] = [];
    for (let i = 0; i < totalFrames; i++) {
      const framePath = path.join(outDir, `f_${String(i).padStart(5, "0")}.png`);
      await page.evaluate((frame: number): void => {
        const anim = window.__anim;
        if (!anim) throw new Error("animation handle missing");
        anim.goToAndStop(frame, true);
      }, i);
      // Yield to the compositor so the canvas has been painted before it
      // is scraped; without this the capture is often the previous frame.
      await page.evaluate(
        () => new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); }),
      );
      await page.screenshot({ path: framePath, type: "png", omitBackground: true });
      paths.push(framePath);
    }
    return paths;
  } finally {
    await browser.close();
  }
}

// ---------------------------------------------------------------------
// Parity auditor
// ---------------------------------------------------------------------
export class XorShift32 {
  private s: number;
  constructor(seed: number) { this.s = seed >>> 0 || 0x9e3779b9; }
  next(): number {
    let x = this.s;
    x ^= x << 13; x >>>= 0;
    x ^= x >>> 17;
    x ^= x << 5;  x >>>= 0;
    this.s = x;
    return x;
  }
  uniformInt(maxExclusive: number): number {
    if (!Number.isInteger(maxExclusive) || maxExclusive < 1 || maxExclusive > 0x100000000) {
      throw new RangeError(`uniformInt: maxExclusive must be in [1, 2^32], got ${maxExclusive}`);
    }
    // The full 32-bit range needs no reduction; using the rejection loop
    // would compute lim = 0 and spin forever.
    if (maxExclusive === 0x100000000) return this.next();
    // Rejection sampling keeps the distribution exactly uniform.
    const lim = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
    let v: number;
    do { v = this.next(); } while (v >= lim);
    return v % maxExclusive;
  }
}

export class ParityAuditor {
  sampleFrames(n: number, seed: number): number[] {
    const rng = new XorShift32(seed);
    const set = new Set<number>();
    while (set.size < n) set.add(rng.uniformInt(0x100000000));
    return [...set];
  }

  // 64-bit dHash over a 9x8 grayscale downsample.
  async perceptualHash(png: Uint8Array): Promise<string> {
    // `execFile` has no stdin channel, so the bytes are staged in a
    // temporary file and removed again straight away.
    const staging = path.join(
      os.tmpdir(),
      `lottie-parity-${process.pid}-${hashCounter++}.png`,
    );
    await fs.writeFile(staging, png);
    // Decode to 9x8 grayscale using ffmpeg (single-shot, no native deps).
    const { stdout } = await pexec("ffmpeg", [
      "-v", "error", "-i", staging,
      "-vf", "scale=9:8:flags=area,format=gray",
      "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ], { encoding: "buffer", maxBuffer: 1 << 20 });
    const buf = stdout as unknown as Buffer;
    if (buf.length < 72) throw new Error("perceptualHash: ffmpeg returned short gray buffer");
    await fs.rm(staging, { force: true });
    // 9x8 → 8x8 dHash: bit set when pixel (x,y) > pixel (x+1,y).
    let bits = 0n;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const a = buf[y * 9 + x] ?? 0;
        const b = buf[y * 9 + x + 1] ?? 0;
        bits = (bits << 1n) | (a > b ? 1n : 0n);
      }
    }
    return bits.toString(16).padStart(16, "0");
  }

  async assertParity(
    web: WebBundle, native: NativeBundle, sample: number[],
  ): Promise<ParityReport> {
    const samples: FrameSample[] = [];
    const histogram: Record<string, number> = {};
    let maxDelta = 0;

    for (const idx of sample) {
      const i = idx % Math.min(web.frameCount, native.frameCount);
      const frame = `f_${String(i).padStart(5, "0")}.png`;
      const webPng = path.join(path.dirname(web.jsonPath), "frames", frame);
      const nativePng = path.join(path.dirname(native.webmPath), "decoded", frame);
      if (!native.sourcePngs[i]) throw new Error(`missing native frame ${i}`);

      const [webHash, nativeHash] = await Promise.all([
        this.perceptualHash(await fs.readFile(webPng)),
        this.perceptualHash(await fs.readFile(nativePng)),
      ]);
      const hamming = hammingDistance(webHash, nativeHash);
      samples.push({ index: i, webHash, nativeHash, hamming });
      histogram[String(hamming)] = (histogram[String(hamming)] ?? 0) + 1;
      if (hamming > maxDelta) maxDelta = hamming;
    }

    return {
      samples, maxDelta,
      pass: maxDelta <= 3,
      histogram,
    };
  }
}

export function hammingDistance(aHex: string, bHex: string): number {
  const a = BigInt("0x" + aHex);
  const b = BigInt("0x" + bHex);
  let x = a ^ b;
  let count = 0;
  while (x > 0n) { count += Number(x & 1n); x >>= 1n; }
  return count;
}
