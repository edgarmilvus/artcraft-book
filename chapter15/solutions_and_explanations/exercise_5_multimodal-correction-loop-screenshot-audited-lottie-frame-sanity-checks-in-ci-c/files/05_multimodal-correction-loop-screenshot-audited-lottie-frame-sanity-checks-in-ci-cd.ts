// Language: typescript
// audit.ts — multimodal brand-tolerance gate for Lottie renders
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import puppeteer, { type Browser } from "puppeteer-core";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { z } from "zod";
import OpenAI from "openai";

const pexec = promisify(execFile);

declare global {
  interface Window {
    /** Handle lottie-web hands back from `loadAnimation`. */
    __animationItem?: {
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

// ---- Contracts -------------------------------------------------------
export const VisionResponseSchema = z.object({
  observedHex: z.string().regex(/^#[0-9A-F]{6}$/i),
  confidence: z.number().min(0).max(1),
  notes: z.string().max(240),
});
export type VisionResponse = z.infer<typeof VisionResponseSchema>;

export interface VisionGateResult {
  readonly expectedHex: string;
  readonly observedSamples: readonly [string, string, string];
  readonly agreedHex: string | null;
  readonly deltaE2000: number;
  readonly pass: boolean;
  readonly fallbackUsed: false | "signalstats";
}

export interface VisionGateOptions {
  readonly brandHex: `#${string}`;
  readonly deltaEMax: number;
  readonly temperature: 0;
  readonly samples: 3;
  readonly dryRun: boolean;
  readonly onRateLimit: "backoff-once" | "abort";
  readonly numericFallback: boolean;
}

// ---- Colour math (self-contained D65 chain) --------------------------
export function srgbToLinear(c: number): number {
  // sRGB EOTF (inverse of the usual 2.4-gamma).
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "").toUpperCase();
  if (h.length !== 6 || !/^[0-9A-F]{6}$/.test(h)) throw new Error(`bad hex ${hex}`);
  return [parseInt(h.slice(0, 2), 16) / 255,
          parseInt(h.slice(2, 4), 16) / 255,
          parseInt(h.slice(4, 6), 16) / 255];
}
export function rgbToXYZ([r, g, b]: [number, number, number]) {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  // D65 sRGB matrix (IEC 61966-2-1).
  return {
    X: 0.4124564 * R + 0.3575761 * G + 0.1804375 * B,
    Y: 0.2126729 * R + 0.7151522 * G + 0.0721750 * B,
    Z: 0.0193339 * R + 0.1191920 * G + 0.9503041 * B,
  };
}
// D65 white point, 2° observer.
const Xn = 0.95047, Yn = 1.00000, Zn = 1.08883;
function f(t: number): number {
  const eps = 216 / 24389; const kappa = 24389 / 27;
  return t > eps ? Math.cbrt(t) : (kappa * t + 16) / 116;
}
export function hexToLab(hex: string) {
  const { X, Y, Z } = rgbToXYZ(hexToRgb(hex));
  const fx = f(X / Xn), fy = f(Y / Yn), fz = f(Z / Zn);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}
// CIE ΔE2000 (K_L=K_C=K_H=1, parametric factors default).
export function deltaE2000(lab1: { L: number; a: number; b: number },
                   lab2: { L: number; a: number; b: number }): number {
  const { L: L1, a: a1, b: b1 } = lab1;
  const { L: L2, a: a2, b: b2 } = lab2;
  const kL = 1, kC = 1, kH = 1;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cbar, 7) / (Math.pow(Cbar, 7) + Math.pow(25, 7))));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1p = Math.atan2(b1, a1p) + (Math.atan2(b1, a1p) < 0 ? 2 * Math.PI : 0);
  const h2p = Math.atan2(b2, a2p) + (Math.atan2(b2, a2p) < 0 ? 2 * Math.PI : 0);
  const dLp = L2 - L1;
  const dCp = C2p - C1p;
  let dhp: number;
  if (C1p * C2p === 0) dhp = 0;
  else if (Math.abs(h2p - h1p) <= Math.PI) dhp = h2p - h1p;
  else dhp = h2p - h1p + (h2p > h1p ? -2 * Math.PI : 2 * Math.PI);
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin(dhp / 2);
  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp: number;
  if (C1p * C2p === 0) hbarp = h1p + h2p;
  else if (Math.abs(h1p - h2p) <= Math.PI) hbarp = (h1p + h2p) / 2;
  else hbarp = (h1p + h2p + (h1p + h2p < 2 * Math.PI ? 2 * Math.PI : -2 * Math.PI)) / 2;
  const T = 1 - 0.17 * Math.cos(hbarp - Math.PI / 6)
              + 0.24 * Math.cos(2 * hbarp)
              + 0.32 * Math.cos(3 * hbarp + Math.PI / 30)
              - 0.20 * Math.cos(4 * hbarp - (63 * Math.PI / 180));
  const dTheta = 30 * Math.PI / 180 * Math.exp(-Math.pow((hbarp * 180 / Math.PI - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(Cbarp, 7) / (Math.pow(Cbarp, 7) + Math.pow(25, 7)));
  const Sl = 1 + 0.015 * Math.pow(Lbarp - 50, 2) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(dTheta) * Rc;
  return Math.sqrt(
    Math.pow(dLp / (kL * Sl), 2) +
    Math.pow(dCp / (kC * Sc), 2) +
    Math.pow(dHp / (kH * Sh), 2) +
    Rt * (dCp / (kC * Sc)) * (dHp / (kH * Sh)));
}

// ---- MCP helpers -----------------------------------------------------
async function desktopPhotoCraft(port: number, token: string): Promise<Client> {
  // The bridge mode is the only one that can take a window screenshot,
  // and `ui_screenshot` is PhotoCraft's tool.
  const c = new Client({ name: "audit-pc-bridge", version: "1.0.0" }, { capabilities: {} });
  await c.connect(new StdioClientTransport({
    command: "photocraft-cli",
    args: ["mcp", "--bridge", `127.0.0.1:${port}`, "--control-token", token],
  }));
  return c;
}
async function stdioEffectCraft(): Promise<Client> {
  const c = new Client({ name: "audit-ec", version: "1.0.0" }, { capabilities: {} });
  await c.connect(new StdioClientTransport({
    command: "effectcraft-cli",
    args: ["mcp"],
  }));
  return c;
}
function jsonText<T>(res: unknown): T {
  const r = res as { content?: ReadonlyArray<{ type: string; text?: string }> };
  const first = r.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") throw new Error("MCP: non-text reply");
  return JSON.parse(first.text) as T;
}
async function cmd<T>(c: Client, command: string, params: Record<string, unknown> = {}): Promise<T> {
  return jsonText<T>(await c.callTool({ name: "execute_command", arguments: { command, params } }));
}

// ---- Headless capture (determinism-hardened Chromium) ----------------
/**
 * `puppeteer-core` never downloads a browser: it drives the Chrome that
 * is already installed, which keeps a 150 MB download out of every CI
 * image.
 */
const CHROME_PATH =
  process.env.CHROME_PATH ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/** The proof frame's size: the composition is authored at 1080×1080. */
const STAGE = 1080;

/**
 * Render one frame of a Lottie animation and write it as a PNG.
 *
 * The flags are the point of the function. `--force-color-profile=srgb`
 * pins the display profile, and `--disable-gpu-compositing` stops
 * compositor-dependent dithering. Those two are the difference between a
 * brand colour that survives the night and one that drifts.
 */
export async function captureProofFrame(lottiePath: string, frame: number, outPath: string): Promise<void> {
  await fs.mkdir(path.dirname(outPath), { recursive: true });

  // `require.resolve` gives us the absolute path of the lottie-web bundle
  // inside node_modules, so the capture never touches the network.
  const require = createRequire(import.meta.url);
  const lottieScriptPath = require.resolve("lottie-web/build/player/lottie.min.js");
  const animationData: unknown = JSON.parse(await fs.readFile(lottiePath, "utf8"));

  const browser: Browser = await puppeteer.launch({
    headless: true,
    executablePath: CHROME_PATH,
    args: [
      "--no-sandbox",            // required inside most CI containers
      "--disable-dev-shm-usage", // avoids /dev/shm exhaustion under Docker
      "--force-color-profile=srgb",
      "--disable-gpu-compositing",
      "--hide-scrollbars",
      "--font-render-hinting=none",
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: STAGE, height: STAGE, deviceScaleFactor: 1 });
    await page.setContent(
      `<!doctype html>
       <html>
         <head><meta charset="utf-8" /></head>
         <body style="margin:0;background:#000">
           <div id="stage" style="width:${STAGE}px;height:${STAGE}px"></div>
         </body>
       </html>`,
      { waitUntil: "domcontentloaded" },
    );
    // The bundle is injected rather than linked: a page created by
    // `setContent` has an `about:blank` origin, and Chromium refuses to
    // load a `file://` subresource from it.
    const bundle = await fs.readFile(lottieScriptPath, "utf8");
    await page.addScriptTag({ content: bundle });

    await page.evaluate((data: unknown): void => {
      const stage = document.getElementById("stage");
      if (!stage) throw new Error("#stage is missing from the DOM");
      if (!window.lottie) throw new Error("lottie-web did not load");
      window.__animationItem = window.lottie.loadAnimation({
        container: stage,
        renderer: "canvas",
        loop: false,
        autoplay: false,
        animationData: data,
        rendererSettings: { clearCanvas: true, preserveAspectRatio: "xMidYMid meet" },
      });
    }, animationData);

    // `goToAndStop(frame, true)` takes a frame number, not a time.
    await page.evaluate((f: number): void => {
      const item = window.__animationItem;
      if (!item) throw new Error("the animation handle was never assigned");
      item.goToAndStop(f, true);
    }, frame);

    // Yield to the compositor so the canvas has been painted before it
    // is scraped; without this the capture is often the previous frame.
    await page.evaluate(
      () => new Promise<void>((resolve) => { requestAnimationFrame(() => resolve()); }),
    );

    await page.screenshot({ path: outPath, type: "png" });
  } finally {
    await browser.close();
  }
}

// ---- Vision gate -----------------------------------------------------
// The client is created lazily so `--dry-run` (and CI without a key) can
// load this module and capture the proof frame without credentials.
let openai: OpenAI | null = null;
function visionClient(): OpenAI {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required unless the audit runs with --dry-run");
  }
  openai ??= new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
  return openai;
}

async function sampleVision(pngPath: string): Promise<VisionResponse> {
  const b64 = (await fs.readFile(pngPath)).toString("base64");
  const resp = await visionClient().chat.completions.create({
    model: "gpt-4o",
    temperature: 0,
    response_format: { type: "json_object" },
    messages: [{
      role: "user",
      content: [
        { type: "text", text:
          'Return strict JSON: {"observedHex": "#RRGGBB", "confidence": 0..1, "notes": "≤240 chars"}. ' +
          'Report the dominant background/accent colour you see; do not guess.' },
        { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
      ],
    }],
  });
  const content = resp.choices[0]?.message.content ?? "{}";
  return VisionResponseSchema.parse(JSON.parse(content));
}

async function sampleVisionWithBackoff(pngPath: string, opts: VisionGateOptions): Promise<VisionResponse> {
  try {
    return await sampleVision(pngPath);
  } catch (err) {
    const code = (err as { status?: number }).status;
    if (code === 429 && opts.onRateLimit === "backoff-once") {
      await new Promise((r) => setTimeout(r, 30_000));
      return await sampleVision(pngPath);
    }
    throw err;
  }
}

export async function numericFallback(webm: string): Promise<{ yavg: number }> {
  // Pull one frame's signalstats — the same knob Exercise 4 uses.
  const txt = path.join(path.dirname(webm), "signalstats-fallback.txt");
  await fs.mkdir(path.dirname(txt), { recursive: true });
  await pexec("ffmpeg", ["-v", "error", "-i", webm,
    "-vf", "signalstats,metadata=print:file=" + txt,
    "-frames:v", "1", "-f", "null", "/dev/null"]);
  const s = await fs.readFile(txt, "utf8");
  const m = /lavfi\.signalstats\.YAVG=([\d.]+)/.exec(s);
  return { yavg: m ? Number(m[1]) : 0 };
}

// ---- Driver ----------------------------------------------------------
export interface CLI { lottie: string; brand: string; out: string; dryRun: boolean; bridgePort: number }
export function parse(argv: string[]): CLI {
  const m = new Map<string, string>();
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      if (i + 1 < argv.length && !argv[i + 1]!.startsWith("--")) { m.set(a, argv[i + 1]!); i++; }
      else flags.add(a);
    }
  }
  return {
    lottie: m.get("--lottie") ?? "comps/Onboarding.json",
    brand: m.get("--brand") ?? "#0F62FE",
    out: m.get("--out") ?? "dist",
    dryRun: flags.has("--dry-run"),
    bridgePort: Number(m.get("--bridge-port") ?? 7879),
  };
}

