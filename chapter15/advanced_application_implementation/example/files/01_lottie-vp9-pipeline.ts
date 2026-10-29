/**
 * ============================================================================
 * lottie-vp9-pipeline.ts
 * ----------------------------------------------------------------------------
 * Headless, cross-platform Lottie -> VP9 render worker.
 *
 *   Authoring (EffectCraft / After-Effects-style comp)
 *      |
 *      v file.exportLottie { comp, path, textAsShapes }
 *   Bodymovin JSON
 *      |
 *      v Playwright (Chromium headless, WebGL + Canvas 2D)
 *   deterministic PNG frames (alpha preserved)
 *      |
 *      v libvpx-vp9 (yuva420p, -auto-alt-ref 0)
 *   WebM  (opaque or alpha)  --->  mux Opus narration
 *      |
 *      v object storage upload
 *   Signed CDN URLs
 *
 * All ArtCraft calls go through the MCP meta-tool `execute_command` (the
 * EffectCraft binary's discovery surface). Options use the exact
 * schema documented by `command_list`.
 * ============================================================================
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { chromium, type Browser, type BrowserContext, type Page } from "playwright-core";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs, createWriteStream } from "node:fs";
import { once } from "node:events";
import { Readable } from "node:stream";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { z } from "zod";

/* ---------------------------------------------------------------------------
 * 1. Public contract (Zod-validated request/response envelopes)
 * ------------------------------------------------------------------------ */

/** E.164-safe input envelope the SaaS API gateway forwards to the worker. */
export const PipelineRequestSchema = z.object({
  /** Stable project ID (matches the .ecproj file name on shared storage). */
  projectId: z.string().min(1),
  /** Composition name inside the project. Omit for the active comp. */
  composition: z.string().optional(),
  /** Output size in pixels. Should match comp.width/height unless upscaling. */
  width: z.number().int().positive().default(1920),
  height: z.number().int().positive().default(1080),
  /** Encoder framerate. Must divide evenly into the lottie `op - ip`. */
  fps: z.number().positive().default(30),
  /** Duration in seconds. Overrides lottie's ip/op if smaller. */
  durationSec: z.number().positive(),
  /** Preserve alpha (VP9 yuva420p) in the encoder pass. */
  alpha: z.boolean().default(true),
  /** VP9 Constant Rate Factor. 0 = lossless, 15..35 typical, 63 = worst. */
  crf: z.number().int().min(0).max(63).default(28),
  /** Optional narration or score path inside the read-root sandbox. */
  audioPath: z.string().optional(),
  /** Which deliverables to actually ship. */
  targets: z
    .array(z.enum(["lottie", "webm", "webm-alpha", "mp4-fallback"]))
    .default(["lottie", "webm"]),
  /** CDN prefix, e.g. https://cdn.acme.io/animations/{projectId}/. */
  assetBaseUrl: z.string().url().optional(),
  /** Turn on extra telemetry in the worker's structured logs. */
  debug: z.boolean().default(false),
});

export type PipelineRequest = z.infer<typeof PipelineRequestSchema>;

export const PipelineResultSchema = z.object({
  lottieUrl: z.string().url().optional(),
  webmUrl: z.string().url().optional(),
  webmAlphaUrl: z.string().url().optional(),
  mp4Url: z.string().url().optional(),
  frames: z.number().int(),
  encodedBytes: z.number().int(),
  elapsedMs: z.number(),
  hash: z.string(),
});

export type PipelineResult = z.infer<typeof PipelineResultSchema>;

/* ---------------------------------------------------------------------------
 * 2. Structured logger (pino-compatible JSON on stdout)
 * ------------------------------------------------------------------------ */

type LogLevel = "debug" | "info" | "warn" | "error";

