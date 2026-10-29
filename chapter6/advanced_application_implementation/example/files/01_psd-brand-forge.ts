/**
 * =============================================================================
 *  psd-brand-forge.ts
 * =============================================================================
 *
 *  Production-grade automation worker for "Storytold · Brand Forge", a SaaS
 *  microservice that turns structured JSON job payloads into deterministic,
 *  layer-preserved PSD brand kits.
 *
 *  ── Why this file exists ─────────────────────────────────────────────────────
 *  Design teams need *live* PSDs: real layers, real clipping masks, real
 *  adjustment layers — not flattened PNGs.  PhotoCraft is the only runtime in
 *  the Storytold suite that emits layered raster output, so we drive it end
 *  to end through the official MCP server.  The web tier treats the entire
 *  rendering pipeline as a single remote call, and the worker is the
 *  contract boundary where the design system, the file format, and the
 *  language-model QA loop all meet.
 *
 *  ── The three coupled primitives this file demonstrates ────────────────────
 *   1) Layer orchestration  — deterministic create / position / rename.
 *   2) Clipping masks       — nested, non-destructive compositing relationships.
 *   3) OkLCh tone curves    — perceptually-uniform grading expressed as
 *                             PhotoCraft Lab-aligned curve point arrays.
 *
 *  ── Design constraints honoured by this module ─────────────────────────────
 *   •  Single Responsibility per function; no function does two jobs.
 *   •  Zero hidden state.  Every side-effect is either an MCP call or a
 *      filesystem write, both of which are visible in the function signature.
 *   •  Zod-validated I/O at every boundary so a misbehaving web tier can never
 *      corrupt a running job.
 *   •  Deterministic layer tree: the same job id produces the same document.
 *   •  Bounded retries only for genuinely transient failures.
 *
 *  ── Assumptions encoded as prerequisites ───────────────────────────────────
 *   •  `photocraft-cli` is on PATH inside the sandbox container.
 *   •  The worker has exclusive access to a scratch directory granted to the
 *      MCP child as both its automation read root and its automation write root.
 *   •  Node 18+ (for global `fetch`) and no external deps beyond the MCP SDK
 *      and Zod.
 *
 *  ── Layout of this file ────────────────────────────────────────────────────
 *   §A  Job schema (Zod)                        — the vertical contract
 *   §B  Color science primitives                — OkLCh → CIELab remap
 *   §C  MCP client wrapper                      — typed façade over the SDK
 *   §D  Document operations                     — layer ids, error text
 *   §E  Layer tree planner                      — deterministic names
 *   §F  Orchestrator                            — end-to-end job runner
 *   §G  Vision-QA hook                          — optional multimodal audit
 *   §H  Retry helper                            — transient-only backoff
 *   §I  Job runner                              — validate → connect → run
 *   §J  JSON-line protocol                      — stdin/stdout entry point
 * =============================================================================
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import readline from "node:readline";

/* ========================================================================== */
/* §A.  Job schema                                                            */
/* ========================================================================== */

/**
 * A single stop on the OkLCh lightness transfer function the caller wants
 * applied to the composite.  Both endpoints are expressed as *neutral lightness*
 * in the Oklab family (0 = black, 1 = white).  The runtime internally remaps
 * these stops into the L* codomain so that they survive a round-trip through
 * PhotoCraft's Lab-aligned curve editor.
 */
export const OkLChToneStopSchema = z.object({
  /** Input OkLCh lightness, 0..1. */
  inputL: z.number().min(0).max(1),
  /** Target OkLCh lightness, 0..1. */
  outputL: z.number().min(0).max(1),
  /**
   * Optional chroma multiplier at this stop.  Values > 1 push saturation,
   * values < 1 pull it back.  1 (the default) leaves chroma untouched.
   */
  chromaMultiplier: z.number().min(0).max(2).default(1),
});
export type OkLChToneStop = z.infer<typeof OkLChToneStopSchema>;

/**
 * The full payload the web tier pushes onto the queue.  Every field is
 * strictly typed; the runtime refuses to run a job that fails this schema
 * so that a malformed payload can never corrupt a downstream PSD.
 */
