// ---------------------------------------------------------------------------
// service.ts — the SaaS-facing entry point.
// ---------------------------------------------------------------------------
import { createHash } from "node:crypto";
import { EffectCraftSession } from "./session.js";
import { compileTemplate, type CompiledTemplate } from "./compiler.js";
import { encodeDeliverable, persistPreview, persistProject, renderPreview } from "./render.js";
import { TemplateRequest } from "./contracts.js";

/** What a worker returns to the HTTP layer. */
export interface RenderJobResult {
  requestId: string;
  cacheKey: string;
  compId: number | string;
  seed: number;
  durationSec: number;
  previewPngBase64: string;
  outputPath: string;
  format: string;
  bytes?: number | undefined;
}

/**
 * Content-addressed key for a compiled template.
 *
 * The key includes the template id and a compiler version so that shipping a
 * new compiler invalidates every cached artefact automatically — the failure
 * mode where a template change silently serves stale renders is otherwise
 * extremely hard to diagnose.
 */
export function cacheKeyFor(req: TemplateRequest): string {
  const h = createHash("sha256");
  h.update(req.templateId);
  h.update("\u0000");
  h.update(JSON.stringify(req.tokens));
  h.update("\u0000");
  h.update(JSON.stringify(req.content));
  h.update("\u0000");
  h.update(String(req.width));
  h.update("x");
  h.update(String(req.height));
  h.update("@");
  h.update(String(req.frameRate));
  h.update("\u0000");
  h.update("compiler=3.1.0");
  return h.digest("hex");
}

/**
 * Full pipeline for one render request.
 *
 * This function owns the session's lifecycle for the duration of the job:
 * it connects, compiles, renders, persists, and disconnects. In a long-lived
 * worker you would hoist the connect/close outside the loop and reuse the
 * session across requests; the shape below is the honest "one job, one
 * session" version, which is what you want in a serverless or containerised
 * deployment where a worker handles a bounded number of jobs before exiting.
 */
export async function runRenderJob(
  req: TemplateRequest,
  opts: {
    binaryPath: string;
    outputDir: string;
    projectDir: string;
  },
): Promise<RenderJobResult> {
  const parsed = TemplateRequest.parse(req);
  const cacheKey = cacheKeyFor(parsed);

  // EffectCraft's headless server takes no sandbox roots: the worker owns
  // the filesystem boundary itself, and every path it hands to the engine
  // is resolved against the output directory it was given.
  const session = new EffectCraftSession({
    binaryPath: opts.binaryPath,
    callTimeoutMs: 180_000,
  });

  await session.connect();

  try {
    const compiled: CompiledTemplate = await compileTemplate(session, {
      ...parsed,
      requestId: parsed.requestId,
    });

    const preview = await renderPreview(session, compiled, { beat: "settled" });

    const previewPath = `${opts.outputDir}/${cacheKey}.preview.png`;
    await persistPreview(preview, previewPath);

    const outputPath = `${opts.outputDir}/${cacheKey}.${parsed.deliverable.format === "png" ? "png" : "mp4"}`;
    const encoded = await encodeDeliverable(session, compiled, {
      outputPath,
      format: parsed.deliverable.format,
      quality: parsed.deliverable.quality,
      transparent: parsed.deliverable.transparent,
    });

    await persistProject(session, `${opts.projectDir}/${cacheKey}.ecproj`);

    return {
      requestId: parsed.requestId,
      cacheKey,
      compId: compiled.compId,
      seed: compiled.seed,
      durationSec: compiled.durationSec,
      previewPngBase64: preview.pngBase64,
      outputPath: encoded.outputPath,
      format: encoded.format,
      bytes: encoded.bytes,
    };
  } finally {
    // Always close, even on failure. An orphaned `effectcraft-cli` child
    // process holds a GPU context and a disk cache handle; leaking one per
    // failed job is how a worker pool starves itself.
    await session.close();
  }
}