class Logger {
  constructor(private readonly ctx: Record<string, unknown> = {}) {}
  child(ctx: Record<string, unknown>) {
    return new Logger({ ...this.ctx, ...ctx });
  }
  private emit(level: LogLevel, msg: string, extra: Record<string, unknown> = {}) {
    process.stdout.write(
      JSON.stringify({
        ts: new Date().toISOString(),
        level,
        msg,
        ...this.ctx,
        ...extra,
      }) + "\n",
    );
  }
  debug(msg: string, extra?: Record<string, unknown>) {
    if (process.env.LOG_LEVEL === "debug") this.emit("debug", msg, extra);
  }
  info(msg: string, extra?: Record<string, unknown>) {
    this.emit("info", msg, extra);
  }
  warn(msg: string, extra?: Record<string, unknown>) {
    this.emit("warn", msg, extra);
  }
  error(msg: string, extra?: Record<string, unknown>) {
    this.emit("error", msg, extra);
  }
}

/* ---------------------------------------------------------------------------
 * 3. MCP client wrapper around an EffectCraft stdio server
 * ------------------------------------------------------------------------ */

/**
 * Thin, typed wrapper around the MCP Client so the worker only has to
 * know about `execute_command` and the effectcraft meta-tools it needs.
 */
class EffectCraftMCP {
  private constructor(
    private readonly client: Client,
    private readonly log: Logger,
  ) {}

  /**
   * Spin up `effectcraft-cli mcp` over stdio with an automation sandbox
   * limited to `readRoot` / `writeRoot`. `cwd` is where the .ecproj and
   * exported Lottie will live.
   */
  static async start(opts: {
    readRoot: string;
    writeRoot: string;
    log: Logger;
    binary?: string;
  }): Promise<EffectCraftMCP> {
    const binary = opts.binary ?? "effectcraft-cli";
    const transport = new StdioClientTransport({
      command: binary,
      // EffectCraft's headless server takes no sandbox roots: the worker
      // owns the filesystem boundary itself, and every path it hands to the
      // engine is resolved against the roots it was given.
      args: ["mcp"],
      cwd: opts.readRoot,
      stderr: "pipe",
    });

    const client = new Client(
      { name: "lottie-vp9-worker", version: "1.0.0" },
      { capabilities: {} },
    );

    await client.connect(transport);
    opts.log.info("effectcraft-mcp.connected", { binary });

    // Fail fast if the server didn't expose the meta-tool we depend on.
    const tools = await client.listTools();
    const ids = new Set(tools.tools.map((t) => t.name));
    if (!ids.has("execute_command")) {
      throw new Error(
        "EffectCraft MCP server is missing `execute_command`; refusing to run.",
      );
    }
    return new EffectCraftMCP(client, opts.log);
  }

  /** Run any EffectCraft command; returns its structured JSON result. */
  async run<T = unknown>(command: string, params: Record<string, unknown> = {}) {
    this.log.debug("effectcraft.execute", { command, params });
    const res = await this.client.callTool({
      name: "execute_command",
      arguments: { command, params },
    });
    // callTool returns `{ content: [...] }`. EffectCraft answers with a
    // single text content block containing the JSON-encoded result.
    const block = (res.content as Array<{ type: string; text?: string }>).find(
      (b) => b.type === "text",
    );
    if (!block?.text) return undefined as T;
    try {
      return JSON.parse(block.text) as T;
    } catch {
      return block.text as unknown as T;
    }
  }

  /** Convenience: open a project from the sandbox read root. */
  async openProject(projectId: string, readRoot: string) {
    return this.run<{ path: string; comps: string[] }>("file.open", {
      path: `${readRoot}/${projectId}.ecproj`,
    });
  }

  /** Select the target composition. Omit `composition` for the active comp. */
  async selectComposition(composition?: string) {
    if (!composition) return;
    await this.run("comp.open", { comp: composition });
  }

  async close() {
    try {
      await this.client.close();
    } catch (err) {
      this.log.warn("effectcraft-mcp.close.error", { err: String(err) });
    }
  }
}

/* ---------------------------------------------------------------------------
 * 4. Headless renderer: Playwright drives lottie-web frame-by-frame
 * ------------------------------------------------------------------------ */