export const PsdBrandForgeJobSchema = z.object({
  /** Stable, idempotency-key-grade identifier. */
  jobId: z.string().uuid(),
  /** Multi-tenant discriminator (used for metrics and log routing). */
  tenantId: z.string().min(1).max(64),
  /** Target canvas geometry in points. */
  canvas: z.object({
    width: z.number().int().min(64).max(16384),
    height: z.number().int().min(64).max(16384),
  }),
  /** Four-role palette: backdrop, frame matte, card base, accent sweep. */
  palette: z.object({
    backdrop: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    matte:    z.string().regex(/^#[0-9a-fA-F]{6}$/),
    base:     z.string().regex(/^#[0-9a-fA-F]{6}$/),
    accent:   z.string().regex(/^#[0-9a-fA-F]{6}$/),
  }),
  /** Single headline text block, placed as point type. */
  headline: z.object({
    text:       z.string().min(1).max(120),
    fontFamily: z.string().min(1).max(64),
    sizePt:     z.number().min(8).max(500),
    color:      z.string().regex(/^#[0-9a-fA-F]{6}$/),
    xPt:        z.number(),
    yPt:        z.number(),
  }),
  /** The perceptual tone curve expressed in OkLCh. */
  oklchCurve: z.object({
    stops: z.array(OkLChToneStopSchema).min(2).max(19),
  }),
  /** Where the worker drops its artifacts. */
  paths: z.object({
    psd:     z.string().min(1),
    preview: z.string().optional(),
  }),
});
export type PsdBrandForgeJob = z.infer<typeof PsdBrandForgeJobSchema>;

/* ========================================================================== */
/* §B.  Color science primitives                                              */
/* ========================================================================== */

/**
 * Numeric clamp helper.  Used liberally because PhotoCraft's curve editors
 * reject out-of-range points with a hard validation error.
 */
function clamp(x: number, lo: number, hi: number): number {
  if (x < lo) return lo;
  if (x > hi) return hi;
  return x;
}

/**
 * Convert a *neutral* OkLCh lightness value into the corresponding CIELab L*
 * value.  This mapping is exact for neutral grays because both color spaces
 * reduce to the same power-law function on the achromatic axis:
 *
 *     In Oklab:  L = cbrt(Y_linear / Y_white)
 *     In CIELab: L* = 116 * cbrt(Y_linear / Y_white) - 16
 *
 * Therefore:
 *
 *     L* = 116 * L_oklch - 16
 *
 * The caller usually feeds `L_oklch` values in [0, 1] and this function
 * returns a value in [0, 100].  Values below 0 (which occur for very dark
 * inputs) are clamped because L* is undefined below 0 in the standard.
 */
export function oklchLToCielabLStar(oklchL: number): number {
  const lStar = 116 * clamp(oklchL, 0, 1) - 16;
  return clamp(lStar, 0, 100);
}

/**
 * Convert a CIELab L* value into the 0..255 integer coder used by PhotoCraft's
 * Curves adjustment layer.  The coder is a simple linear remap: 0 → black,
 * 100 → white, and everything in between.
 */
export function cielabLStarToCurveCoder(lStar: number): number {
  return clamp(lStar, 0, 100) * 2.55;
}

/**
 * The high-level pipeline: turn an array of OkLCh tone stops into a
 * PhotoCraft-ready curve point array.  Each stop becomes one `[in, out]`
 * pair in the 0..255 coder; the array is sorted by input and truncated to
 * nineteen points, which is the maximum the Curves engine accepts.
 *
 * Duplicates at the same code point are collapsed last-writer-wins — the
 * caller's most recent intent wins, which matches the mental model of
 * "later adjustments override earlier ones".
 */
export function oklchToneCurveToLightnessPoints(
  stops: ReadonlyArray<OkLChToneStop>,
): Array<[number, number]> {
  const byCodePoint = new Map<number, [number, number]>();
  for (const stop of stops) {
    const inCoder  = cielabLStarToCurveCoder(oklchLToCielabLStar(stop.inputL));
    const outCoder = cielabLStarToCurveCoder(oklchLToCielabLStar(stop.outputL));
    const key = Math.round(inCoder);
    byCodePoint.set(key, [inCoder, outCoder]);
  }
  const points = [...byCodePoint.values()].sort((a, b) => a[0] - b[0]);
  // The engine accepts no more than nineteen anchors.  Trimming from the tail
  // keeps the silhouette's dark-end behaviour intact when the caller over-specs.
  return points.slice(0, 19);
}

/**
 * Reduce a list of tone stops to a single (vibrance, saturation) pair by
 * averaging the chroma multipliers.  This is intentionally simple: the
 * chapter's focus is a single perceptual tone curve, and a separate Vibrance
 * layer is enough to give the caller a *live* second handle without
 * exploding the parameter space of this worker.
 */
export function averageChromaTrim(
  stops: ReadonlyArray<OkLChToneStop>,
): { vibrance: number; saturation: number } {
  if (stops.length === 0) return { vibrance: 0, saturation: 0 };
  const mean = stops.reduce((acc, s) => acc + s.chromaMultiplier, 0) / stops.length;
  // Map 1.0 (identity) to 0, 2.0 to +100, 0.0 to -100 — a symmetric
  // linear scale that stays inside PhotoCraft's accepted -100..100 range.
  const scaled = clamp((mean - 1) * 100, -100, 100);
  return { vibrance: Math.round(scaled * 0.6), saturation: Math.round(scaled * 0.4) };
}

/* ========================================================================== */
/* §C.  MCP client wrapper                                                    */
/* ========================================================================== */

/** Error type used for anything PhotoCraft reports as a tool failure. */
export class PhotoCraftToolError extends Error {
  public readonly toolContext: string;
  constructor(context: string, message: string) {
    super(`[${context}] ${message}`);
    this.name = "PhotoCraftToolError";
    this.toolContext = context;
  }
}

/** Constructor options for the client; all fields have sensible defaults. */
export interface PsdBrandForgeClientOptions {
  /** Absolute path to the binary.  Defaults to relying on PATH. */
  binaryPath?: string;
  /** Scratch directory handed to the MCP child as its read root. */
  readRoot: string;
  /** Scratch directory handed to the MCP child as its write root. */
  writeRoot: string;
}

/**
 * What `Client.callTool` resolves to. It is a union: a task-based server
 * answers with `toolResult` and no `content`, so every reader narrows first.
 */
type ToolReply = Awaited<ReturnType<Client["callTool"]>>;

/** The subset of a content block this module reads. */
interface ContentBlock {
  type?: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/** Shape of the batch meta-tool reply. */
export interface BatchReport {
  completed: number;
  failed: number;
  results: Array<{ ok: boolean; result?: unknown; error?: string }>;
}

/**
 * A thin, typed façade around the MCP SDK.  Its sole job is to hide the
 * plumbing (content-block unwrapping, JSON parsing, error normalisation)
 * so that the orchestrator above can read like pseudocode.
 */
export class PsdBrandForgeClient {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private readonly options: Required<PsdBrandForgeClientOptions>;

  constructor(options: PsdBrandForgeClientOptions) {
    this.options = {
      binaryPath: options.binaryPath ?? "photocraft-cli",
      readRoot:   options.readRoot,
      writeRoot:  options.writeRoot,
    };
    this.transport = new StdioClientTransport({
      command: this.options.binaryPath,
      args: [
        "mcp",
        "--automation-read-root",  this.options.readRoot,
        "--automation-write-root", this.options.writeRoot,
      ],
    });
    this.client = new Client(
      { name: "storytold-brand-forge", version: "1.4.0" },
      { capabilities: {} },
    );
  }

  /** Open the JSON-RPC channel; must be awaited before any other call. */
  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  /**
   * Resolve an artifact path exactly as the engine resolves it: relative
   * paths are taken under the write root, not under the process's cwd.
   */
  resolveWritePath(path: string): string {
    return isAbsolute(path) ? path : join(this.options.writeRoot, path);
  }

  /** Close the channel.  Safe to call more than once. */
  async close(): Promise<void> {
    try { await this.client.close(); } catch { /* already closed */ }
  }

  /** Coerce any content blocks into a single trimmed text payload. */
  private flattenText(result: ToolReply): string {
    const blocks = ("content" in result ? result.content : []) as ContentBlock[];
    return blocks
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
  }

  /** Parse a JSON tool reply; a refusal becomes a `PhotoCraftToolError`. */
  private unwrapJson<T>(result: ToolReply, ctx: string): T {
    if ("isError" in result && result.isError) {
      throw new PhotoCraftToolError(ctx, this.flattenText(result) || "unspecified failure");
    }
    const text = this.flattenText(result);
    if (!text) throw new PhotoCraftToolError(ctx, "empty reply where JSON was expected");
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new PhotoCraftToolError(ctx, `non-JSON reply: ${text.slice(0, 400)}`);
    }
  }

  /** Decode the first image block; throws if none is present. */
  private unwrapImage(result: ToolReply, ctx: string): Buffer {
    if ("isError" in result && result.isError) {
      throw new PhotoCraftToolError(ctx, this.flattenText(result) || "unspecified failure");
    }
    const blocks = ("content" in result ? result.content : []) as ContentBlock[];
    const img = blocks.find(
      (b): b is { type: "image"; data: string; mimeType: string } => b.type === "image",
    );
    if (!img) throw new PhotoCraftToolError(ctx, "reply contained no image block");
    return Buffer.from(img.data, "base64");
  }

  /** Run one engine command; `wait` defaults to synchronous completion. */
  async runCommand<T = unknown>(
    id: string,
    params: Record<string, unknown> = {},
    wait = true,
  ): Promise<T> {
    const result = await this.client.callTool({
      name: "command_run",
      arguments: { id, params, wait },
    });
    return this.unwrapJson<T>(result, `command_run ${id}`);
  }

  /** Execute several commands in sequence within one transport turn. */
  async batch(
    steps: Array<{ id: string; params?: Record<string, unknown> }>,
    stopOnError = true,
  ): Promise<BatchReport> {
    const result = await this.client.callTool({
      name: "command_batch",
      arguments: { steps, stop_on_error: stopOnError },
    });
    return this.unwrapJson<BatchReport>(result, "command_batch");
  }

  /** Create a fresh document, returning the server-assigned index. */
  async docNew(params: {
    width: number;
    height: number;
    mode?: "rgb" | "gray" | "cmyk" | "lab";
    depth?: 8 | 16 | 32;
    background?: "white" | "black" | "transparent" | string;
    name?: string;
  }): Promise<{ document: number }> {
    const result = await this.client.callTool({
      name: "doc_new",
      arguments: params,
    });
    return this.unwrapJson(result, "doc_new");
  }

  /** Save the active document; extension selects the writer. */
  async docSave(path: string): Promise<{ path: string; warnings: string[] }> {
    const result = await this.client.callTool({
      name: "doc_save",
      arguments: { path },
    });
    return this.unwrapJson(result, "doc_save");
  }

  /** Snapshot the layer tree, history, selection and active layer. */
  async docInspect(): Promise<Record<string, unknown>> {
    const result = await this.client.callTool({ name: "doc_inspect", arguments: {} });
    return this.unwrapJson(result, "doc_inspect");
  }

  /** Render a flattened preview as PNG bytes. */
  async renderPreview(maxSide = 1024): Promise<Buffer> {
    const result = await this.client.callTool({
      name: "doc_render_preview",
      arguments: { max_side: maxSide },
    });
    return this.unwrapImage(result, "doc_render_preview");
  }
}

/* ========================================================================== */
/* §D.  Document operations                                                   */
/* ========================================================================== */

/**
 * Extract an integer id from a creation command's reply.  PhotoCraft's
 * creation commands are consistent in that they return either `{id}` or
 * `{layer}`; we accept both and refuse anything else so that a schema drift
 * in the tool becomes a loud, actionable failure.
 */
export function extractNumericId(result: unknown): number | null {
  if (!result || typeof result !== "object") return null;
  const r = result as Record<string, unknown>;
  if (typeof r.id === "number" && Number.isInteger(r.id)) return r.id;
  if (typeof r.layer === "number" && Number.isInteger(r.layer)) return r.layer;
  return null;
}

/**
 * Convenience wrapper that runs a creation command and asserts that a
 * numeric layer id came back.  Every layer the orchestrator creates goes
 * through here, so a regression in the tool replies surfaces immediately.
 */
async function createTrackedLayer(
  client: PsdBrandForgeClient,
  command: string,
  params: Record<string, unknown>,
): Promise<number> {
  const reply = await client.runCommand<Record<string, unknown>>(command, params);
  const id = extractNumericId(reply);
  if (id === null) {
    throw new PhotoCraftToolError(
      command,
      `expected numeric layer id, got ${JSON.stringify(reply).slice(0, 300)}`,
    );
  }
  return id;
}

/**
 * Throw the first failing step of a batch report, naming the command. A batch
 * that stops on error still leaves its successful prefix applied, so the
 * exception has to carry which command broke the chain.
 */
function assertBatchComplete(
  label: string,
  steps: ReadonlyArray<{ id: string }>,
  report: BatchReport,
): void {
  if (report.failed === 0) return;
  const index = report.results.findIndex((r) => !r.ok);
  throw new PhotoCraftToolError(
    steps[index]?.id ?? label,
    report.results[index]?.error ?? `${report.failed} step(s) failed`,
  );
}

/** Format an error into a caller-friendly one-line string. */
export function describeError(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  if (typeof err === "string") return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/* ========================================================================== */
/* §E.  Layer tree planner                                                    */
/* ========================================================================== */

/**
 * The set of layer names we expect to see in the finished document.  Every
 * name is prefixed with the job tag so that concurrent jobs in the same
 * warm PhotoCraft instance cannot collide.
 */
interface PlannedNames {
  backdrop: string;
  matte: string;
  card: string;
  vignette: string;
  chroma: string;
  curve: string;
  headline: string;
}

/** Build the fully-tagged layer name set for one job. */
function plannedNames(job: PsdBrandForgeJob): PlannedNames {
  const tag = job.jobId.slice(0, 8);
  return {
    backdrop: `${tag} · Backdrop`,
    matte:    `${tag} · Frame Matte`,
    card:     `${tag} · Card Base`,
    vignette: `${tag} · Vignette`,
    chroma:   `${tag} · Chroma Trim`,
    curve:    `${tag} · OkLCh Tone`,
    headline: `${tag} · Headline`,
  };
}

/* ========================================================================== */
/* §F.  Orchestrator                                                          */
/* ========================================================================== */

/** Final report returned to the web tier for audit and billing. */
export interface GenerationReport {
  jobId: string;
  tenantId: string;
  psdPath: string;
  previewPath?: string;
  layerIds: Record<keyof PlannedNames, number>;
  warnings: string[];
  durationMs: number;
  visionVerdict: VisionVerdict | null;
}

/**
 * The heart of the worker: runs a fully validated job against PhotoCraft and
 * produces the layered PSD plus an optional preview PNG and a vision audit.
 *
 * The function is deliberately linear — each numbered step is one paragraph
 * in the workflow the chapter teaches.  There are no hidden state machines
 * and no deferred writes: if the job fails at step 6, the caller receives a
 * `PhotoCraftToolError` naming the command that failed and no partial PSD is
 * emitted to disk because the `doc_save` step is last.
 */
export async function orchestratePsdBrandKit(
  client: PsdBrandForgeClient,
  job: PsdBrandForgeJob,
): Promise<GenerationReport> {
  const startedAt = Date.now();
  const names = plannedNames(job);
  const warnings: string[] = [];

  /* --------------------------------------------------------------------- */
  /* 1. Fresh, transparent 16-bit RGB document                              */
  /* --------------------------------------------------------------------- */
  await client.docNew({
    width:  job.canvas.width,
    height: job.canvas.height,
    mode:   "rgb",
    depth:  16,          // Deep enough for curve work without visible banding.
    background: "transparent",
    name:   `BrandForge-${job.jobId.slice(0, 8)}`,
  });

  /* --------------------------------------------------------------------- */
  /* 2. Backdrop solid fill — the bottom of the compositional stack         */
  /* --------------------------------------------------------------------- */
  const backdropId = await createTrackedLayer(
    client,
    "layer.newFillLayer.solidColor",
    { color: job.palette.backdrop },
  );

  /* --------------------------------------------------------------------- */
  /* 3. Frame matte — an inset solid fill whose clip coverage drives the    */
  /*    whole nested mask chain.  We build the mask with a rectangular       */
  /*    selection so that the effect is visually meaningful (a card frame    */
  /*    inset by 8% of the shorter canvas edge).                            */
  /* --------------------------------------------------------------------- */
  const inset = Math.max(8, Math.round(Math.min(job.canvas.width, job.canvas.height) * 0.08));
  await client.runCommand("select.rect", {
    x: inset,
    y: inset,
    width:  job.canvas.width  - inset * 2,
    height: job.canvas.height - inset * 2,
    mode: "replace",
    antiAlias: true,
  });
  const matteId = await createTrackedLayer(
    client,
    "layer.newFillLayer.solidColor",
    { color: job.palette.matte },
  );
  // Clear the selection so subsequent creates cover the entire canvas.
  await client.runCommand("select.deselect", {});

  /* --------------------------------------------------------------------- */
  /* 4. Card base — a solid fill that will be clipped *to* the frame matte. */
  /* --------------------------------------------------------------------- */
  const cardId = await createTrackedLayer(
    client,
    "layer.newFillLayer.solidColor",
    { color: job.palette.base },
  );

  /* --------------------------------------------------------------------- */
  /* 5. Vignette — a radial gradient fill that will clip to the card base.  */
  /*    We create it black-to-black and then inject a transparency ramp so   */
  /*    the corner falloff is controlled independently of the colour stops.  */
  /* --------------------------------------------------------------------- */
  const vignetteId = await createTrackedLayer(
    client,
    "layer.newFillLayer.gradient",
    { from: "#000000", to: "#000000", style: "radial", angle: 0 },
  );
  await client.runCommand("gradient.fill.set", {
    layer: vignetteId,
    style: "radial",
    stops: [[0, "#000000"], [1, "#000000"]],
    transparency: [[0, 0], [0.65, 0], [1, 85]],
    reverse: false,
    dither: true,
    align: false,
  });

  /* --------------------------------------------------------------------- */
  /* 6. Chroma trim — a Vibrance adjustment layer that carries the scalar    */
  /*    chroma intent derived from the OkLCh stops.  It clips to the card    */
  /*    base so that it never bleeds onto the backdrop.                      */
  /* --------------------------------------------------------------------- */
  const chromaId = await createTrackedLayer(
    client,
    "layer.newAdjustmentLayer.vibrance",
    (() => {
      const { vibrance, saturation } = averageChromaTrim(job.oklchCurve.stops);
      return { vibrance, saturation };
    })(),
  );

  /* --------------------------------------------------------------------- */
  /* 7. OkLCh tone curve — the perceptual grade.  We compute the L*-space    */
  /*    points from the OkLCh stops and inject them into the composite       */
  /*    curve of a Curves adjustment layer.  It also clips to the card.      */
  /* --------------------------------------------------------------------- */
  const lightnessPoints = oklchToneCurveToLightnessPoints(job.oklchCurve.stops);
  const curveId = await createTrackedLayer(
    client,
    "layer.newAdjustmentLayer.curves",
    // `lightness` is the Lab L* channel: 2..19 anchors in the 0..255 coder.
    // It is the only curve in an RGB document that is perceptually uniform.
    { lightness: lightnessPoints, smooth: 2 },
  );

  /* --------------------------------------------------------------------- */
  /* 8. Headline type — placed as point type at the caller's baseline.      */
  /*    It sits above the whole clipped stack so the grade never touches it. */
  /* --------------------------------------------------------------------- */
  const headlineId = await createTrackedLayer(
    client,
    "type.create",
    {
      x: job.headline.xPt,
      y: job.headline.yPt,
      text: job.headline.text,
      name: names.headline,
      font: job.headline.fontFamily,
      size: job.headline.sizePt,
      color: job.headline.color,
    },
  );

  /* --------------------------------------------------------------------- */
  /* 9. Deterministic names.  PhotoCraft's creation commands do not take a   */
  /*    name, so the tree is renamed in one batch: the tag is what lets a    */
  /*    later agent — or a retry — find *its* layers in a shared document.   */
  /* --------------------------------------------------------------------- */
  const renameSteps: Array<{ id: string; params: Record<string, unknown> }> = [
    { id: "layer.renameLayer", params: { layer: backdropId, name: names.backdrop } },
    { id: "layer.renameLayer", params: { layer: matteId,    name: names.matte } },
    { id: "layer.renameLayer", params: { layer: cardId,     name: names.card } },
    { id: "layer.renameLayer", params: { layer: vignetteId, name: names.vignette } },
    { id: "layer.renameLayer", params: { layer: chromaId,   name: names.chroma } },
    { id: "layer.renameLayer", params: { layer: curveId,    name: names.curve } },
  ];
  assertBatchComplete("rename", renameSteps, await client.batch(renameSteps, true));

  /* --------------------------------------------------------------------- */
  /* 10. Establish the clipping chain.  This is the nested mask relationship */
  /*     the chapter calls out: card → matte, and then vignette + chroma +   */
  /*     curve all clip to the card.  The graph settles into a deep,         */
  /*     non-destructive composite where the outer shape is determined       */
  /*     entirely by the matte's selection-derived mask.                     */
  /* --------------------------------------------------------------------- */
  const clippingSteps: Array<{ id: string; params: Record<string, unknown> }> = [
    { id: "layer.createClippingMask", params: { layer: cardId } },
    { id: "layer.createClippingMask", params: { layer: vignetteId } },
    { id: "layer.createClippingMask", params: { layer: chromaId } },
    { id: "layer.createClippingMask", params: { layer: curveId } },
    // Blend / opacity finishes: vignette multiplies to darken, chroma screens.
    { id: "layer.setProps", params: { layer: vignetteId, blend: "Multiply", opacity: 0.65 } },
    { id: "layer.setProps", params: { layer: chromaId, blend: "Screen",   opacity: 0.35 } },
    { id: "layer.setProps", params: { layer: backdropId, opacity: 1.0 } },
  ];
  assertBatchComplete("clipping", clippingSteps, await client.batch(clippingSteps, true));

  /* --------------------------------------------------------------------- */
  /* 11. Render the preview PNG (in memory) for QA and downstream delivery. */
  /* --------------------------------------------------------------------- */
  const previewBytes = await client.renderPreview(1024);

  /* --------------------------------------------------------------------- */
  /* 12. Persist: write the layered PSD via doc_save, and the preview PNG    */
  /*     directly to disk.  Both resolve against the write root, because     */
  /*     the API is relative to that root, not to this process's cwd.        */
  /* --------------------------------------------------------------------- */
  const psdPath = client.resolveWritePath(job.paths.psd);
  await mkdir(dirname(psdPath), { recursive: true });
  const saveReport = await client.docSave(psdPath);
  if (Array.isArray(saveReport.warnings)) warnings.push(...saveReport.warnings);

  let previewPath: string | undefined;
  if (job.paths.preview) {
    previewPath = client.resolveWritePath(job.paths.preview);
    await mkdir(dirname(previewPath), { recursive: true });
    await writeFile(previewPath, previewBytes);
  }

  /* --------------------------------------------------------------------- */
  /* 13. Optional multimodal QA.  A vision model scores the preview against  */
  /*     the job's declared intent and returns a machine-readable verdict.   */
  /* --------------------------------------------------------------------- */
  const visionVerdict = await runVisionQa(previewBytes, job);

  /* --------------------------------------------------------------------- */
  /* 14. Assemble the final report.                                          */
  /* --------------------------------------------------------------------- */
  return {
    jobId: job.jobId,
    tenantId: job.tenantId,
    psdPath,
    previewPath,
    layerIds: {
      backdrop: backdropId,
      matte:    matteId,
      card:     cardId,
      vignette: vignetteId,
      chroma:   chromaId,
      curve:    curveId,
      headline: headlineId,
    },
    warnings,
    durationMs: Date.now() - startedAt,
    visionVerdict,
  };
}

/* ========================================================================== */
/* §G.  Vision QA hook                                                        */
/* ========================================================================== */

export interface VisionVerdict {
  pass: boolean;
  score: number;
  issues: string[];
  notes: string;
  model: string;
}

/**
 * Send the rendered preview to a vision model and ask for a strict-JSON
 * aesthetic audit.  The audit is intentionally narrow (five checkable
 * invariants) so the model has no room to hallucinate.
 *
 * This function returns null when `OPENAI_API_KEY` is missing, which is the
 * correct behaviour for hermetic CI runs.
 */
export async function runVisionQa(
  image: Buffer,
  job: PsdBrandForgeJob,
): Promise<VisionVerdict | null> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) return null;

  const model = process.env.OPENAI_VISION_MODEL ?? "gpt-4o";
  const b64 = image.toString("base64");

  const systemPrompt =
    "You are a senior brand-design reviewer auditing a generated PSD preview. " +
    "Return STRICT JSON: { pass: boolean, score: number, issues: string[], notes: string }. " +
    "Score is 0..1 and issues is a short list of concrete visual defects. " +
    "Evaluate the following invariants and cite the number of each one you fail: " +
    "(1) The card frame is inset from the canvas and has a visibly distinct fill. " +
    "(2) The vignette is concentric and darkens only the corners. " +
    "(3) The headline is legible against its local background. " +
    "(4) The accent colour appears in the composite. " +
    "(5) No unintentional rectangular seams or hard edges are visible.";

  const userPayload = {
    jobId: job.jobId,
    tenantId: job.tenantId,
    palette: job.palette,
    headlineCopy: job.headline.text,
    curveStopCount: job.oklchCurve.stops.length,
  };

  const response = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: systemPrompt },
        {
          role: "user",
          content: [
            { type: "text", text: JSON.stringify(userPayload) },
            { type: "image_url", image_url: { url: `data:image/png;base64,${b64}` } },
          ],
        },
      ],
    }),
  });

  if (!response.ok) {
    // Vision QA is a soft audit: the PSD is already on disk, so an audit
    // failure must not sink a job that succeeded.
    return null;
  }

  const body = (await response.json()) as {
    choices: Array<{ message: { content: string } }>;
  };
  let parsed: Omit<VisionVerdict, "model">;
  try {
    parsed = JSON.parse(body.choices[0].message.content) as Omit<VisionVerdict, "model">;
  } catch {
    return null;                       // the model broke its own JSON contract
  }
  if (typeof parsed.pass !== "boolean" || typeof parsed.score !== "number") return null;
  return { ...parsed, model };
}

