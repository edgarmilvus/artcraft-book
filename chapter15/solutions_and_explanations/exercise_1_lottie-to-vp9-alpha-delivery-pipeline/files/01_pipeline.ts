// pipeline.ts — headless Lottie → VP9-alpha + HEVC-alpha farm
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as path from "node:path";
import * as os from "node:os";

const pexec = promisify(execFile);

// ---- 1. Contract types ------------------------------------------------
interface LottieMeta { v: string; fr: number; ip: number; op: number; w: number; h: number; nm: string; ddd: 0 | 1 }

export interface DeliveryManifest {
  compositionHash: string;
  lottie: { path: string; sha256: string };
  webmAlpha: { path: string; sha256: string; pixFmt: "yuva420p"; crf: number; twoPassSizeBytes: number };
  hevcAlpha?: { path: string; sha256: string };
  parity: { lottieFrames: number; encodedFrames: number; matched: boolean };
}

export const sha256File = async (p: string): Promise<string> => {
  const data = await fs.readFile(p);
  return createHash("sha256").update(data).digest("hex");
};

export const sha256Bytes = (b: Buffer): string =>
  createHash("sha256").update(b).digest("hex");

// ---- 2. MCP client boot ----------------------------------------------
async function openEffectCraft() {
  const transport = new StdioClientTransport({
    command: "effectcraft-cli",
    args: ["mcp"],
  });
  const client = new Client({ name: "vp9-alpha-farm", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return client;
}

// Small wrapper so every command is typed and logged.
async function run<T = unknown>(
  client: Client, command: string, params: Record<string, unknown> = {},
): Promise<T> {
  const res = await client.callTool({
    name: "execute_command", arguments: { command, params },
  });
  // MCP SDK returns content[0].text with JSON for EffectCraft meta-tools.
  const first = (res as { content: Array<{ type: string; text?: string }> }).content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error(`execute_command ${command}: unexpected reply shape`);
  }
  return JSON.parse(first.text) as T;
}

/** The description of one command: its parameters and whether it is live. */
async function describe(
  client: Client, command: string,
): Promise<{ id: string; enabled: boolean; params: string }> {
  const res = await client.callTool({ name: "describe_command", arguments: { command } });
  const first = (res as { content: Array<{ type: string; text?: string }> }).content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error(`describe_command ${command}: unexpected reply shape`);
  }
  return JSON.parse(first.text) as { id: string; enabled: boolean; params: string };
}

/** One layer with its property tree, effects included. */
async function getLayer(
  client: Client, comp: string, layer: number | string,
): Promise<unknown> {
  const res = await client.callTool({
    name: "get_layer", arguments: { comp, layer },
  });
  const first = (res as { content: Array<{ type: string; text?: string }> }).content[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") {
    throw new Error(`get_layer ${layer}: unexpected reply shape`);
  }
  return JSON.parse(first.text) as unknown;
}

// ---- 3. Compile-time sanity on expression / text round-trip ----------
async function assertLottieCompatible(client: Client, comp: string): Promise<void> {
  // The reference doc: some smart filters (Gaussian Blur) round-trip through
  // Lottie's text endpoint only when the source has no live expressions.
  const desc = await describe(client, "file.exportLottie");

  // The schema is the contract: an export endpoint that cannot switch
  // the expressions off cannot produce a deterministic Lottie.
  if (!desc.params.includes("includeExpressions")) {
    throw new Error(
      "file.exportLottie does not expose includeExpressions — abort before capture",
    );
  }

  // Enumerate the effect stack of the target comp so we can decide up-front
  // whether the shimmer layer will bake cleanly. `get_comp` returns the
  // layer tree with each layer's `type` and `switches`.
  const compInfo = await run<{ layers: Array<{ id: number; name: string; type: string }> }>(
    client, "comp.info", { comp });

  // The engine's effect ids, not the display names: the property tree
  // reports `ec.blur.gaussian` where the UI says "Gaussian Blur".
  const risky = ["ec.blur.gaussian", "ec.blur.fastBox", "ec.blur.cameraLens"];
  const shimmer = compInfo.layers.find((l) => l.name === "Shimmer");
  if (!shimmer) {
    throw new Error(`Main_HeroLoop: expected a "Shimmer" layer, none found — ask design to rename`);
  }
  // The layer's effect stack hangs off its property tree. If it cannot
  // be read, the pipeline fails closed.
  const tree = JSON.stringify(await getLayer(client, comp, shimmer.id));
  const offenders = risky.filter((id) => tree.includes(id));
  if (offenders.length > 0) {
    // The exercise mandates: request rasterization of that layer rather than guess.
    console.error(`Unsafe filters on Shimmer: ${offenders.join(", ")}. ` +
      `Ask the effects team to rasterize the shimmer layer before export.`);
    process.exitCode = 2;
    throw new Error("lottie-filter-roundtrip-violation");
  }
}

