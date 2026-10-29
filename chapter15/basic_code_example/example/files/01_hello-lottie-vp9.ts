/**
 * hello-lottie-vp9.ts
 * ─────────────────────────────────────────────────────────────────────────
 * Chapter 15 · Subsection 2 · "Hello World"
 *
 * Pipeline:
 *   [EffectCraft MCP] ──▶ Lottie JSON ──▶ [Chromium + lottie-web] ──▶ PNGs
 *        ──▶ [ffmpeg · libvpx-vp9] ──▶ out.webm
 *
 * Assumptions:
 *   · Node 20+ with ESM ("type": "module" in package.json).
 *   · effectcraft-cli is on PATH (or set EFFECTCRAFT_BIN).
 *   · ffmpeg with libvpx-vp9 is on PATH.
 *   · Dependencies: @modelcontextprotocol/sdk, puppeteer-core, lottie-web, execa.
 *
 * Type discipline: compiles under `strict`, `noImplicitAny`,
 * `strictNullChecks`. No `any` escapes; no non-null assertions except
 * where the browser context guarantees existence.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import puppeteer, { type Browser } from "puppeteer-core";
import { execa } from "execa";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

/* ─────────────────────────────────────────────────────────────────────────
 * 1 · Configuration
 * ───────────────────────────────────────────────────────────────────────── */

/** Frames per second the whole pipeline agrees on. */
const FPS = 24;

/** Comp duration. Two seconds at 24 fps ⇒ 48 discrete frames. */
const DURATION_SECONDS = 2;

/** The raster canvas we tell Chromium to paint into. */
const WIDTH = 640;
const HEIGHT = 360;

/**
 * The Chrome the rasteriser drives.
 *
 * `puppeteer-core` never downloads a browser, so the path is explicit:
 * `CHROME_PATH` overrides it, and the default is the macOS install.
 */
const CHROME_PATH =
  process.env.CHROME_PATH ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

/* ─────────────────────────────────────────────────────────────────────────
 * 2 · Type augmentation for the browser context
 *
 * Puppeteer serialises the callback we pass to `page.evaluate` and runs it
 * inside Chromium. At that point, the DOM `Window` has been extended by
 * lottie-web (`window.lottie`) and by our own bootstrap code (`window.__anim`).
 * We teach the compiler about those additions so we can stay typed on both
 * sides of the boundary without casting to `any`.
 * ───────────────────────────────────────────────────────────────────────── */