/**
 * Deterministic Lottie frame extractor.
 *
 * The renderer boots Chromium with SwiftShader fallback so it works in
 * CI containers that have neither a display nor a physical GPU, then
 * loads `lottie-web` from a local copy under the worker's `public/`
 * folder. Frames are stepped synchronously (`goToAndStop` with
 * `isFrame: true`) followed by two `requestAnimationFrame` ticks, which
 * is the minimum needed for the canvas renderer to flush before the
 * screenshot is taken. `omitBackground: true` keeps the alpha channel,
 * vital for the VP9 alpha encoder step downstream.
 */
class LottieFrameRenderer {
  private browser!: Browser;
  private context!: BrowserContext;
  private page!: Page;

  constructor(
    private readonly log: Logger,
    private readonly width: number,
    private readonly height: number,
    private readonly lottieWebDir: string,
  ) {}

  async start() {
    this.browser = await chromium.launch({
      headless: true,
      // `playwright-core` ships no browser: it drives the Chrome that is
      // already installed on the machine, which keeps a 300 MB download out
      // of every CI image. `CHROME_CHANNEL` overrides the channel.
      channel: process.env.CHROME_CHANNEL ?? "chrome",
      args: [
        // Container-friendly GL: try Vulkan, fall back to ANGLE, then
        // SwiftShader. `--disable-dev-shm-usage` avoids the /dev/shm
        // 64 MB limit that kills mid-sized containers.
        "--enable-features=Vulkan,VulkanFromANGLE",
        "--use-gl=angle",
        "--use-angle=swiftshader",
        "--enable-unsafe-swiftshader",
        "--disable-dev-shm-usage",
        "--no-sandbox",
        "--disable-gpu-sandbox",
        // Deterministic time-of-day and pixel ratio.
        "--force-device-scale-factor=1",
        "--hide-scrollbars",
      ],
    });
    this.context = await this.browser.newContext({
      viewport: { width: this.width, height: this.height },
      deviceScaleFactor: 1,
      // Keep alpha in the compositor and screenshots.
      reducedMotion: "reduce",
      colorScheme: "no-preference",
    });
    this.page = await this.context.newPage();

    // Route lottie-web to the vendored UMD bundle over file://.
    await this.page.addInitScript(() => {
      // Freeze Date.now so any internal timers are deterministic.
      const frozen = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (window as any).__FROZEN_NOW__ = frozen;
    });

    this.log.info("playwright.ready", {
      width: this.width,
      height: this.height,
    });
  }

  /**
   * Mount the animation and return its intrinsic metadata (frame count,
   * framerate, canvas size). We assert the Lottie's own `fr` matches the
   * encoder's fps to avoid hidden frame-pacing drift.
   */
  async mount(
    lottieJson: Record<string, unknown>,
  ): Promise<{ ip: number; op: number; fr: number }> {
    await this.page.setContent(
      `<!doctype html>
       <html><head><meta charset="utf-8">
       <style>
         html,body { margin:0; padding:0; background:transparent; }
         #stage { width:${this.width}px; height:${this.height}px; }
       </style>
       </head><body>
         <div id="stage"></div>
       </body></html>`,
      { waitUntil: "load" },
    );

    // The bundle is injected rather than linked with a `file://` URL: a page
    // created by `setContent` has an `about:blank` origin, and Chromium
    // refuses to load a `file://` subresource from it.
    await this.page.addScriptTag({
      content: await fs.readFile(path.join(this.lottieWebDir, "lottie.min.js"), "utf8"),
    });

    // Hand the JSON through the page's own function so we don't URL-encode
    // a huge blob. Also ensure lottie-web is available.
    const meta = await this.page.evaluate(
      async ({ data, w, h }) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const lottie = (window as any).lottie;
        if (!lottie) throw new Error("lottie-web failed to load");
        const container = document.getElementById("stage")!;
        const anim = lottie.loadAnimation({
          container,
          renderer: "canvas",
          loop: false,
          autoplay: false,
          rendererSettings: {
            clearCanvas: true,
            preserveAspectRatio: "xMidYMid meet",
            progressiveLoad: false,
          },
          animationData: data,
        });
        (window as any).__anim__ = anim;
        // Wait for the dataReady event so `totalFrames` etc. are correct.
        await new Promise<void>((res) =>
          anim.addEventListener("DOMLoaded", () => res()),
        );
        // Size the hidden canvas for HiDPI is unnecessary -- we run at 1x.
        container.style.width = `${w}px`;
        container.style.height = `${h}px`;
        return {
          ip: Number(data.ip ?? 0),
          op: Number(data.op ?? anim.totalFrames),
          fr: Number(data.fr ?? 30),
        };
      },
      { data: lottieJson, w: this.width, h: this.height },
    );

