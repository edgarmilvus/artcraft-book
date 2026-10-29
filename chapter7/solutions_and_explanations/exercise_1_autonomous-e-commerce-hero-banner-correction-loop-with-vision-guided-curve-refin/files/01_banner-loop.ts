// banner-loop.ts
// -----------------------------------------------------------------------------
// Autonomous PhotoCraft hero-banner correction loop.
// Uses the photocraft-cli MCP server over stdio via the official SDK.
// -----------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import OpenAI from "openai";
import { PNG } from "pngjs";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types (from the exercise starter, kept verbatim so downstream tooling works)
// ---------------------------------------------------------------------------

export type CritiqueCategory =
  | "exposure" | "color_balance" | "composition"
  | "artifact" | "brand_compliance" | "none";

export type ProposedFix =
  | { kind: "curves"; points: [number, number][]; channel?: "rgb" | "red" | "green" | "blue" }
  | { kind: "levels"; inBlack?: number; gamma?: number; inWhite?: number; outBlack?: number; outWhite?: number }
  | { kind: "vibrance"; vibrance?: number; saturation?: number }
  | { kind: "localized_curves"; points: [number, number][]; mask_rect: [number, number, number, number] }
  | { kind: "content_aware_fill"; rect: [number, number, number, number] }
  | { kind: "crop"; rect: [number, number, number, number] };

export interface VisionCritique {
  critique_category: CritiqueCategory;
  reasoning: string;
  confidence: number;
  proposed_fix: ProposedFix | null;
  footprint_pct: number;
}

export interface IterationRecord {
  iteration: number;
  beforePng: string;
  afterPng: string;
  critique: VisionCritique;
  batch: { id: string; params: Record<string, unknown> }[];
  ssd: number;
  meanLuminance: number;
  converged: boolean;
  escalated: boolean;
}

export interface BannerJob {
  sku: string;
  masterPng: string;
  referenceColorHex: string;
  brandLuminanceBand: [number, number];
  maxIterations: number;
  confidenceFloor: number;
}

// ---------------------------------------------------------------------------
// Constrained output: the same union the starter declares, as a Zod schema.
// ---------------------------------------------------------------------------

const PointSchema = z.tuple([z.number(), z.number()]);
const RectSchema = z.tuple([z.number(), z.number(), z.number(), z.number()]);

const ProposedFixSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("curves"), points: z.array(PointSchema).min(2).max(19),
             channel: z.enum(["rgb", "red", "green", "blue"]).optional() }),
  z.object({ kind: z.literal("levels"), inBlack: z.number().optional(), gamma: z.number().optional(),
             inWhite: z.number().optional(), outBlack: z.number().optional(),
             outWhite: z.number().optional() }),
  z.object({ kind: z.literal("vibrance"), vibrance: z.number().optional(),
             saturation: z.number().optional() }),
  z.object({ kind: z.literal("localized_curves"), points: z.array(PointSchema).min(2).max(19),
             mask_rect: RectSchema }),
  z.object({ kind: z.literal("content_aware_fill"), rect: RectSchema }),
  z.object({ kind: z.literal("crop"), rect: RectSchema }),
]);

const VisionCritiqueSchema = z.object({
  critique_category: z.enum(["exposure", "color_balance", "composition", "artifact", "brand_compliance", "none"]),
  reasoning: z.string().min(1).max(400),
  confidence: z.number().min(0).max(1),
  proposed_fix: ProposedFixSchema.nullable(),
  footprint_pct: z.number().min(0).max(100),
});

// ---------------------------------------------------------------------------
// MCP session over the official SDK
// ---------------------------------------------------------------------------

type BatchStep = { id: string; params: Record<string, unknown> };

interface BatchOutcome {
  completed: number;
  failed: number;
  undone: number;
  errors: string[];
}

export class PhotoCraftSession {
  private client!: Client;
  private transport!: StdioClientTransport;

  constructor(
    private readonly readRoot: string,
    private readonly writeRoot: string,
  ) {}

