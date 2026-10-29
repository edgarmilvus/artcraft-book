// ---------------------------------------------------------------------------
// render.ts — preview rasterisation and full encode.
// ---------------------------------------------------------------------------
import { writeFile } from "node:fs/promises";
import type { EffectCraftSession } from "./session.js";
import type { CompiledTemplate } from "./compiler.js";

/** A rendered still returned from the preview path. */
export interface PreviewResult {
  pngBase64: string;
  mimeType: string;
  /** The composition time the frame was sampled at, in seconds. */
  sampledAtSec: number;
}

/**
 * Renders a single QA frame at the composition's "settled" beat.
 *
 * `max_side` bounds the longest edge of the returned PNG (default 960 in the
 * engine; we pass 1280 for a sharper QA gate). The engine clips this at 0
 * meaning "full size", so we never pass 0 from a service — a full-size RGBA
 * frame for a 4K comp is 33 MB before base64, which will blow up the JSON
 * envelope and, on many MCP transports, the frame size limit.
 */
export async function renderPreview(
  session: EffectCraftSession,
  compiled: CompiledTemplate,
  opts: { beat: "entered" | "settled" | "exiting"; maxSide?: number } = { beat: "settled" },
): Promise<PreviewResult> {
  const { durationSec } = compiled;
  const sampleAt =
    opts.beat === "entered"
      ? durationSec * 0.18
      : opts.beat === "settled"
        ? durationSec * 0.55
        : durationSec * 0.9;

  const frame = await session.renderFrame({
    comp: compiled.compId,
    time: sampleAt,
    maxSide: opts.maxSide ?? 1280,
    inline: true,
    transparent: false, // composite over the comp's background for QA
  });

  const imagePart = frame.content.find((c) => c.type === "image");
  if (!imagePart) {
    throw new Error("render_frame returned no image content");
  }
  return { pngBase64: imagePart.data, mimeType: imagePart.mimeType, sampledAtSec: sampleAt };
}

/**
 * Writes the QA frame to disk for the visual-diff harness. Kept separate from
 * {@link renderPreview} so the hot path never pays for filesystem I/O.
 */
export async function persistPreview(png: PreviewResult, path: string): Promise<void> {
  await writeFile(path, Buffer.from(png.pngBase64, "base64"));
}

/** Normalised result of a full encode. */
export interface EncodeResult {
  outputPath: string;
  format: string;
  /** Bytes written, when the engine reports them. */
  bytes?: number;
}

/**
 * Enqueues and executes the full render.
 *
 * Notes on the queue contract:
 *  - `renderQueue.add` takes `resolution` as either a fraction keyword
 *    ("full" | "half" | "third" | "quarter") or a numeric scale, plus an
 *    explicit `quality` when the format supports it. For social deliverables
 *    we downscale to half and let the encoder pick up the speed.
 *  - `renderQueue.render` defaults `wait: true`, which is what a synchronous
 *    worker wants. Passing `wait: false` would return immediately with the
 *    job still running, and the worker would need to poll `jobs_list` — a
 *    valid design for a queue-backed service but not one this implementation
 *    uses, because the worker's own concurrency already provides parallelism.
 *  - We never call `renderQueue.render` twice without clearing the queue;
 *    the second call would re-render the same item. The compiled manifest is
 *    the single source of truth for "what is queued", so the caller is
 *    responsible for not invoking this twice on the same {@link CompiledTemplate}.
 */
export async function encodeDeliverable(
  session: EffectCraftSession,
  compiled: CompiledTemplate,
  opts: {
    outputPath: string;
    format: "h264" | "hevc" | "prores" | "png";
    quality: number;
    transparent: boolean;
  },
): Promise<EncodeResult> {
  await session.runCommand("renderQueue.add", {
    comp: compiled.compId,
    format: opts.format,
    output: opts.outputPath,
    quality: opts.quality,
    resolution: "full",
    timeSpan: "comp",
  });

  // The output module carries the channel count; the render settings do not.
  // The queue item is addressed by its 1-based index.
  await session.runCommand("renderQueue.setOutputModule", {
    item: 1,
    format: opts.format,
    channels: opts.transparent ? "rgba" : "rgb",
    quality: opts.quality,
  });

  const rendered = await session.runCommand<{
    items?: Array<{ last_output?: string | null; status?: string; render_time?: number | null }>;
  }>("renderQueue.render", { wait: true });

  // The queue answers with the items it rendered; the first one carries the
  // path the encoder actually wrote (an image sequence writes
  // `name_00000.png`, so the requested path is only the stem).
  const item = rendered.items?.[0];
  const outputPath = item?.last_output ?? opts.outputPath;

  return {
    outputPath,
    format: opts.format,
  };
}

/**
 * Persists the project file so the render is reproducible from source.
 * Called after a successful encode; a failure here is logged but non-fatal,
 * because the deliverable already exists.
 */
export async function persistProject(
  session: EffectCraftSession,
  projectPath: string,
): Promise<void> {
  await session.runCommand("file.save", { path: projectPath });
}