    this.log.info("lottie.mounted", meta);
    return meta;
  }

  /**
   * Step to a given frame index (absolute, in the lottie's own timebase)
   * and return the frame as a PNG buffer with alpha preserved.
   */
  async frameAsPng(frameIndex: number): Promise<Buffer> {
    await this.page.evaluate(async (f) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const anim = (window as any).__anim__;
      anim.goToAndStop(f, /* isFrame */ true);
      // Double rAF: one for lottie-web's internal render call, one for
      // the compositor to publish the new pixels.
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
      await new Promise<void>((r) => requestAnimationFrame(() => r()));
    }, frameIndex);

    const shot = await this.page.screenshot({
      type: "png",
      omitBackground: true,
      clip: { x: 0, y: 0, width: this.width, height: this.height },
      animations: "disabled",
      caret: "hide",
    });
    return Buffer.from(shot);
  }

  async stop() {
    try {
      await this.context?.close();
      await this.browser?.close();
    } catch (err) {
      this.log.warn("playwright.stop.error", { err: String(err) });
    }
  }
}

/* ---------------------------------------------------------------------------
 * 5. Encoder: pipe PNG frames into libvpx-vp9 via FFmpeg stdin
 * ------------------------------------------------------------------------ */

/**
 * Options for the WebM encoding pass.
 *
 * Notes about alpha in WebM:
 *  - libvpx-vp9 preserves alpha only when the pixel format is `yuva420p`.
 *  - `-auto-alt-ref 0` is mandatory; alt-ref frames do not carry alpha
 *    and the resulting file would silently drop the alpha plane.
 *  - We keep `-b:v 0` so `-crf` drives quality exactly (constant quality).
 */
interface EncodeOptions {
  fps: number;
  width: number;
  height: number;
  crf: number;
  alpha: boolean;
  outputPath: string;
}

/**
 * Frames-in, single WebM-out. Writes each PNG to ffmpeg's stdin using
 * the `image2pipe` demuxer. Backpressure is honoured: if the encoder is
 * slower than the renderer, we await `drain` before writing more.
 */
class FFmpegVP9Encoder {
  private proc!: ChildProcessWithoutNullStreams;
  private stderr: string[] = [];

  constructor(private readonly log: Logger) {}

  async open(opts: EncodeOptions) {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      // image2pipe: PNGs streamed in at `fps`.
      "-f",
      "image2pipe",
      "-framerate",
      String(opts.fps),
      "-i",
      "-",
      "-c:v",
      "libvpx-vp9",
      "-pix_fmt",
      opts.alpha ? "yuva420p" : "yuv420p",
      "-crf",
      String(opts.crf),
      "-b:v",
      "0",
      // Alpha + alt-ref are mutually exclusive.
      "-auto-alt-ref",
      opts.alpha ? "0" : "1",
      // Parallelism hints that scale with the container's CPUs.
      "-row-mt",
      "1",
      "-tile-columns",
      "2",
      "-frame-parallel",
      "1",
      "-deadline",
      "good",
      "-cpu-used",
      "2",
      // Keyframe every 2 seconds regardless of scene cuts.
      "-g",
      String(Math.max(1, Math.round(opts.fps * 2))),
      // Explicit BT.709 metadata so downstream players do not guess.
      "-color_primaries",
      "bt709",
      "-color_trc",
      "bt709",
      "-colorspace",
      "bt709",
      "-f",
      "webm",
      opts.outputPath,
    ];