  async boot(): Promise<void> {
    this.transport = new StdioClientTransport({
      command: "photocraft-cli",
      args: [
        "mcp",
        "--automation-read-root", this.readRoot,
        "--automation-write-root", this.writeRoot,
      ],
    });
    this.client = new Client({ name: "banner-loop", version: "1.0.0" }, { capabilities: {} });
    await this.client.connect(this.transport);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private static unwrap(reply: unknown): unknown {
    const { content, isError } = (reply ?? {}) as { content?: unknown; isError?: boolean };
    const blocks = Array.isArray(content) ? (content as Array<Record<string, unknown>>) : [];
    const text = String(blocks.find((b) => b.type === "text")?.text ?? "");
    if (isError) throw new Error(text || "MCP tool call failed");
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  }

  async docOpen(file: string): Promise<{ index: number; width: number; height: number }> {
    const reply = await this.client.callTool({ name: "doc_open", arguments: { path: file } });
    return PhotoCraftSession.unwrap(reply) as { index: number; width: number; height: number };
  }

  async renderPreview(maxSide: number): Promise<string> {
    const reply = await this.client.callTool({
      name: "doc_render_preview",
      arguments: { max_side: maxSide },
    });
    if ((reply as { isError?: boolean }).isError) {
      throw new Error(String((reply as any).content?.[0]?.text ?? "preview failed"));
    }
    const content = (reply as { content?: Array<{ type: string; data?: string }> }).content ?? [];
    const image = content.find((block) => block.type === "image");
    if (!image?.data) throw new Error("doc_render_preview returned no image content");
    return image.data;
  }

  async commandRun(id: string, params: Record<string, unknown> = {}): Promise<unknown> {
    const reply = await this.client.callTool({
      name: "command_run",
      arguments: { id, params },
    });
    return PhotoCraftSession.unwrap(reply);
  }

  /**
   * Apply a batch and compensate a partial failure. The engine stops at
   * the first rejected step but keeps what already landed, so the session
   * undoes that prefix to give the caller all-or-nothing semantics.
   */
  async commandBatch(steps: BatchStep[], stopOnError = true): Promise<BatchOutcome> {
    if (steps.length === 0) return { completed: 0, failed: 0, undone: 0, errors: [] };
    const reply = await this.client.callTool({
      name: "command_batch",
      arguments: { steps, stop_on_error: stopOnError },
    });
    const parsed = PhotoCraftSession.unwrap(reply) as {
      completed?: number; failed?: number;
      results?: Array<{ ok: boolean; error?: string | null }>;
    };
    const completed = parsed.completed ?? 0;
    const failed = parsed.failed ?? 0;
    const errors = (parsed.results ?? [])
      .filter((r) => !r.ok && r.error)
      .map((r) => String(r.error));
    if (failed > 0) {
      for (let i = 0; i < completed; i++) await this.undo();
      return { completed: 0, failed, undone: completed, errors };
    }
    return { completed, failed: 0, undone: 0, errors: [] };
  }

  async docSave(file: string, format?: string): Promise<{ path: string; warnings: string[] }> {
    const args: Record<string, unknown> = { path: file };
    if (format) args.format = format;
    const reply = await this.client.callTool({ name: "doc_save", arguments: args });
    return PhotoCraftSession.unwrap(reply) as { path: string; warnings: string[] };
  }

  async undo(): Promise<void> {
    await this.commandRun("edit.undo", {});
  }
}

// ---------------------------------------------------------------------------
// Deterministic measurement layer (pngjs, no external service)
// ---------------------------------------------------------------------------

export interface Frame {
  width: number;
  height: number;
  data: Uint8Array;
}

export interface HistogramStats {
  meanLuminance: number;
  productRgb: [number, number, number];
}

function decodePng(base64: string): Frame {
  const png = PNG.sync.read(Buffer.from(base64, "base64"));
  return {
    width: png.width,
    height: png.height,
    data: new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.byteLength),
  };
}

function encodePng(frame: Frame): Buffer {
  const png = new PNG({ width: frame.width, height: frame.height });
  Buffer.from(frame.data).copy(png.data);
  return PNG.sync.write(png);
}