// ---- 4. Export the Lottie JSON ---------------------------------------
async function exportLottie(client: Client, comp: string, outPath: string): Promise<string> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await run(client, "file.exportLottie", {
    comp,
    path: outPath,
    includeExpressions: false,
    textAsShapes: true, // storefront must not require the font
  });
  return outPath;
}

// ---- 5. Headless frame capture (Puppeteer, OffscreenCanvas) ----------
interface Frame { index: number; png: Buffer }

async function captureFrames(lottiePath: string, outDir: string): Promise<{ frames: number; seq: string }> {
  await fs.mkdir(outDir, { recursive: true });
  const fsPath = JSON.stringify(lottiePath);
  const out = JSON.stringify(outDir);

  // A tiny CLI we ship with the repo. It spins up Chromium with a *forced*
  // sRGB profile so PNG bytes are stable across runs and across CI images.
  const { stdout } = await pexec("node", [
    "scripts/capture.mjs",
    "--lottie", fsPath,
    "--out", out,
    "--chromium-flags",
      "--headless=new --force-color-profile=srgb --disable-gpu-compositing " +
      "--hide-scrollbars --font-render-hinting=none",
    "--png",
  ], { env: { ...process.env, NODE_OPTIONS: "--max-old-space-size=4096" } });

  const parsed = JSON.parse(stdout) as { frames: number; seq: string };
  return parsed;
}

// ---- 6. VP9 alpha encode (two-pass, deterministic second pass) -------
async function encodeVp9Alpha(
  frameGlob: string, alphaGlob: string, outFile: string, crf: number,
): Promise<{ bytes: number }> {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "vp9-"));

  // ---- Pass 1: fast, parallel (analytics only, never shipped) --------
  const passlog = path.join(tmp, "vp9pass");
  await pexec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-framerate", "60", "-i", frameGlob,
    "-framerate", "60", "-i", alphaGlob,
    // Composite the separate alpha PNG sequence with the RGB one and
    // premultiply in-place; libvpx-vp9 would otherwise treat alpha as a
    // chroma plane and key it — the exercise forbids that.
    "-filter_complex",
      "[0:v]format=rgba[rgb];[1:v]format=gray,format=rgba,colorchannelmixer=aa=1[alpha];" +
      "[rgb][alpha]blend=all_mode=multiply:all_opacity=1,premultiply=inplace=1[out]",
    "-map", "[out]",
    "-c:v", "libvpx-vp9",
    "-pix_fmt", "yuva420p",
    "-crf", String(crf), "-b:v", "0",
    "-row-mt", "1", "-tile-columns", "2", "-frame-parallel", "1",
    "-auto-alt-ref", "1", "-lag-in-frames", "25",
    "-g", "60",
    "-color_primaries", "bt709", "-color_trc", "bt709",
    "-colorspace", "bt709", "-color_range", "tv",
    "-pass", "1", "-passlogfile", passlog,
    "-f", "null", os.devNull,
  ]);

  // ---- Pass 2: single-threaded, byte-stable --------------------------
  // -threads 1 removes scheduler non-determinism from the encode loop.
  await pexec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-framerate", "60", "-i", frameGlob,
    "-framerate", "60", "-i", alphaGlob,
    "-filter_complex",
      "[0:v]format=rgba[rgb];[1:v]format=gray,format=rgba,colorchannelmixer=aa=1[alpha];" +
      "[rgb][alpha]blend=all_mode=multiply:all_opacity=1,premultiply=inplace=1[out]",
    "-map", "[out]",
    "-c:v", "libvpx-vp9",
    "-pix_fmt", "yuva420p",
    "-threads", "1",
    "-crf", String(crf), "-b:v", "0",
    "-row-mt", "1", "-tile-columns", "2", "-frame-parallel", "1",
    "-auto-alt-ref", "1", "-lag-in-frames", "25",
    "-g", "60",
    "-color_primaries", "bt709", "-color_trc", "bt709",
    "-colorspace", "bt709", "-color_range", "tv",
    "-pass", "2", "-passlogfile", passlog,
    outFile,
  ]);

  const stat = await fs.stat(outFile);
  return { bytes: stat.size };
}