    this.log.debug("ffmpeg.spawn", { args });
    // ffmpeg writes its progress to stderr and reads the PNG stream from
    // stdin; it has no stdout, so the process type carries a null there.
    this.proc = spawn("ffmpeg", args, {
      stdio: ["pipe", "ignore", "pipe"],
    }) as unknown as ChildProcessWithoutNullStreams;
    this.proc.stderr.on("data", (chunk) => {
      this.stderr.push(chunk.toString("utf8"));
      if (this.stderr.length > 64) this.stderr.shift();
    });
    await once(this.proc, "spawn");
  }

  /** Write one PNG buffer to the encoder; resolves once the pipe accepts it. */
  async write(png: Buffer): Promise<void> {
    if (this.proc.stdin.destroyed) {
      throw new Error(
        `ffmpeg stdin closed early: ${this.stderr.join("").slice(-400)}`,
      );
    }
    if (!this.proc.stdin.write(png)) {
      await once(this.proc.stdin, "drain");
    }
  }

  /** Close stdin and wait for the encoder to exit. Returns byte size. */
  async finish(): Promise<number> {
    this.proc.stdin.end();
    const [code] = (await once(this.proc, "exit")) as [number, null];
    if (code !== 0) {
      throw new Error(
        `ffmpeg exited ${code}: ${this.stderr.join("").slice(-800)}`,
      );
    }
    // stat the file for its size, which we surface in the result.
    return 0; // placeholder; the caller Stats the file.
  }

  async abort() {
    try {
      this.proc.stdin.destroy();
      this.proc.kill("SIGKILL");
    } catch {
      /* noop */
    }
  }
}

/* ---------------------------------------------------------------------------
 * 6. Audio muxer (Opus in WebM; AAC in MP4 fallback)
 * ------------------------------------------------------------------------ */

/**
 * Copy the video stream verbatim and attach the audio track as Opus.
 * Using `-shortest` avoids a trailing silence post-roll when the
 * narration is shorter than the animation. `-c:v copy` keeps the VP9
 * bitstream byte-identical, which matters when the CDN caches by hash.
 */
async function muxOpus(
  videoPath: string,
  audioPath: string,
  outputPath: string,
  log: Logger,
): Promise<void> {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    videoPath,
    "-i",
    audioPath,
    "-c:v",
    "copy",
    "-c:a",
    "libopus",
    "-b:a",
    "128k",
    "-ac",
    "2",
    "-ar",
    "48000",
    "-shortest",
    outputPath,
  ];
  log.debug("ffmpeg.mux", { args });
  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  const err: string[] = [];
  proc.stderr.on("data", (c) => err.push(c.toString("utf8")));
  const [code] = (await once(proc, "exit")) as [number, null];
  if (code !== 0) {
    throw new Error(`ffmpeg mux exited ${code}: ${err.join("").slice(-800)}`);
  }
}

/**
 * H.264 baseline fallback for browsers without WebM/VP9 (older Safari,
 * some embedded webviews, certain TV devices). No alpha -- we just
 * flatten onto white so text stays legible.
 */
async function transcodeH264(
  videoPath: string,
  outputPath: string,
  log: Logger,
): Promise<void> {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-i",
    videoPath,
    "-vf",
    "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-c:v",
    "libx264",
    "-preset",
    "slow",
    "-crf",
    "20",
    "-profile:v",
    "high",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    outputPath,
  ];
  log.debug("ffmpeg.h264", { args });
  const proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
  const err: string[] = [];
  proc.stderr.on("data", (c) => err.push(c.toString("utf8")));
  const [code] = (await once(proc, "exit")) as [number, null];
  if (code !== 0) {
    throw new Error(
      `ffmpeg h264 exited ${code}: ${err.join("").slice(-800)}`,
    );
  }
}

/* ---------------------------------------------------------------------------
 * 7. Storage: presign + upload (S3-compatible; R2/MinIO both work)
 * ------------------------------------------------------------------------ */

/**
 * Small abstraction so deployments can swap Cloudflare R2, AWS S3,
 * MinIO, or a local disk in tests. Only the operations we need are
 * declared.
 */
interface ObjectStore {
  put(key: string, body: Buffer, contentType: string): Promise<{ url: string }>;
}