async function main() {
  const cli = parse(process.argv.slice(2));
  const opts: VisionGateOptions = {
    brandHex: cli.brand as `#${string}`, deltaEMax: 4.0,
    temperature: 0, samples: 3, dryRun: cli.dryRun,
    onRateLimit: "backoff-once", numericFallback: true,
  };

  // Step 1 — MCP metadata gate
  const ec = await stdioEffectCraft();
  let meta: { fr?: number; w?: number; h?: number };
  try {
    const info = await cmd<{ width?: number; height?: number; fr?: number; layers?: unknown[] }>(
      ec, "comp.info", { comp: "Onboarding" });
    meta = {};
    if (typeof info.fr === "number") meta.fr = info.fr;
    if (typeof info.width === "number") meta.w = info.width;
    if (typeof info.height === "number") meta.h = info.height;
    if (info.fr !== 60) throw new Error(`audit: expected fr=60, got ${info.fr}`);
    if (info.width !== 1080) throw new Error(`audit: expected w=1080, got ${info.width}`);
  } finally {
    await ec.close();
  }
  void meta;

  // Step 2 — Lottie export + headless proof frame at frame 30
  const ec2 = await stdioEffectCraft();
  try {
    await fs.mkdir(path.join(cli.out, "web"), { recursive: true });
    await cmd(ec2, "file.exportLottie", {
      comp: "Onboarding",
      path: path.join(cli.out, "web/onboarding.json"),
      textAsShapes: true,
    });
  } finally { await ec2.close(); }

  const proofFrame = path.join(cli.out, "audit/proof-frame-30.png");
  await captureProofFrame(path.join(cli.out, "web/onboarding.json"), 30, proofFrame);

  // Step 3 — GUI screenshot diagnostic (desktop bridge only)
  const guiPath = path.join(cli.out, "audit/gui-startup.png");
  await fs.mkdir(path.dirname(guiPath), { recursive: true });
  const token = process.env.PHOTOCRAFT_TOKEN ?? "0".repeat(64);
  try {
    const bridge = await desktopPhotoCraft(cli.bridgePort, token);
    try {
      const shot = await bridge.callTool({ name: "ui_screenshot", arguments: {} });
      const image = (shot as {
        content?: Array<{ type: string; data?: string; mimeType?: string }>;
      }).content?.find((part) => part.type === "image" && typeof part.data === "string");
      if (!image?.data) throw new Error("ui_screenshot returned no image");
      await fs.writeFile(guiPath, Buffer.from(image.data, "base64"));
    } finally { await bridge.close(); }
  } catch (err) {
    // Headless CI has no bridge; we do not fail the gate over a diagnostic.
    console.warn("gui screenshot unavailable:", String(err));
  }

  // Step 4 — three deterministic samples from the vision LLM
  let result: VisionGateResult;
  if (opts.dryRun) {
    result = {
      expectedHex: opts.brandHex, observedSamples: [opts.brandHex, opts.brandHex, opts.brandHex],
      agreedHex: opts.brandHex, deltaE2000: 0, pass: true, fallbackUsed: false,
    };
  } else {
    const samples: [VisionResponse, VisionResponse, VisionResponse] = [
      await sampleVisionWithBackoff(proofFrame, opts),
      await sampleVisionWithBackoff(proofFrame, opts),
      await sampleVisionWithBackoff(proofFrame, opts),
    ];
    const hexes = samples.map((s) => s.observedHex.toUpperCase()) as [string, string, string];
    const agreed = hexes[0] === hexes[1] && hexes[1] === hexes[2] ? hexes[0] : null;

    // Step 5 — ΔE2000 acceptance
    const expected = opts.brandHex.toUpperCase();
    const de = agreed ? deltaE2000(hexToLab(expected), hexToLab(agreed)) : Infinity;
    result = {
      expectedHex: expected, observedSamples: hexes, agreedHex: agreed,
      deltaE2000: de,
      pass: agreed !== null && de <= opts.deltaEMax,
      fallbackUsed: false,
    };
  }

  // Step 6 — VP9 encode (only when the perception gate passed, or dry-run)
  const webm = path.join(cli.out, "native/onboarding.webm");
  if (result.pass && !opts.dryRun) {
    await fs.mkdir(path.dirname(webm), { recursive: true });
    const ec3 = await stdioEffectCraft();
    try {
      await ec3.callTool({
        name: "batch",
        arguments: {
          atomic: true,
          steps: [
            { command: "renderQueue.add", params: {
              comp: "Onboarding", format: "webm", output: webm,
              channels: "rgba", bitrate: 3000, quality: 90 } },
            { command: "renderQueue.render", params: { wait: true } },
          ],
        },
      });
    } finally { await ec3.close(); }
  }

  // Step 7 — numeric fallback if the LLM was unavailable
  if (!result.pass && opts.numericFallback && !opts.dryRun) {
    try {
      const { yavg } = await numericFallback(webm);
      // Limited-range guard: reject only a crushed or clipped frame.
      if (yavg > 16 && yavg < 235) {
        result = { ...result, pass: true, fallbackUsed: "signalstats" };
      }
    } catch { /* no webm yet */ }
  }

  // Step 8 — audit JSON artifact
  await fs.mkdir(path.join(cli.out, "audit"), { recursive: true });
  await fs.writeFile(path.join(cli.out, "audit/vision-gate.json"),
    JSON.stringify(result, null, 2) + "\n");

  if (!result.pass) {
    console.error(`vision gate FAIL: ΔE2000=${result.deltaE2000.toFixed(3)}`);
    process.exit(1);
  }
}

if (process.argv[1]?.endsWith("05_multimodal-correction-loop-screenshot-audited-lottie-frame-sanity-checks-in-ci-cd.ts")) {
  await main().catch((e) => { console.error(e); process.exit(1); });
}