function luma(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Mean Rec.709 luma over every pixel of the frame. */
export function meanLuminance(frame: Frame): number {
  let sum = 0;
  let n = 0;
  for (let i = 0; i < frame.data.length; i += 4) {
    sum += luma(frame.data[i], frame.data[i + 1], frame.data[i + 2]);
    n++;
  }
  return n > 0 ? sum / n : 0;
}

/** Mean RGB of the central product box (the SKU sits at canvas centre). */
export function productRgb(frame: Frame, fraction = 0.3): [number, number, number] {
  const w = Math.max(1, Math.round(frame.width * fraction));
  const h = Math.max(1, Math.round(frame.height * fraction));
  const x0 = Math.floor((frame.width - w) / 2);
  const y0 = Math.floor((frame.height - h) / 2);
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * frame.width + x) * 4;
      r += frame.data[i];
      g += frame.data[i + 1];
      b += frame.data[i + 2];
      n++;
    }
  }
  return [r / n, g / n, b / n];
}

/** Crop the central `fraction` of a frame, returned as PNG bytes. */
export function centreCropPng(frame: Frame, fraction = 0.4): Buffer {
  const w = Math.max(1, Math.round(frame.width * fraction));
  const h = Math.max(1, Math.round(frame.height * fraction));
  const x0 = Math.floor((frame.width - w) / 2);
  const y0 = Math.floor((frame.height - h) / 2);
  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    const src = ((y + y0) * frame.width + x0) * 4;
    out.set(frame.data.subarray(src, src + w * 4), y * w * 4);
  }
  return encodePng({ width: w, height: h, data: out });
}

/** Nearest-neighbour downscale: exact enough for a perceptual delta. */
export function downscale(frame: Frame, maxEdge: number): Frame {
  const scale = Math.min(1, maxEdge / Math.max(frame.width, frame.height));
  const width = Math.max(1, Math.round(frame.width * scale));
  const height = Math.max(1, Math.round(frame.height * scale));
  const out = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const sy = Math.min(frame.height - 1, Math.floor(y / scale));
    for (let x = 0; x < width; x++) {
      const sx = Math.min(frame.width - 1, Math.floor(x / scale));
      const si = (sy * frame.width + sx) * 4;
      const di = (y * width + x) * 4;
      out[di] = frame.data[si];
      out[di + 1] = frame.data[si + 1];
      out[di + 2] = frame.data[si + 2];
      out[di + 3] = frame.data[si + 3];
    }
  }
  return { width, height, data: out };
}

/** Normalised sum of squared differences on RGB, 0..1. */
export function ssdBetween(a: Frame, b: Frame, maxEdge = 768): number {
  const da = downscale(a, maxEdge);
  const db = downscale(b, maxEdge);
  if (da.width !== db.width || da.height !== db.height) return 1;
  let acc = 0;
  let n = 0;
  for (let i = 0; i < da.data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const d = (da.data[i + c] - db.data[i + c]) / 255;
      acc += d * d;
      n++;
    }
  }
  return n > 0 ? acc / n : 0;
}

async function measure(photo: PhotoCraftSession, beforeB64: string): Promise<HistogramStats> {
  const frame = decodePng(beforeB64);
  return { meanLuminance: meanLuminance(frame), productRgb: productRgb(frame) };
}

// ---------------------------------------------------------------------------
// Vision call with a strict Zod-validated reply
// ---------------------------------------------------------------------------

export interface VisionInput {
  auditPngB64: string;
  productCropB64: string;
  job: BannerJob;
  currentMean: number;
}

export type VisionFn = (input: VisionInput) => Promise<VisionCritique>;

export function createOpenAiVision(model = "gpt-4o"): VisionFn {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is not set");
  const openai = new OpenAI({ apiKey });

  return async ({ auditPngB64, productCropB64, job, currentMean }) => {
    const sys = [
      "You audit a PhotoCraft-rendered e-commerce hero banner.",
      `The brand luminance band for the mean L* value is [${job.brandLuminanceBand[0]}, ${job.brandLuminanceBand[1]}].`,
      `The current measured mean L* is ${currentMean.toFixed(2)}.`,
      `The product's reference swatch is ${job.referenceColorHex}; it must stay within DeltaE2000 <= 3.`,
      "Return ONE narrow correction. Prefer localized_curves with a mask_rect when the problem is confined to a region.",
      "Return critique_category=\"none\" and proposed_fix=null when the frame satisfies the brand band.",
      "Reply with JSON only: {critique_category, reasoning, confidence, proposed_fix, footprint_pct}.",
      "proposed_fix is null or {kind: curves|levels|vibrance|localized_curves|content_aware_fill|crop, ...}.",
    ].join(" ");

    const response = await openai.chat.completions.create({
      model,
      response_format: { type: "json_object" },
      temperature: 0.1,
      messages: [
        { role: "system", content: sys },
        {
          role: "user",
          content: [
            { type: "text", text: "Image 1 is the full canvas (768 px long edge). Image 2 is a crop of the product region." },
            { type: "image_url", image_url: { url: `data:image/png;base64,${auditPngB64}` } },
            { type: "image_url", image_url: { url: `data:image/png;base64,${productCropB64}` } },
          ],
        },
      ],
    });

    const raw = response.choices[0]?.message?.content ?? "{}";
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`vision: malformed JSON: ${raw.slice(0, 200)}`);
    }
    return VisionCritiqueSchema.parse(parsed) as VisionCritique;
  };
}