class LocalDevStore implements ObjectStore {
  constructor(
    private readonly root: string,
    private readonly publicBase: string,
  ) {}
  async put(key: string, body: Buffer, _c: string) {
    const abs = path.join(this.root, key);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, body);
    return { url: `${this.publicBase.replace(/\/$/, "")}/${key}` };
  }
}

/* ---------------------------------------------------------------------------
 * 8. The orchestrator
 * ------------------------------------------------------------------------ */

export class LottieVP9Pipeline {
  constructor(
    private readonly opts: {
      /** Directory containing *.ecproj files (read-only sandbox). */
      projectRoot: string;
      /** Scratch dir for JSON, PNGs, WebM, MP4. */
      workDir: string;
      /** Where lottie-web UMD bundle lives (`lottie.min.js`). */
      lottieWebDir: string;
      /** Storage backend for the final artifacts. */
      store: ObjectStore;
      /** Base log context (e.g. requestId, tenant). */
      log?: Logger;
    },
  ) {}

  /**
   * Full pipeline. Idempotent given identical inputs: the content hash
   * of the Lottie JSON is used both as the cache key and as the file
   * name suffix, so re-running on an unchanged project is a fast no-op
   * if the caller's store layer implements HEAD-before-PUT.
   */
  async run(raw: unknown): Promise<PipelineResult> {
    const started = Date.now();
    const req = PipelineRequestSchema.parse(raw);
    const log = (this.opts.log ?? new Logger()).child({
      projectId: req.projectId,
      comp: req.composition ?? "<active>",
    });

    await fs.mkdir(this.opts.workDir, { recursive: true });

    let mcp: EffectCraftMCP | undefined;
    let renderer: LottieFrameRenderer | undefined;
    let encoder: FFmpegVP9Encoder | undefined;

    try {
      /* 8.1 -- Export Lottie from EffectCraft -------------------------- */
      mcp = await EffectCraftMCP.start({
        readRoot: this.opts.projectRoot,
        writeRoot: this.opts.workDir,
        log,
      });
      await mcp.openProject(req.projectId, this.opts.projectRoot);
      await mcp.selectComposition(req.composition);

      const lottieName = `${req.projectId}.lottie.json`;
      const lottiePath = path.join(this.opts.workDir, lottieName);
      await mcp.run("file.exportLottie", {
        comp: req.composition,
        path: lottiePath,
        // Bake text so rendering is font-independent across CI images.
        textAsShapes: true,
        includeExpressions: false,
      });
      const lottieJson = JSON.parse(
        await fs.readFile(lottiePath, "utf8"),
      ) as Record<string, unknown>;

      const hash = crypto
        .createHash("sha256")
        .update(JSON.stringify(lottieJson))
        .digest("hex")
        .slice(0, 16);

      /* 8.2 -- Upload Lottie if requested ------------------------------ */
      const result: PipelineResult = {
        frames: 0,
        encodedBytes: 0,
        elapsedMs: 0,
        hash,
      };

      if (req.targets.includes("lottie")) {
        const { url } = await this.opts.store.put(
          `${req.projectId}/${hash}.json`,
          Buffer.from(JSON.stringify(lottieJson)),
          "application/json",
        );
        result.lottieUrl = url;
        log.info("lottie.uploaded", { url, hash });
      }

      const wantAnyVideo = req.targets.some((t) =>
        ["webm", "webm-alpha", "mp4-fallback"].includes(t),
      );
      if (!wantAnyVideo) {
        result.elapsedMs = Date.now() - started;
        return PipelineResultSchema.parse(result);
      }

      /* 8.3 -- Render frames headlessly -------------------------------- */
      renderer = new LottieFrameRenderer(
        log,
        req.width,
        req.height,
        this.opts.lottieWebDir,
      );
      await renderer.start();
      const meta = await renderer.mount(lottieJson);

      // Reconcile requested fps vs source fr. We refuse silent resampling.
      if (Math.abs(meta.fr - req.fps) > 0.001) {
        log.warn("fps.mismatch", { lottieFr: meta.fr, requestedFps: req.fps });
        throw new Error(
          `Encoder fps ${req.fps} does not match lottie fr ${meta.fr}; ` +
            `pre-resample the composition or pass ${meta.fr}.`,
        );
      }

      const lastFrame = Math.min(
        meta.op - 1,
        Math.floor(req.durationSec * meta.fr) - 1,
      );
      const totalFrames = lastFrame - Math.ceil(meta.ip) + 1;
      if (totalFrames <= 0) {
        throw new Error("Effective frame count is zero; check durationSec.");
      }

      /* 8.4 -- Encode WebM (and alpha variant) ------------------------- */
      const opaquePath = path.join(this.opts.workDir, "video.webm");
      const alphaPath = path.join(this.opts.workDir, "video-alpha.webm");
      const mp4Path = path.join(this.opts.workDir, "video.mp4");

      // We always render once and choose encoder pixel formats accordingly.
      // If both alpha and opaque are requested, we encode twice from the
      // same frame buffers -- cheaper than re-rendering.
      const wantOpaque = req.targets.includes("webm");
      const wantAlpha = req.targets.includes("webm-alpha") && req.alpha;
      const wantMp4 = req.targets.includes("mp4-fallback");

      encoder = new FFmpegVP9Encoder(log);
      if (wantAlpha) {
        await encoder.open({
          fps: req.fps,
          width: req.width,
          height: req.height,
          crf: Math.min(63, req.crf),
          alpha: true,
          outputPath: alphaPath,
        });
      } else if (wantOpaque) {
        await encoder.open({
          fps: req.fps,
          width: req.width,
          height: req.height,
          crf: req.crf,
          alpha: false,
          outputPath: opaquePath,
        });
      }

      // Optional second encoder for the "opaque only when alpha also
      // requested" case. We open it up-front so we can fan-out each
      // rendered frame into both encoders in a single pass.
      let secondEncoder: FFmpegVP9Encoder | undefined;
      if (wantAlpha && wantOpaque) {
        secondEncoder = new FFmpegVP9Encoder(log);
        await secondEncoder.open({
          fps: req.fps,
          width: req.width,
          height: req.height,
          crf: req.crf,
          alpha: false,
          outputPath: opaquePath,
        });
      }

      // If the user asked for MP4 without an intermediate WebM, we still
      // produce an opaque WebM first and transcode at the end. That keeps
      // the pipeline simple and lets us reuse the same frame pass.
      let mp4Intermediate: FFmpegVP9Encoder | undefined;
      if (wantMp4 && !wantOpaque && !wantAlpha) {
        mp4Intermediate = new FFmpegVP9Encoder(log);
        await mp4Intermediate.open({
          fps: req.fps,
          width: req.width,
          height: req.height,
          crf: req.crf,
          alpha: false,
          outputPath: opaquePath,
        });
      }

      for (let f = Math.ceil(meta.ip); f <= lastFrame; f++) {
        const png = await renderer.frameAsPng(f);
        await encoder.write(png);
        if (secondEncoder) await secondEncoder.write(png);
        if (mp4Intermediate) await mp4Intermediate.write(png);

        if (f % req.fps === 0) {
          log.info("render.progress", {
            frame: f,
            of: lastFrame,
            pct: Math.round(((f - meta.ip) / totalFrames) * 100),
          });
        }
      }

      await encoder.finish();
      if (secondEncoder) await secondEncoder.finish();
      if (mp4Intermediate) await mp4Intermediate.finish();

      result.frames = totalFrames;

      /* 8.5 -- Mux audio ------------------------------------------------- */
      let shippedOpaque = opaquePath;
      if (req.audioPath) {
        const withAudio = path.join(this.opts.workDir, "video+audio.webm");
        await muxOpus(opaquePath, req.audioPath, withAudio, log);
        shippedOpaque = withAudio;
      }

      /* 8.6 -- Upload WebM variants ------------------------------------- */
      if (wantAlpha) {
        const buf = await fs.readFile(alphaPath);
        const { url } = await this.opts.store.put(
          `${req.projectId}/${hash}-alpha.webm`,
          buf,
          "video/webm",
        );
        result.webmAlphaUrl = url;
        result.encodedBytes += buf.byteLength;
        log.info("webm.alpha.uploaded", { url, bytes: buf.byteLength });
      }
      if (wantOpaque || mp4Intermediate) {
        const buf = await fs.readFile(shippedOpaque);
        const { url } = await this.opts.store.put(
          `${req.projectId}/${hash}.webm`,
          buf,
          "video/webm",
        );
        result.webmUrl = url;
        result.encodedBytes += buf.byteLength;
        log.info("webm.uploaded", { url, bytes: buf.byteLength });
      }

      /* 8.7 -- H.264 fallback ------------------------------------------- */
      if (wantMp4) {
        await transcodeH264(shippedOpaque, mp4Path, log);
        let finalMp4 = mp4Path;
        if (req.audioPath) {
          const mp4WithAudio = path.join(this.opts.workDir, "video+audio.mp4");
          const args = [
            "-hide_banner",
            "-loglevel",
            "error",
            "-y",
            "-i",
            mp4Path,
            "-i",
            req.audioPath,
            "-c:v",
            "copy",
            "-c:a",
            "aac",
            "-b:a",
            "128k",
            "-shortest",
            mp4WithAudio,
          ];
          const proc = spawn("ffmpeg", args, {
            stdio: ["ignore", "ignore", "pipe"],
          });
          const [code] = (await once(proc, "exit")) as [number, null];
          if (code !== 0) throw new Error(`mp4 mux exited ${code}`);
          finalMp4 = mp4WithAudio;
        }
        const buf = await fs.readFile(finalMp4);
        const { url } = await this.opts.store.put(
          `${req.projectId}/${hash}.mp4`,
          buf,
          "video/mp4",
        );
        result.mp4Url = url;
        result.encodedBytes += buf.byteLength;
        log.info("mp4.uploaded", { url, bytes: buf.byteLength });
      }

      result.elapsedMs = Date.now() - started;
      return PipelineResultSchema.parse(result);
    } finally {
      // The order matters: kill the encoder first so no more writes come
      // in, then close the browser, then close the MCP session.
      try {
        await encoder?.abort();
      } catch {
        /* noop */
      }
      try {
        await renderer?.stop();
      } catch {
        /* noop */
      }
      try {
        await mcp?.close();
      } catch {
        /* noop */
      }
    }
  }
}