declare global {
  interface Window {
    /** Handle lottie-web hands back from `loadAnimation`. */
    __anim?: {
      goToAndStop: (value: number, isFrame: boolean) => void;
      readonly totalFrames: number;
      destroy: () => void;
    };
    /** The lottie-web global injected by <script src="lottie.min.js">. */
    lottie?: {
      loadAnimation: (opts: {
        container: HTMLElement | null;
        renderer: "canvas" | "svg";
        loop: boolean;
        autoplay: boolean;
        animationData: unknown;
        rendererSettings?: {
          clearCanvas?: boolean;
          preserveAspectRatio?: string;
        };
      }) => NonNullable<Window["__anim"]>;
    };
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 3 · EffectCraft MCP → Lottie JSON
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Drive a headless EffectCraft session over stdio MCP and write a two
 * second composition to `lottiePath` as a Lottie JSON file.
 *
 * Only the official meta-tools are used:
 *
 *   · `open_project`    — bring up a fresh in-memory project.
 *   · `run_script`      — drive the AE-style scripting object model.
 *   · `execute_command` — run `file.exportLottie` and hand it a path.
 */
export async function exportLottie(
  lottiePath: string,
  opts: { transparentBackground?: boolean } = {},
): Promise<void> {
  // A transparent background is what makes the VP9 overlay usable: the
  // encoder can then keep an alpha channel, and the WebM sits on the page's
  // own background instead of on a rectangle of its own.
  const transparent = opts.transparentBackground === true;
  const backgroundLayer = transparent
    ? ""
    : `      var bg = c.layers.addSolid(
        [0.043, 0.070, 0.125], "BG", ${WIDTH}, ${HEIGHT}, 1);`;
  const backgroundColour = transparent ? "[0, 0, 0, 0]" : "[0.043, 0.070, 0.125]";
  const transport = new StdioClientTransport({
    command: process.env.EFFECTCRAFT_BIN ?? "effectcraft-cli",
    args: ["mcp"],
  });

  const client = new Client(
    { name: "hello-lottie-vp9", version: "1.0.0" },
    { capabilities: {} },
  );
  await client.connect(transport);

  try {
    // 3a. Start from an empty project so the run is idempotent.
    await client.callTool({
      name: "open_project",
      arguments: { new: true },
    });

    // 3b. Build the comp entirely in the scripting sandbox. The script is
    //     a plain string — the MCP server evaluates it against the same
    //     object model After Effects exposes (`app.project.items.addComp`,
    //     `Property.setValueAtTime`, and so on).
    const script = `
      var c  = app.project.items.addComp(
        "Hello", ${WIDTH}, ${HEIGHT}, 1, ${DURATION_SECONDS}, ${FPS});
      c.bgColor = ${backgroundColour};
${backgroundLayer}

      var title = c.layers.addText("Hello, Lottie");
      var textProp = title
        .property("ADBE Text Properties")
        .property("ADBE Text Document");
      var doc = textProp.value;
      doc.fontSize   = 96;
      doc.fillColor  = [1.0, 0.82, 0.4];              // #ffd166
      doc.justification = ParagraphJustification.CENTER_JUSTIFY;
      textProp.setValue(doc);

      title.property("ADBE Transform Group")
           .property("ADBE Position")
           .setValue([${WIDTH / 2}, ${HEIGHT / 2}]);

      // Fade the title in over 1.2 s.
      var op = title.property("ADBE Transform Group")
                    .property("ADBE Opacity");
      op.setValueAtTime(0.0,   0);
      op.setValueAtTime(1.2, 100);

      c.numLayers;                                    // returned as result
    `;

    await client.callTool({
      name: "run_script",
      arguments: { name: "hello-build", code: script },
    });

    // 3c. Export the now-active comp. `file.exportLottie` writes JSON
    //     directly to `path`, so no base64 round-trip is needed.
    await client.callTool({
      name: "execute_command",
      arguments: {
        command: "file.exportLottie",
        params: {
          path: lottiePath,
          includeExpressions: true,
          textAsShapes: false,
        },
      },
    });
  } finally {
    // Always close the stdio client: otherwise the child process outlives
    // the function and leaks file descriptors in a long-running service.
    await client.close();
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 4 · Headless Chromium + lottie-web → PNG frames
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Rasterise the Lottie JSON at `lottiePath` into `framesDir` as a
 * zero-padded PNG sequence (`frame-00000.png`, `frame-00001.png`, …).
 *
 * Returns the number of frames actually rendered, which is what
 * `lottie-web` reports for the animation — never the theoretical
 * `FPS × DURATION` — because the JSON's `ip`/`op` range is the
 * authoritative definition of frame count.
 */
export async function renderFrames(
  lottiePath: string,
  framesDir: string,
): Promise<number> {
  // `require.resolve` gives us the absolute path of the lottie-web bundle
  // inside node_modules, avoiding any runtime fetch to a CDN.
  const require = createRequire(import.meta.url);
  const lottieScriptPath = require.resolve(
    "lottie-web/build/player/lottie.min.js",
  );

  const lottieData: unknown = JSON.parse(
    await readFile(lottiePath, "utf8"),
  );

  const browser: Browser = await puppeteer.launch({
    headless: true,
    // `puppeteer-core` does not ship a browser: it drives the Chrome that is
    // already installed on the machine, which keeps a 150 MB download out of
    // every CI image.
    executablePath: CHROME_PATH,
    args: [
      "--no-sandbox",            // required inside most CI containers
      "--disable-dev-shm-usage", // avoids /dev/shm exhaustion under Docker
    ],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
    });

    // A minimal, transparent page. `setContent` skips the network entirely
    // so the whole render happens offline — a prerequisite for deterministic
    // builds and for air-gapped CI.
    await page.setContent(
      `<!doctype html>
       <html>
         <head><meta charset="utf-8" /></head>
         <body style="margin:0;background:transparent">
           <div id="stage" style="width:${WIDTH}px;height:${HEIGHT}px"></div>
         </body>
       </html>`,
      { waitUntil: "domcontentloaded" },
    );

    // Bring lottie-web into the page as a <script> tag. Because we passed
    // an absolute path, Chromium reads it directly from disk.
    await page.addScriptTag({ path: lottieScriptPath });

    // Instantiate the animation. We hand the JSON in as an argument
    // because puppeteer serialises callbacks — closure capture does not
    // survive the Node → Chromium boundary.
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
        rendererSettings: {
          clearCanvas: true,
          preserveAspectRatio: "xMidYMid meet",
        },
      });
    }, lottieData);

    // Ask lottie-web how many frames it actually has. For a 2 s / 24 fps
    // comp this is 48, but the JSON is free to disagree — trust the JSON.
    const totalFrames: number = await page.evaluate((): number => {
      const anim = window.__anim;
      if (!anim) throw new Error("animation handle was never assigned");
      return Math.round(anim.totalFrames);
    });

    // Step through every frame and screenshot the canvas.
    for (let i = 0; i < totalFrames; i++) {
      const framePath = join(
        framesDir,
        `frame-${String(i).padStart(5, "0")}.png`,
      );

      // `goToAndStop(frame, /*isFrame=*/true)` takes a *frame number*, not
      // a time in seconds. Passing `true` is what makes the second argument
      // do the right thing — an easy bug to hit.
      await page.evaluate((frame: number): void => {
        const anim = window.__anim;
        if (!anim) throw new Error("animation handle missing");
        anim.goToAndStop(frame, true);
      }, i);

      // Yield to the compositor so the canvas has actually been painted
      // before we scrape it. Without this, `page.screenshot` frequently
      // captures the *previous* frame.
      await page.evaluate(
        () =>
          new Promise<void>((resolve) => {
            requestAnimationFrame(() => resolve());
          }),
      );

      await page.screenshot({
        path: framePath,
        type: "png",
        // Preserve alpha if the Lottie JSON has any. Harmless if not.
        omitBackground: true,
      });
    }

    return totalFrames;
  } finally {
    await browser.close();
  }
}