/* ========================================================================== */
/* §H.  Retry helper                                                          */
/* ========================================================================== */

/** Sleep helper used by the retry loop. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Heuristic for "this failure is worth retrying".  A tool call that fails
 * with a validation error must fail fast; a call that fails with a socket
 * reset or a timeout can be retried safely because PhotoCraft's command
 * registry is idempotent for read-only discovery commands and the write
 * commands we use are already coordinated through the batch meta-tool.
 */
function isTransient(err: unknown): boolean {
  const msg = describeError(err).toLowerCase();
  return (
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("econnaborted") ||
    msg.includes("etimedout") ||
    msg.includes("busy")
  );
}

/** Run `fn` with exponential backoff, bounded by `attempts`. */
export async function withRetry<T>(
  label: string,
  fn: () => Promise<T>,
  attempts = 3,
  baseDelayMs = 200,
): Promise<T> {
  let lastError: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isTransient(err)) throw err;
      await sleep(baseDelayMs * 2 ** i);
    }
  }
  throw new Error(`retry budget exhausted for ${label}: ${describeError(lastError)}`);
}

/* ========================================================================== */
/* §I.  Job runner — the public entry point used by the CLI and by tests      */
/* ========================================================================== */

/**
 * Validate a payload, open an MCP channel, orchestrate, and return a report.
 *
 * Only the *connection* is retried. The orchestration is not: it mutates a
 * document, so replaying it after a timeout would stack a second set of
 * layers on the first. Retries belong to calls that are safe to repeat —
 * `connect`, `doc_inspect`, `doc_render_preview` — not to the job as a whole.
 */