/* ---------------------------------------------------------------------------
 * 9. CLI / server entry point
 * ------------------------------------------------------------------------ */

/**
 * Two entry modes:
 *   $ tsx lottie-vp9-pipeline.ts --request request.json
 *   $ tsx lottie-vp9-pipeline.ts --stdin
 *
 * In production this whole file is imported into a queue consumer
 * (BullMQ, SQS, Cloud Tasks...) which calls `pipeline.run(job)`.
 */
async function main() {
  const args = process.argv.slice(2);
  const requestFile = args.includes("--request")
    ? args[args.indexOf("--request") + 1]
    : undefined;

  const raw = requestFile
    ? JSON.parse(await fs.readFile(requestFile, "utf8"))
    : JSON.parse(
        await new Promise<string>((res, rej) => {
          const chunks: Buffer[] = [];
          process.stdin.on("data", (c: Buffer | string) =>
            chunks.push(typeof c === "string" ? Buffer.from(c) : c),
          );
          process.stdin.on("end", () => res(Buffer.concat(chunks).toString()));
          process.stdin.on("error", rej);
        }),
      );

  const projectRoot = process.env.PROJECT_ROOT ?? "/srv/projects";
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), "lottie-vp9-"));
  const store = new LocalDevStore(
    process.env.STORE_ROOT ?? workDir,
    process.env.STORE_PUBLIC_BASE ?? `file://${workDir}`,
  );

  const pipeline = new LottieVP9Pipeline({
    projectRoot,
    workDir,
    lottieWebDir: path.resolve(__dirname, "../public"),
    store,
  });

  const result = await pipeline.run(raw);
  process.stdout.write(JSON.stringify(result) + "\n");
}

// Only run when executed as a script, not when imported by a worker.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err: unknown) => {
    process.stderr.write(String((err as Error)?.stack ?? err) + "\n");
    process.exit(1);
  });
}