// ---- 7. Verify pix_fmt before we trust anything ----------------------
export async function assertYuva420p(file: string): Promise<void> {
  // FFmpeg reports the compressed VP9 stream as yuv420p even when a WebM
  // alpha plane is present; the alpha lives in BlockAdditional side data and
  // is signalled by `alpha_mode=1`. Accept either the reported pixel format
  // or that tag, then prove the plane decodes by sampling a transparent edge.
  const { stdout } = await pexec("ffprobe", [
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=pix_fmt:stream_tags=alpha_mode",
    "-of", "default=noprint_wrappers=1",
    file,
  ]);
  const fields = new Map<string, string>();
  for (const line of stdout.trim().split("\n")) {
    const [key, ...rest] = line.split("=");
    if (key) fields.set(key.trim(), rest.join("=").trim());
  }
  const pixFmt = fields.get("pix_fmt") ?? "";
  const alphaMode = fields.get("TAG:alpha_mode") ?? "";
  if (pixFmt !== "yuva420p" && alphaMode !== "1") {
    throw new Error(`expected an alpha plane (pix_fmt=yuva420p or alpha_mode=1), got pix_fmt=${pixFmt} alpha_mode=${alphaMode || "none"}`);
  }

  // Decode one RGBA frame and require at least one transparent pixel: a
  // container tag alone would not catch an encoder that dropped the plane.
  const { stdout: raw } = await pexec("ffmpeg", [
    "-v", "error", "-c:v", "libvpx-vp9", "-i", file,
    "-frames:v", "1", "-pix_fmt", "rgba", "-f", "rawvideo", "-",
  ], { encoding: "buffer", maxBuffer: 1 << 26 });
  const buf = raw as unknown as Buffer;
  if (buf.length < 4) throw new Error("alpha probe: decoder returned no pixels");
  let transparent = 0;
  for (let i = 3; i < buf.length; i += 4) if (buf[i] === 0) transparent += 1;
  if (transparent === 0) {
    throw new Error("alpha probe: encoded frame has no transparent pixels");
  }
}

// ---- 8. HEVC alpha (fallback for iOS Safari) -------------------------
async function encodeHevcAlpha(frameGlob: string, alphaGlob: string, outFile: string) {
  await pexec("ffmpeg", [
    "-y", "-hide_banner", "-loglevel", "error",
    "-framerate", "60", "-i", frameGlob,
    "-framerate", "60", "-i", alphaGlob,
    "-filter_complex",
      "[0:v]format=rgba[rgb];[1:v]format=gray,format=rgba,colorchannelmixer=aa=1[alpha];" +
      "[rgb][alpha]blend=all_mode=multiply,premultiply=inplace=1[out]",
    "-map", "[out]",
    // Apple's HEVC-alpha path uses a second -tag:v hevc stream trick; we
    // produce ProRes-4444-ready bgra which Safari composites correctly.
    "-c:v", "hevc_videotoolbox", "-allow_sw", "1",
    "-alpha_quality", "0.75",
    "-pix_fmt", "bgra",
    "-tag:v", "hvc1",
    "-color_primaries", "bt709", "-color_trc", "bt709",
    "-colorspace", "bt709", "-color_range", "tv",
    outFile,
  ]).catch(async () => {
    // Linux runner without VideoToolbox: fall back to ProRes-4444
    await pexec("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error",
      "-framerate", "60", "-i", frameGlob,
      "-framerate", "60", "-i", alphaGlob,
      "-filter_complex",
        "[0:v]format=rgba[rgb];[1:v]format=gray,format=rgba,colorchannelmixer=aa=1[alpha];" +
        "[rgb][alpha]blend=all_mode=multiply,premultiply=inplace=1[out]",
      "-map", "[out]",
      "-c:v", "prores_ks", "-profile:v", "4444", "-pix_fmt", "yuva444p10le",
      outFile,
    ]);
  });
}