// ---------------------------------------------------------------------------
// Critique → command translation (the narrowest possible command wins)
// ---------------------------------------------------------------------------

/** Reject or refine a critique by cross-checking against the histogram. */
export function validateAgainstHistogram(
  critique: VisionCritique,
  stats: HistogramStats,
  job: BannerJob,
): VisionCritique {
  const [lo, hi] = job.brandLuminanceBand;
  const insideBand = stats.meanLuminance >= lo && stats.meanLuminance <= hi;

  if (critique.critique_category === "exposure" && insideBand &&
      critique.proposed_fix?.kind === "curves") {
    return { ...critique, confidence: critique.confidence * 0.5, proposed_fix: null };
  }

  if (critique.critique_category === "color_balance") {
    const [r, , b] = stats.productRgb;
    if (b > r + 20) {   // the product has gone blue-cast
      return { ...critique, confidence: critique.confidence * 0.4, proposed_fix: null };
    }
  }

  return critique;
}

/** Translate a typed ProposedFix into PhotoCraft command specs. */
export function translateToBatch(fix: ProposedFix): BatchStep[] {
  switch (fix.kind) {
    case "curves":
      return [{
        id: "layer.newAdjustmentLayer.curves",
        params: {
          points: fix.points,
          ...(fix.channel && fix.channel !== "rgb" ? { [fix.channel]: fix.points } : {}),
        },
      }];

    case "levels":
      return [{
        id: "layer.newAdjustmentLayer.levels",
        params: {
          inBlack: fix.inBlack ?? 0,
          gamma: fix.gamma ?? 1,
          inWhite: fix.inWhite ?? 255,
          outBlack: fix.outBlack ?? 0,
          outWhite: fix.outWhite ?? 255,
        },
      }];

    case "vibrance":
      return [{
        id: "layer.newAdjustmentLayer.vibrance",
        params: {
          vibrance: fix.vibrance ?? 0,
          saturation: fix.saturation ?? 0,
        },
      }];

    case "localized_curves": {
      // The selection becomes the adjustment layer's mask, so the curve
      // only touches the rectangle. Deselect afterwards: a live selection
      // would silently mask the next iteration's global correction too.
      const [x0, y0, x1, y1] = fix.mask_rect;
      return [
        {
          id: "select.rect",
          params: {
            x: x0, y: y0, width: x1 - x0, height: y1 - y0,
            mode: "replace", antiAlias: true, feather: 24,
          },
        },
        { id: "layer.newAdjustmentLayer.curves", params: { points: fix.points } },
        { id: "select.deselect", params: {} },
      ];
    }

    case "content_aware_fill": {
      const [x0, y0, x1, y1] = fix.rect;
      return [{
        id: "edit.contentAwareFill",
        params: { area: [x0, y0, x1 - x0, y1 - y0] },
      }];
    }

    case "crop": {
      const [x0, y0, x1, y1] = fix.rect;
      return [{
        id: "image.crop",
        params: { x: x0, y: y0, width: x1 - x0, height: y1 - y0, deleteCroppedPixels: false },
      }];
    }
  }
}

// ---------------------------------------------------------------------------
// The rollback coordinator
// ---------------------------------------------------------------------------

interface Snapshot {
  file: string;          // relative to the write root
  before: Frame;
}

async function takeSnapshot(
  photo: PhotoCraftSession,
  iteration: number,
  prefix: string,
  before: Frame,
): Promise<Snapshot> {
  const file = path.posix.join(prefix || ".", `snapshot_${iteration}.pcraft`);
  await photo.docSave(file);
  return { file, before };
}