export async function runBrandForgeJob(
  rawJob: unknown,
  clientOverride?: PsdBrandForgeClient,
): Promise<GenerationReport> {
  const job = PsdBrandForgeJobSchema.parse(rawJob);

  const ownsClient = !clientOverride;
  const client =
    clientOverride ??
    new PsdBrandForgeClient({
      readRoot:  process.env.PHOTOCRAFT_READ_ROOT  ?? process.cwd(),
      writeRoot: process.env.PHOTOCRAFT_WRITE_ROOT ?? process.cwd(),
    });

  if (ownsClient) {
    await withRetry("mcp.connect", () => client.connect(), 2, 250);
  }

  try {
    return await orchestratePsdBrandKit(client, job);
  } finally {
    if (ownsClient) await client.close();
  }
}

/* ========================================================================== */
/* §J.  JSON-line protocol                                                    */
/* ========================================================================== */

/**
 * One request envelope on stdin; one response envelope on stdout.  The
 * format is line-delimited JSON so a shell pipeline can drive the worker
 * directly and a Node service can wrap it via `child_process.spawn`.
 */
interface RequestEnvelope {
  requestId: string;
  job: unknown;
}

interface ResponseEnvelope {
  requestId: string;
  ok: boolean;
  report?: GenerationReport;
  error?: string;
}

/** The CLI entry point. */
async function main(): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  for await (const line of rl) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let envelope: RequestEnvelope;
    try {
      envelope = JSON.parse(trimmed) as RequestEnvelope;
    } catch (err) {
      process.stdout.write(
        JSON.stringify({
          requestId: "unparseable",
          ok: false,
          error: `Could not parse request envelope: ${describeError(err)}`,
        } satisfies ResponseEnvelope) + "\n",
      );
      continue;
    }

    try {
      const report = await runBrandForgeJob(envelope.job);
      const response: ResponseEnvelope = { requestId: envelope.requestId, ok: true, report };
      process.stdout.write(JSON.stringify(response) + "\n");
    } catch (err) {
      const response: ResponseEnvelope = {
        requestId: envelope.requestId,
        ok: false,
        error: describeError(err),
      };
      process.stdout.write(JSON.stringify(response) + "\n");
    }
  }
}

// Guard so that importing this module from tests does not enter the loop.
// This file is ESM, so `require.main` does not exist: compare the entry URL.
const entryPoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (import.meta.url === entryPoint) {
  main().catch((err) => {
    process.stderr.write(`fatal: ${describeError(err)}\n`);
    process.exit(1);
  });
}