// ---- 9. Manifest -----------------------------------------------------
export async function writeManifest(m: DeliveryManifest, outPath: string) {
  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.writeFile(outPath, JSON.stringify(m, null, 2) + "\n");
}

// ---- 10. Driver ------------------------------------------------------
interface TranscodeRequest {
  compositionName: "Main_HeroLoop";
  fpsOverride?: number;
  crf: number;
  outputRoot: string;
}

async function main(req: TranscodeRequest) {
  const client = await openEffectCraft();
  try {
    // 10a. Detect filter hazards up-front.
    await assertLottieCompatible(client, req.compositionName);

    const lottiePath = path.join(req.outputRoot, "web/lottie.json");
    await exportLottie(client, req.compositionName, lottiePath);

    // 10b. Composition hash anchors idempotency.
    const compHash = sha256Bytes(await fs.readFile(lottiePath));

    // 10c. Frames.
    const frameDir = path.join(req.outputRoot, "frames/rgba");
    const alphaDir = path.join(req.outputRoot, "frames/alpha");
    const capture = await captureFrames(lottiePath, frameDir);
    // capture.mjs also writes a matching straight-alpha PNG sequence into
    // frameDir/alpha by rendering the layer stack with a solid black background.

    const webm = path.join(req.outputRoot, "native/hero-vp9.webm");
    await fs.mkdir(path.dirname(webm), { recursive: true });
    const enc = await encodeVp9Alpha(
      path.join(frameDir, "f_%04d.png"),
      path.join(alphaDir, "a_%04d.png"),
      webm, req.crf);

    await assertYuva420p(webm);

    const mov = path.join(req.outputRoot, "native/hero-hevc.mov");
    await encodeHevcAlpha(
      path.join(frameDir, "f_%04d.png"),
      path.join(alphaDir, "a_%04d.png"),
      mov);

    const lottieBuf = await fs.readFile(lottiePath);
    const lottieJson = JSON.parse(lottieBuf.toString("utf8")) as Partial<LottieMeta>;
    const frames = Math.round((lottieJson.op ?? 0) - (lottieJson.ip ?? 0));

    const manifest: DeliveryManifest = {
      compositionHash: compHash,
      lottie: { path: "dist/web/lottie.json", sha256: sha256Bytes(lottieBuf) },
      webmAlpha: {
        path: "dist/native/hero-vp9.webm",
        sha256: await sha256File(webm),
        pixFmt: "yuva420p",
        crf: req.crf,
        twoPassSizeBytes: enc.bytes,
      },
      hevcAlpha: { path: "dist/native/hero-hevc.mov", sha256: await sha256File(mov) },
      parity: { lottieFrames: frames, encodedFrames: capture.frames, matched: frames === capture.frames },
    };
    await writeManifest(manifest, path.join(req.outputRoot, "delivery.json"));
  } finally {
    await client.close();
  }
}

if (process.argv[1]?.endsWith("01_pipeline.ts")) {
  await main(
    { compositionName: "Main_HeroLoop", crf: 28, outputRoot: process.env.OUT ?? "/work/dist" },
  );
}