async function applyAndVerify(
  photo: PhotoCraftSession,
  batch: BatchStep[],
  snap: Snapshot,
  ssdThreshold: number,
): Promise<{ outcome: BatchOutcome; after: Frame; ssd: number; reverted: boolean }> {
  const outcome = await photo.commandBatch(batch);
  const after = decodePng(await photo.renderPreview(1920));
  const ssd = ssdBetween(snap.before, after);

  if (outcome.failed > 0) {
    return { outcome, after, ssd, reverted: true };
  }

  if (ssd > ssdThreshold) {
    for (let i = 0; i < outcome.completed; i++) await photo.undo();
    let restored = decodePng(await photo.renderPreview(1920));
    if (ssdBetween(snap.before, restored) > 0.01) {
      // Undo chain is stale: reopen the pre-batch snapshot.
      await photo.docOpen(snap.file);
      restored = decodePng(await photo.renderPreview(1920));
    }
    return { outcome, after: restored, ssd, reverted: true };
  }

  return { outcome, after, ssd, reverted: false };
}

// ---------------------------------------------------------------------------
// The main loop
// ---------------------------------------------------------------------------

const MAX_CONFIDENCE_DROPS = 2;
const SAFE_FOOTPRINT_PCT = 15;

export interface BannerRun {
  records: IterationRecord[];
  outcome: "converged" | "escalated" | "max-iterations";
  reason?: string;
}

export interface BannerDeps {
  vision?: VisionFn;
  readRoot?: string;
  writeRoot?: string;
  ssdThreshold?: number;
  log?: (line: string) => void;
}