/* ─────────────────────────────────────────────────────────────────────────
 * 5 · ffmpeg · libvpx-vp9
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Encode a PNG sequence as a VP9 WebM. `yuva420p` requests an alpha channel;
 * VP9 is one of the few codecs ffmpeg writes into WebM with working alpha,
 * which is what makes it a first-class target for Lottie overlays that sit
 * on top of a page background.
 */
export async function encodeVP9(
  framePattern: string,
  frameCount: number,
  outputPath: string,
): Promise<void> {
  await execa("ffmpeg", [
    "-y",                          // overwrite without asking
    "-framerate", String(FPS),
    "-start_number", "0",          // match our zero-based PNG names
    "-i", framePattern,            // frame-%05d.png
    "-frames:v", String(frameCount),
    "-c:v", "libvpx-vp9",
    "-pix_fmt", "yuva420p",        // keep alpha end-to-end
    "-auto-alt-ref", "0",          // disables alt-ref frames; required
                                   // when encoding alpha in VP9
    "-b:v", "0",                   // pure CRF mode (no target bitrate)
    "-crf", "28",                  // quality factor (lower = better)
    "-row-mt", "1",                // multi-thread the encoder by row
    "-cpu-used", "4",              // 0 = slowest/best, 5 = fastest
    outputPath,
  ]);
}

/* ─────────────────────────────────────────────────────────────────────────
 * 6 · Orchestration
 * ───────────────────────────────────────────────────────────────────────── */

/**
 * Wire the three stages together inside a single scratch directory.
 * The whole pipeline runs under `mkdtemp` so it is safely parallelisable:
 * two concurrent jobs will never collide on the same frame files.
 */
export async function main(): Promise<void> {
  const workDir = await mkdtemp(join(tmpdir(), "hello-lottie-"));
  const framesDir = join(workDir, "frames");
  const lottiePath = join(workDir, "hello.lottie.json");
  const outputWebm = join(workDir, "hello.webm");

  try {
    await mkdir(framesDir, { recursive: true });

    console.log("[1/3] Exporting Lottie from EffectCraft …");
    await exportLottie(lottiePath);

    console.log("[2/3] Rasterising frames in headless Chromium …");
    const frameCount = await renderFrames(lottiePath, framesDir);

    console.log("[3/3] Encoding VP9 …");
    await encodeVP9(
      join(framesDir, "frame-%05d.png"),
      frameCount,
      outputWebm,
    );

    console.log(
      `✓ Wrote ${outputWebm} (${frameCount} frames @ ${FPS} fps, ` +
        `${frameCount / FPS} s)`,
    );
  } finally {
    // KEEP_WORKDIR=1 keeps the scratch directory around for inspection —
    // invaluable when the frames look wrong and you need to stare at them.
    if (process.env.KEEP_WORKDIR !== "1") {
      await rm(workDir, { recursive: true, force: true });
    }
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  void main().catch((err: unknown) => {
    // `process.exitCode` (rather than `process.exit`) lets pending I/O flush
    // — important when a child process is mid-write and we bail out.
    console.error("Pipeline failed:", err);
    process.exitCode = 1;
  });
}