export async function runBannerJob(
  job: BannerJob,
  outDir: string,
  deps: BannerDeps = {},
): Promise<BannerRun> {
  await fs.mkdir(outDir, { recursive: true });

  const readRoot = deps.readRoot ?? process.cwd();
  const writeRoot = deps.writeRoot ?? outDir;
  const vision = deps.vision ?? createOpenAiVision();
  const ssdThreshold = deps.ssdThreshold ?? 0.18;
  const log = deps.log ?? (() => {});

  // Engine paths are relative to the automation roots; the audit files are
  // written by Node directly into outDir.
  const master = path.relative(readRoot, path.resolve(job.masterPng)) || path.basename(job.masterPng);
  const auditPrefix = path.relative(writeRoot, path.resolve(outDir)).replace(/\\/g, "/");

  const photo = new PhotoCraftSession(readRoot, writeRoot);
  await photo.boot();

  const records: IterationRecord[] = [];
  const saveResult = async (): Promise<void> => {
    await photo.docSave(path.posix.join(auditPrefix || ".", "result.png"));
  };
  try {
    await photo.docOpen(master);

    let consecutiveLowConf = 0;
    let prevMean: number | null = null;
    let lastDelta: number | null = null;

    for (let i = 0; i < job.maxIterations; i++) {
      const beforeB64 = await photo.renderPreview(768);
      const before = decodePng(beforeB64);
      const beforePath = path.join(outDir, `iteration_${i}_before.png`);
      await fs.writeFile(beforePath, Buffer.from(beforeB64, "base64"));

      const stats = await measure(photo, beforeB64);
      const productCrop = decodePng(await photo.renderPreview(1536));
      const productCropB64 = centreCropPng(productCrop).toString("base64");

      let critique = await vision({
        auditPngB64: beforeB64,
        productCropB64,
        job,
        currentMean: stats.meanLuminance,
      });
      critique = validateAgainstHistogram(critique, stats, job);
      log(`cycle ${i}: ${critique.critique_category} conf=${critique.confidence.toFixed(2)} mean=${stats.meanLuminance.toFixed(1)}`);

      await fs.writeFile(
        path.join(outDir, `iteration_${i}_critique.json`),
        JSON.stringify(critique, null, 2),
      );

      const record = (over: Partial<IterationRecord>): IterationRecord => ({
        iteration: i,
        beforePng: beforePath,
        afterPng: beforePath,
        critique,
        batch: [],
        ssd: 0,
        meanLuminance: stats.meanLuminance,
        converged: false,
        escalated: false,
        ...over,
      });

      const finish = async (rec: IterationRecord): Promise<BannerRun> => {
        records.push(rec);
        await writeAudit(outDir, rec, rec.batch.map((b) => b.id));
        await saveResult();
        return {
          records,
          outcome: rec.escalated ? "escalated" : rec.converged ? "converged" : "max-iterations",
        };
      };

      // Confidence floor: two consecutive weak critiques escalate. A single
      // one skips the batch — rolling back a change we never made is a no-op.
      if (critique.confidence < job.confidenceFloor) {
        consecutiveLowConf++;
        const weak = record({ escalated: consecutiveLowConf >= MAX_CONFIDENCE_DROPS });
        records.push(weak);
        await writeAudit(outDir, weak, []);
        if (weak.escalated) {
          await saveResult();
          return { records, outcome: "escalated", reason: "two consecutive low-confidence critiques" };
        }
        // Nothing was applied, so there is nothing to roll back; try again.
        continue;
      }
      consecutiveLowConf = 0;

      // Dangerous footprint: content-aware fill over 15 % of the canvas.
      if (critique.proposed_fix?.kind === "content_aware_fill" &&
          critique.footprint_pct > SAFE_FOOTPRINT_PCT) {
        return await finish(record({ escalated: true }));
      }

      if (critique.critique_category === "none" || !critique.proposed_fix) {
        return await finish(record({ converged: true }));
      }

      // Second-derivative convergence on mean luminance (needs two deltas).
      const delta = prevMean === null ? null : stats.meanLuminance - prevMean;
      const secondDiff = delta === null || lastDelta === null ? null : Math.abs(delta - lastDelta);
      if (secondDiff !== null && secondDiff <= 0.4) {
        return await finish(record({ converged: true }));
      }

      const batch = translateToBatch(critique.proposed_fix);
      await fs.writeFile(
        path.join(outDir, `iteration_${i}_batch.json`),
        JSON.stringify(batch, null, 2),
      );

      const snap = await takeSnapshot(photo, i, auditPrefix, before);
      const applied = await applyAndVerify(photo, batch, snap, ssdThreshold);
      const afterPath = path.join(outDir, `iteration_${i}_after.png`);
      await fs.writeFile(afterPath, encodePng(applied.after));

      const afterStats = { meanLuminance: meanLuminance(applied.after) };
      const rec = record({
        afterPng: afterPath,
        batch,
        ssd: applied.ssd,
        meanLuminance: afterStats.meanLuminance,
        escalated: applied.reverted,
        converged: false,
      });
      records.push(rec);
      await writeAudit(outDir, rec, batch.map((b) => b.id));
      if (applied.reverted) {
        log(`cycle ${i}: reverted (ssd ${applied.ssd.toFixed(3)})`);
        await saveResult();
        return { records, outcome: "escalated", reason: "rollback" };
      }

      prevMean = stats.meanLuminance;
      lastDelta = afterStats.meanLuminance - stats.meanLuminance;
    }

    await saveResult();
    return { records, outcome: "max-iterations" };
  } finally {
    await photo.close();
  }
}

async function writeAudit(dir: string, rec: IterationRecord, commandIds: string[]): Promise<void> {
  const ssdRecord = { ssd: rec.ssd, converged: rec.converged, escalated: rec.escalated };
  await fs.writeFile(path.join(dir, `iteration_${rec.iteration}_ssd.json`), JSON.stringify(ssdRecord, null, 2));
  await fs.appendFile(path.join(dir, "audit.ndjson"), JSON.stringify({ ...rec, commandIds }) + "\n");
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function main(): Promise<void> {
  const job: BannerJob = {
    sku: process.argv[2] ?? "SKU-0001",
    masterPng: process.argv[3] ?? "input/hero.png",
    referenceColorHex: process.argv[4] ?? "#c94a1e",
    brandLuminanceBand: [62, 74],
    maxIterations: 5,
    confidenceFloor: 0.72,
  };
  const out = `audit_${job.sku}_${createHash("sha1").update(job.masterPng).digest("hex").slice(0, 8)}`;
  const run = await runBannerJob(job, out);
  console.log(JSON.stringify(run.records.map((h) => ({
    i: h.iteration, ssd: h.ssd.toFixed(3), mean: h.meanLuminance.toFixed(2),
    converged: h.converged, escalated: h.escalated,
  })), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error("[fatal]", err);
    process.exitCode = 1;
  });
}
