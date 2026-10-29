// 02_pipeline.ts
// ---------------------------------------------------------------------------
// Exercise 6 (Capstone) — PhotoCraft -> DesignCraft -> PdfCraft.
//
// Each application runs in its own MCP process. The orchestrator never writes
// into the job workspace directly: photos are saved by PhotoCraft, the layout
// by DesignCraft, and the PDF by PdfCraft. The only direct writes are the
// pre-flight copy and its restore, which are filesystem operations by design.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { mkdirSync, existsSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

export type FailureKind =
  | "retryable_transient"
  | "retryable_with_correction"
  | "human_required"
  | "unrecoverable";

export interface StageResult<T> {
  stage: "photocraft" | "designcraft" | "pdfcraft" | "vision_local" | "vision_global" | "preflight";
  ok: boolean;
  output: T | null;
  failure: { kind: FailureKind; message: string; retryable: boolean } | null;
  attempts: number;
  elapsedMs: number;
}

export interface BrochureJob {
  jobId: string;
  productPhotos: { sku: string; sourcePath: string }[];
  designTemplatePath: string;
  outputPdfPath: string;
  preflightMinPpi: number;
  budgetMsPerSpread: number;
  /** Directory for treated photos, the working layout and the export. */
  workspace: string;
  photosPerPage?: number;
  /** Grid gutter in points when the template does not expose one. */
  gutterPt?: number;
}

export interface LocalCritique {
  exposure_ok: boolean;
  color_ok: boolean;
  retouch_artifacts: string[];
  confidence: number;
  note: string;
}

export interface LocalAuditCacheEntry {
  photoSha256: string;
  critique: LocalCritique;
  cachedAtEpochMs: number;
}

export interface SpreadAudit {
  spreadIndex: number;
  imageGutterSpill: { sku: string; frameId: number }[];
  typographyHierarchyOk: boolean;
  brandComplianceOk: boolean;
  traceableFindings: { sku: string; photoCraftCommandToUndo: string; note: string }[];
  confidence: number;
}

export type RollbackStrategy = "accept_partial_human_required" | "restore_from_copy";

export interface CrossAppSnapshot {
  jobId: string;
  pristineCopyDir: string;
  pristineHashes: Record<string, string>;
  photosWereRewritten: boolean;
  designCraftWasSaved: boolean;
}

export interface PipelineRunReport {
  jobId: string;
  stages: StageResult<unknown>[];
  localAuditCacheHits: number;
  localAuditCacheMisses: number;
  globalAudit: SpreadAudit[];
  rollbackStrategy: RollbackStrategy;
  finalPdfWritten: boolean;
  humanRequired: boolean;
  humanRequiredReasons: string[];
}

export interface PreflightIssue {
  severity: "error" | "warning";
  code: "missing_image" | "low_ppi" | "unstyled_text" | "pdf_unreadable";
  message: string;
  sku: string | null;
  frameId: number | null;
  ppi: number | null;
}

// ---------------------------------------------------------------------------
// Engine session
// ---------------------------------------------------------------------------

export class EngineError extends Error {
  constructor(message: string, public readonly transient: boolean) {
    super(message);
    this.name = "EngineError";
  }
}

export interface EngineRoots {
  /** Directory the engine may read from (PhotoCraft's automation read root). */
  read?: string;
  /** Directory the engine may write to (PhotoCraft's automation write root). */
  write?: string;
}

export class Engine {
  private readonly client = new Client({ name: "brochure-pipeline", version: "1.0.0" }, { capabilities: {} });
  private connected = false;

  constructor(
    public readonly bin: string,
    public readonly args: string[] = ["mcp"],
    public readonly roots: EngineRoots = {},
  ) {}

  /**
   * PhotoCraft refuses absolute paths and PdfCraft resolves them against its
   * own root, so every engine gets its path through this helper.
   */
  private relativeTo(root: string | undefined, absolutePath: string): string {
    if (!root) return absolutePath;
    const relative = path.relative(root, absolutePath);
    if (relative.startsWith("..")) {
      throw new EngineError(`${absolutePath} is outside the automation root ${root}`, false);
    }
    return relative.split(path.sep).join("/");
  }

  readPath(absolutePath: string): string {
    return this.relativeTo(this.roots.read, absolutePath);
  }

  writePath(absolutePath: string): string {
    return this.relativeTo(this.roots.write ?? this.roots.read, absolutePath);
  }

  async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(
      new StdioClientTransport({ command: this.bin, args: this.args, stderr: "pipe" }),
    );
    this.connected = true;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.client.close();
  }

  /** Raw MCP tool call; JSON text is parsed, image blocks are returned as base64. */
  async tool<T = any>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    await this.connect();
    let result: any;
    try {
      result = await this.client.callTool({ name, arguments: args });
    } catch (error) {
      throw new EngineError(`${this.bin}: ${(error as Error).message}`, true);
    }
    if (result.isError) {
      const message = result.content?.find((block: any) => block.type === "text")?.text ?? "unknown error";
      throw new EngineError(message, false);
    }
    const image = result.content?.find((block: any) => block.type === "image");
    if (image) return { png: image.data, mimeType: image.mimeType } as unknown as T;
    const text = result.content?.find((block: any) => block.type === "text")?.text ?? "";
    if (!text) return null as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  /** DesignCraft's command gateway. */
  async execute<T = any>(command: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.tool<T>("execute", { command, params });
  }

  /** PhotoCraft's command gateway. */
  async run<T = any>(id: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.tool<T>("command_run", { id, params });
  }

  async batch(steps: { id: string; params?: Record<string, unknown> }[]): Promise<any> {
    return this.tool("command_batch", { steps, stop_on_error: true });
  }
}

// ---------------------------------------------------------------------------
// Failure taxonomy and stage wrapper
// ---------------------------------------------------------------------------

export function isTransient(error: unknown): boolean {
  if (error instanceof EngineError) return error.transient;
  const message = (error as Error)?.message ?? "";
  return /unreachable|ECONNREFUSED|EPIPE|timed out|spawn|not running/i.test(message);
}

/** Vision confidence mapping from the exercise contract. */
export function classifyVisionConfidence(confidence: number): FailureKind | null {
  if (confidence < 0.55) return "human_required";
  if (confidence < 0.70) return "retryable_with_correction";
  return null;
}

export function classifyPreflightIssue(issue: PreflightIssue): FailureKind {
  if (issue.code === "missing_image") return "human_required";
  if (issue.code === "pdf_unreadable") return "unrecoverable";
  return "retryable_with_correction";
}

export interface StageDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Run one stage, retrying only transient transport failures. Everything else
 * returns immediately with its classification; the caller decides whether the
 * pipeline can continue.
 */
export async function withStage<T>(
  stage: StageResult<T>["stage"],
  fn: () => Promise<T>,
  deps: StageDeps = {},
  classify: (error: unknown) => FailureKind = (error) => (isTransient(error) ? "retryable_transient" : "unrecoverable"),
): Promise<StageResult<T>> {
  const now = deps.now ?? Date.now;
  const sleep = deps.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const started = now();
  const maxAttempts = 4;
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const output = await fn();
      return { stage, ok: true, output, failure: null, attempts: attempt, elapsedMs: now() - started };
    } catch (error) {
      lastError = error;
      const kind = classify(error);
      if (kind !== "retryable_transient" || attempt === maxAttempts) {
        return {
          stage,
          ok: false,
          output: null,
          failure: { kind, message: (error as Error).message, retryable: kind === "retryable_transient" },
          attempts: attempt,
          elapsedMs: now() - started,
        };
      }
      await sleep(250 * 2 ** (attempt - 1));
    }
  }

  return {
    stage,
    ok: false,
    output: null,
    failure: { kind: "unrecoverable", message: (lastError as Error)?.message ?? "unreachable", retryable: false },
    attempts: maxAttempts,
    elapsedMs: now() - started,
  };
}

// ---------------------------------------------------------------------------
// Local audit cache
// ---------------------------------------------------------------------------

export class LocalAuditCache {
  private readonly map = new Map<string, LocalAuditCacheEntry>();
  private hits = 0;
  private misses = 0;
  private readonly now: () => number;

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  async get(photoSha256: string): Promise<LocalAuditCacheEntry | null> {
    const entry = this.map.get(photoSha256);
    if (entry) {
      this.hits += 1;
      return entry;
    }
    this.misses += 1;
    return null;
  }

  set(photoSha256: string, critique: LocalCritique): void {
    this.map.set(photoSha256, { photoSha256, critique, cachedAtEpochMs: this.now() });
  }

  stats(): { hits: number; misses: number } {
    return { hits: this.hits, misses: this.misses };
  }
}

// ---------------------------------------------------------------------------
// Pre-flight copy and restore
// ---------------------------------------------------------------------------

export const ROLLBACK_STRATEGY: RollbackStrategy = "restore_from_copy";

export function workingPhotoPath(job: BrochureJob, sku: string): string {
  return path.join(job.workspace, "photos", `${sku}.png`);
}

export function treatedPhotoPath(job: BrochureJob, sku: string): string {
  return path.join(job.workspace, "treated", `${sku}.png`);
}

/**
 * Copy every source photo twice: once into the pristine folder, which is the
 * only thing the rollback may restore from, and once into the working folder,
 * which is the file PhotoCraft opens and the brochure links to.
 */
export async function createPristineCopy(job: BrochureJob): Promise<CrossAppSnapshot> {
  const dir = path.join(job.workspace, "_pristine", job.jobId);
  await fs.mkdir(dir, { recursive: true });
  await fs.mkdir(path.join(job.workspace, "photos"), { recursive: true });
  const hashes: Record<string, string> = {};
  for (const photo of job.productPhotos) {
    const bytes = await fs.readFile(photo.sourcePath);
    const pristine = path.join(dir, path.basename(photo.sourcePath));
    await fs.writeFile(pristine, bytes);
    await fs.writeFile(workingPhotoPath(job, photo.sku), bytes);
    hashes[photo.sku] = createHash("sha256").update(bytes).digest("hex");
  }
  return {
    jobId: job.jobId,
    pristineCopyDir: dir,
    pristineHashes: hashes,
    photosWereRewritten: false,
    designCraftWasSaved: false,
  };
}

export async function restoreFromCopy(snapshot: CrossAppSnapshot, job: BrochureJob): Promise<void> {
  if (!snapshot.photosWereRewritten) return;
  for (const photo of job.productPhotos) {
    const source = path.join(snapshot.pristineCopyDir, path.basename(photo.sourcePath));
    const bytes = await fs.readFile(source);
    const hash = createHash("sha256").update(bytes).digest("hex");
    if (hash !== snapshot.pristineHashes[photo.sku]) {
      throw new Error(`pristine copy corrupt for ${photo.sku}`);
    }
    // The brochure links to the working copy, so restoring it is what puts the
    // un-retouched photo back behind the layout.
    await fs.writeFile(workingPhotoPath(job, photo.sku), bytes);
  }
  snapshot.photosWereRewritten = false;
}

// ---------------------------------------------------------------------------
// Vision interfaces
// ---------------------------------------------------------------------------

export interface LocalVision {
  audit(photoPngB64: string, sku: string): Promise<LocalCritique>;
}

export interface SpreadContext {
  spreadIndex: number;
  page: number;
  gutterRectPt: [number, number, number, number];
  placements: { sku: string; frameId: number; bounds: [number, number, number, number] }[];
  pageWidthPt: number;
  pageHeightPt: number;
}

export interface GlobalVision {
  audit(spreadPngB64: string, context: SpreadContext): Promise<SpreadAudit>;
}

export interface PipelineVision {
  local: LocalVision;
  global: GlobalVision;
}

export interface PipelineDeps extends StageDeps {
  photo: Engine;
  design: Engine;
  pdf: Engine;
  vision: PipelineVision;
  /** Optional hook used when a frame must be shrunk to satisfy the PPI gate. */
  correctPpi?: (notes: { frameId: number; sku: string; currentPpi: number }) => Promise<void>;
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

export interface PageGeometry {
  page: number;
  spread: number;
  width: number;
  height: number;
  margins: { top: number; bottom: number; inside: number; outside: number };
  columns: number;
  gutter: number;
  columnWidth: number;
}

export function pageGeometry(document: any, fallbackGutter = 18): PageGeometry[] {
  const columns = (document.spreads?.[0]?.pages?.[0]?.columns ?? 1) as number;
  const gutter = (document.spreads?.[0]?.pages?.[0]?.columnGutter ?? document.settings?.columnGutter ?? fallbackGutter) as number;
  return (document.spreads ?? []).flatMap((spread: any) =>
    (spread.pages ?? []).map((page: any) => {
      const [x0, y0, x1, y1] = page.bounds as number[];
      const margins = page.margins ?? { top: 36, bottom: 36, inside: 36, outside: 36 };
      const contentWidth = (x1 - x0) - margins.inside - margins.outside;
      const columnWidth = (contentWidth - gutter * (columns - 1)) / columns;
      return {
        page: page.index,
        spread: spread.index,
        width: x1 - x0,
        height: y1 - y0,
        margins,
        columns,
        gutter,
        columnWidth,
      };
    }),
  );
}

export function gutterRect(page: PageGeometry): [number, number, number, number] {
  const x = page.margins.outside + page.columnWidth;
  return [x, 0, x + page.gutter, page.height];
}

// ---------------------------------------------------------------------------
// PhotoCraft leg
// ---------------------------------------------------------------------------

export interface TreatedPhoto {
  sku: string;
  path: string;
  sha256: string;
}

const TREATMENT = [
  { id: "layer.newAdjustmentLayer.levels", params: { gamma: 1.04, inBlack: 2, inWhite: 253 } },
  { id: "layer.newAdjustmentLayer.vibrance", params: { vibrance: 12, saturation: 0 } },
];

export async function treatPhoto(
  photo: Engine,
  sku: string,
  workingPath: string,
  treatedPath: string,
  commands: { id: string; params: Record<string, unknown> }[] = TREATMENT,
): Promise<TreatedPhoto> {
  await photo.tool("doc_open", { path: photo.readPath(workingPath) });
  await photo.batch(commands);
  await photo.tool("doc_save", { path: photo.writePath(treatedPath), format: "png" });
  await photo.tool("doc_close", {});
  const bytes = await fs.readFile(treatedPath);
  return { sku, path: treatedPath, sha256: createHash("sha256").update(bytes).digest("hex") };
}

// ---------------------------------------------------------------------------
// DesignCraft leg
// ---------------------------------------------------------------------------

export interface Placement {
  sku: string;
  treatedPath: string;
  frameId: number;
  bounds: [number, number, number, number];
  page: number;
  spread: number;
}

export interface DesignResult {
  designPath: string;
  placements: Placement[];
  pages: PageGeometry[];
  pageRasters: { page: number; png: string }[];
  ppiUses: { asset: number; frameId: number; page: number; ppi: number }[];
  appliedTextStyles: Map<number, string>;
  stories: { id: number }[];
}

export async function layOutBrochure(
  design: Engine,
  job: BrochureJob,
  treated: TreatedPhoto[],
): Promise<DesignResult> {
  await design.tool("open_document", { path: job.designTemplatePath });
  const document = await design.tool<any>("inspect_document");
  const pages = pageGeometry(document, job.gutterPt ?? 18);
  const perPage = job.photosPerPage ?? 2;
  const appliedTextStyles = new Map<number, string>();

  // The template's first page style defines the grid for every page.
  const style = await design.tool<any>("execute", {
    command: "style.paragraph.create",
    params: {
      name: "Body Copy",
      para: { align: "left", spaceBefore: 6, spaceAfter: 0, hyphenate: true },
      chars: { fontFamily: "Helvetica", fontStyle: "Regular", size: 10 },
    },
  }).catch(() => null);

  const placements: Placement[] = [];
  for (const [index, photo] of treated.entries()) {
    const slot = Math.floor(index / perPage);
    const position = index % perPage;
    const page = pages[slot % pages.length];
    if (!page) break;
    const x = page.margins.outside + position * (page.columnWidth + page.gutter);
    const y = page.margins.top;
    const width = page.columnWidth;
    const placed = await design.tool<any>("place_image", {
      path: photo.path,
      spread: page.spread,
      x,
      y,
      width,
    });
    const after = await design.tool<any>("inspect_document");
    const item = (after.spreads ?? [])
      .flatMap((spread: any) => spread.items ?? [])
      .find((entry: any) => entry.id === placed.id);
    placements.push({
      sku: photo.sku,
      treatedPath: photo.path,
      frameId: placed.id,
      bounds: item?.bounds ?? [x, y, x + width, y + width],
      page: page.page,
      spread: page.spread,
    });

    const textY = (item?.bounds?.[3] ?? y + width) + 14;
    const caption = await design.execute<any>("frame.create", {
      spread: page.spread,
      rect: [x, textY, x + width, textY + 70],
      content: "text",
      text: `${photo.sku.replace(/-/g, " ")}\nThe 2026 studio collection`,
      caret: true,
    });
    if (style !== null) {
      await design.execute("text.select", {
        story: caption.story,
        anchor: 0,
        focus: `${photo.sku.replace(/-/g, " ")}\nThe 2026 studio collection`.length,
      });
      await design.execute("style.paragraph.apply", { name: "Body Copy" });
      await design.execute("text.exitToFrame");
      appliedTextStyles.set(caption.story, "Body Copy");
    }
  }

  await design.tool("save_document", { path: path.join(job.workspace, "design", `${job.jobId}.designcraft`) });

  const pageRasters: { page: number; png: string }[] = [];
  for (const page of pages) {
    const render = await design.tool<any>("render_page", { page: page.page, scale: 1 });
    pageRasters.push({ page: page.page, png: render.png });
  }

  return {
    designPath: path.join(job.workspace, "design", `${job.jobId}.designcraft`),
    placements,
    pages,
    pageRasters,
    ppiUses: await readPpiUses(design),
    appliedTextStyles,
    stories: (document.stories ?? []).map((story: any) => ({ id: story.id })),
  };
}

async function readPpiUses(design: Engine): Promise<DesignResult["ppiUses"]> {
  // `links.list` answers with an array; older builds wrapped it in {links}.
  const raw = await design.execute<any>("links.list").catch(() => []);
  const links = Array.isArray(raw) ? raw : (raw?.links ?? []);
  return links.flatMap((link: any) =>
    (link.uses ?? []).map((use: any) => ({
      asset: link.asset,
      frameId: use.id,
      // The engine serialises page numbers as strings.
      page: Number(use.page) - 1,
      ppi: use.ppi,
    })),
  );
}

/** Re-render and re-read the current document without opening the template again. */
export async function refreshDesign(
  design: Engine,
  job: BrochureJob,
  placements: Placement[],
  appliedTextStyles = new Map<number, string>(),
): Promise<DesignResult> {
  const document = await design.tool<any>("inspect_document");
  const pages = pageGeometry(document, job.gutterPt ?? 18);
  const pageRasters: { page: number; png: string }[] = [];
  for (const page of pages) {
    const render = await design.tool<any>("render_page", { page: page.page, scale: 1 });
    pageRasters.push({ page: page.page, png: render.png });
  }
  return {
    designPath: path.join(job.workspace, "design", `${job.jobId}.designcraft`),
    placements,
    pages,
    pageRasters,
    ppiUses: await readPpiUses(design),
    appliedTextStyles,
    stories: (document.stories ?? []).map((story: any) => ({ id: story.id })),
  };
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/**
 * DesignCraft owns the placement geometry, so its link table is the authority
 * for effective PPI. PdfCraft is asked the same question about the exported
 * page images; both answers must clear the gate.
 */
export function preflightFromDesign(
  uses: { frameId: number; page: number; ppi: number }[],
  placements: Placement[],
  minPpi: number,
): PreflightIssue[] {
  return uses
    .filter((use) => use.ppi < minPpi)
    .map((use) => {
      const placement = placements.find((entry) => entry.frameId === use.frameId);
      return {
        severity: "error" as const,
        code: "low_ppi" as const,
        message: `Frame ${use.frameId} on page ${use.page + 1} renders at ${use.ppi.toFixed(0)} PPI, below ${minPpi}.`,
        sku: placement?.sku ?? null,
        frameId: use.frameId,
        ppi: use.ppi,
      };
    });
}

export function preflightTextStyles(
  stories: { id: number }[],
  appliedTextStyles: Map<number, string>,
): PreflightIssue[] {
  return stories
    .filter((story) => !appliedTextStyles.has(story.id))
    .map((story) => ({
      severity: "warning" as const,
      code: "unstyled_text" as const,
      message: `Story ${story.id} has no applied paragraph style.`,
      sku: null,
      frameId: null,
      ppi: null,
    }));
}

export interface PdfImageUse {
  page: number;
  pixels: [number, number];
  rect: [number, number, number, number];
}

export function preflightFromPdf(images: PdfImageUse[], minPpi: number): PreflightIssue[] {
  const issues: PreflightIssue[] = [];
  for (const image of images) {
    const [x0, y0, x1, y1] = image.rect;
    const widthInches = Math.max(1e-6, (x1 - x0) / 72);
    const heightInches = Math.max(1e-6, (y1 - y0) / 72);
    const ppi = Math.min(image.pixels[0] / widthInches, image.pixels[1] / heightInches);
    if (ppi < minPpi) {
      issues.push({
        severity: "error",
        code: "low_ppi",
        message: `PDF page ${image.page} draws ${image.pixels[0]}x${image.pixels[1]} px in ${(x1 - x0).toFixed(1)}x${(y1 - y0).toFixed(1)} pt (${ppi.toFixed(0)} PPI).`,
        sku: null,
        frameId: null,
        ppi,
      });
    }
  }
  return issues;
}

/** Shrink the frame until the linked pixels reach the requested effective PPI. */
export async function shrinkFrameForPpi(
  design: Engine,
  frameId: number,
  currentPpi: number,
  minPpi: number,
): Promise<void> {
  const document = await design.tool<any>("inspect_document");
  const item = (document.spreads ?? [])
    .flatMap((spread: any) => spread.items ?? [])
    .find((entry: any) => entry.id === frameId);
  if (!item) throw new Error(`frame ${frameId} not found`);
  const [x0, y0, x1, y1] = item.bounds as number[];
  const factor = Math.max(0.4, Math.min(0.98, (currentPpi / minPpi) * 0.98));
  const width = (x1 - x0) * factor;
  const height = (y1 - y0) * factor;
  // `content: true` scales the placed picture with the frame; resizing the
  // frame alone would crop the picture and leave the effective PPI untouched.
  await design.execute("transform.resize", {
    ids: [frameId],
    from: [x0, y0, x1, y1],
    to: [x0, y0, x0 + width, y0 + height],
    content: true,
  });
}

// ---------------------------------------------------------------------------
// PdfCraft leg
// ---------------------------------------------------------------------------

export interface PdfResult {
  docId: number;
  pageImages: PdfImageUse[];
  pageRasters: { page: number; png: string }[];
}

export async function openAndRenderPdf(
  pdf: Engine,
  pdfPath: string,
  pages: number[],
): Promise<PdfResult> {
  const opened = await pdf.tool<any>("doc_open", { path: pdfPath });
  const docId = opened.doc;
  if (opened.pages !== pages.length) {
    throw new EngineError(`PDF has ${opened.pages} pages, expected ${pages.length}`, false);
  }
  const pageImages: PdfImageUse[] = [];
  const pageRasters: { page: number; png: string }[] = [];
  for (const page of pages) {
    const images = await pdf.tool<any>("page_images", { doc: docId, page: page + 1 });
    for (const image of images.images ?? []) {
      pageImages.push({ page: page + 1, pixels: image.pixels, rect: image.rect });
    }
    const render = await pdf.tool<any>("page_render", { doc: docId, page: page + 1, dpi: 96 });
    pageRasters.push({ page, png: render.png });
  }
  return { docId, pageImages, pageRasters };
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export async function runBrochurePipeline(job: BrochureJob, deps: PipelineDeps): Promise<PipelineRunReport> {
  const report: PipelineRunReport = {
    jobId: job.jobId,
    stages: [],
    localAuditCacheHits: 0,
    localAuditCacheMisses: 0,
    globalAudit: [],
    rollbackStrategy: ROLLBACK_STRATEGY,
    finalPdfWritten: false,
    humanRequired: false,
    humanRequiredReasons: [],
  };

  const cache = new LocalAuditCache(deps.now ?? Date.now);
  const snapshot = await createPristineCopy(job);
  mkdirSync(path.join(job.workspace, "treated"), { recursive: true });
  mkdirSync(path.join(job.workspace, "design"), { recursive: true });
  mkdirSync(path.join(job.workspace, "export"), { recursive: true });

  const human = (reason: string) => {
    report.humanRequired = true;
    report.humanRequiredReasons.push(reason);
  };

  try {
    // ---- PhotoCraft + local vision ---------------------------------------
    const treated: TreatedPhoto[] = [];
    for (const photo of job.productPhotos) {
      const treatedPath = treatedPhotoPath(job, photo.sku);
      const workingPath = workingPhotoPath(job, photo.sku);
      // Every pass starts from the pristine bytes, so the same source photo
      // always produces the same treated file — and the same cache key.
      await fs.copyFile(
        path.join(snapshot.pristineCopyDir, path.basename(photo.sourcePath)),
        workingPath,
      );
      const photoStage = await withStage(
        "photocraft",
        () => treatPhoto(deps.photo, photo.sku, workingPath, treatedPath),
        deps,
      );
      report.stages.push(photoStage);
      if (!photoStage.ok) {
        human(`PhotoCraft failed for ${photo.sku}: ${photoStage.failure?.message}`);
        continue;
      }
      // The treated file replaces the working copy: that copy is what the
      // brochure links to, so restoring it is what undoes the retouching.
      await fs.copyFile(treatedPath, workingPath);
      snapshot.photosWereRewritten = true;
      treated.push({ ...photoStage.output!, path: workingPath });

      const bytes = await fs.readFile(workingPath);
      const hash = photoStage.output!.sha256;
      const cached = await cache.get(hash);
      let critique = cached?.critique ?? null;
      if (!critique) {
        const auditStage = await withStage(
          "vision_local",
          () => deps.vision.local.audit(bytes.toString("base64"), photo.sku),
          deps,
        );
        report.stages.push(auditStage);
        if (!auditStage.ok) {
          human(`Local vision failed for ${photo.sku}: ${auditStage.failure?.message}`);
          continue;
        }
        critique = auditStage.output!;
        cache.set(hash, critique);
      }

      const confidenceFailure = classifyVisionConfidence(critique.confidence);
      if (confidenceFailure === "human_required") {
        human(`Local audit confidence ${critique.confidence.toFixed(2)} for ${photo.sku} needs a human.`);
        continue;
      }
      if (confidenceFailure === "retryable_with_correction") {
        // One corrective pass: a conservative curve lift, then a fresh audit.
        // One corrective pass: put the pristine photo back, re-run a milder
        // treatment, and audit the result again.
        const corrected = await withStage(
          "photocraft",
          async () => {
            await fs.copyFile(
              path.join(snapshot.pristineCopyDir, path.basename(photo.sourcePath)),
              workingPhotoPath(job, photo.sku),
            );
            await deps.photo.tool("doc_open", { path: deps.photo.readPath(workingPhotoPath(job, photo.sku)) });
            await deps.photo.batch([
              { id: "layer.newAdjustmentLayer.curves", params: { points: [[0, 0], [64, 52], [192, 204], [255, 255]] } },
            ]);
            await deps.photo.tool("doc_save", { path: deps.photo.writePath(treatedPath), format: "png" });
            await deps.photo.tool("doc_close", {});
            await fs.copyFile(treatedPath, workingPhotoPath(job, photo.sku));
            const correctedBytes = await fs.readFile(workingPhotoPath(job, photo.sku));
            return {
              sku: photo.sku,
              path: workingPhotoPath(job, photo.sku),
              sha256: createHash("sha256").update(correctedBytes).digest("hex"),
            };
          },
          deps,
        );
        report.stages.push(corrected);
        if (!corrected.ok) {
          human(`Correction failed for ${photo.sku}`);
          continue;
        }
        const correctedBytes = await fs.readFile(workingPhotoPath(job, photo.sku));
        const reaudit = await deps.vision.local.audit(correctedBytes.toString("base64"), photo.sku);
        if (reaudit.confidence < 0.70) {
          human(`Local audit still ${reaudit.confidence.toFixed(2)} after one correction for ${photo.sku}.`);
          continue;
        }
        treated[treated.length - 1] = corrected.output!;
        cache.set(corrected.output!.sha256, reaudit);
      }
    }

    if (report.humanRequired) {
      return report;
    }

    // ---- DesignCraft ------------------------------------------------------
    const designStage = await withStage(
      "designcraft",
      () => layOutBrochure(deps.design, job, treated),
      deps,
    );
    report.stages.push(designStage);
    if (!designStage.ok) {
      human(`DesignCraft failed: ${designStage.failure?.message}`);
      await restoreFromCopy(snapshot, job);
      return report;
    }
    snapshot.designCraftWasSaved = true;
    let design = designStage.output!;

    // ---- Design-side preflight -------------------------------------------
    const styleIssues = preflightTextStyles(design.stories, design.appliedTextStyles);
    report.stages.push({
      stage: "preflight",
      ok: styleIssues.length === 0,
      output: styleIssues,
      failure: styleIssues.length
        ? { kind: "human_required", message: `${styleIssues.length} text stories have no paragraph style`, retryable: false }
        : null,
      attempts: 1,
      elapsedMs: 0,
    });
    if (styleIssues.length > 0) {
      human(`Text preflight failed: ${styleIssues.map((issue) => issue.message).join("; ")}`);
      return report;
    }

    let issues = preflightFromDesign(design.ppiUses, design.placements, job.preflightMinPpi);
    report.stages.push({
      stage: "preflight",
      ok: issues.length === 0,
      output: issues,
      failure: issues.length
        ? { kind: "retryable_with_correction", message: `${issues.length} frames below ${job.preflightMinPpi} PPI`, retryable: true }
        : null,
      attempts: 1,
      elapsedMs: 0,
    });

    if (issues.length > 0) {
      // One correction loop, exactly like the vision-confidence rule.
      for (const issue of issues) {
        if (issue.frameId === null || issue.ppi === null) continue;
        if (deps.correctPpi) {
          await deps.correctPpi({ frameId: issue.frameId, sku: issue.sku ?? "", currentPpi: issue.ppi });
        } else {
          await shrinkFrameForPpi(deps.design, issue.frameId, issue.ppi, job.preflightMinPpi);
        }
      }
      await deps.design.tool("save_document", { path: design.designPath });
      const refreshed = await withStage(
        "designcraft",
        () => refreshDesign(deps.design, job, design.placements, design.appliedTextStyles),
        deps,
      );
      report.stages.push(refreshed);
      if (!refreshed.ok) {
        human(`DesignCraft failed after the PPI correction: ${refreshed.failure?.message}`);
        return report;
      }
      design = refreshed.output!;
      issues = preflightFromDesign(design.ppiUses, design.placements, job.preflightMinPpi);
      report.stages.push({
        stage: "preflight",
        ok: issues.length === 0,
        output: issues,
        failure: issues.length
          ? { kind: "human_required", message: `still below ${job.preflightMinPpi} PPI after one correction`, retryable: false }
          : null,
        attempts: 2,
        elapsedMs: 0,
      });
      if (issues.length > 0) {
        human(`PPI still below ${job.preflightMinPpi} after one correction: ${issues.map((issue) => issue.message).join("; ")}`);
        return report;
      }
    }

    // ---- Export from DesignCraft, open in PdfCraft ------------------------
    const exportPath = path.join(job.workspace, "export", `${job.jobId}.pdf`);
    const exportStage = await withStage(
      "designcraft",
      () => deps.design.execute("file.exportPdf", { path: exportPath }),
      deps,
    );
    report.stages.push(exportStage);
    if (!exportStage.ok) {
      human(`DesignCraft PDF export failed: ${exportStage.failure?.message}`);
      return report;
    }

    const pdfStage = await withStage(
      "pdfcraft",
      () => openAndRenderPdf(deps.pdf, exportPath, design.pages.map((page) => page.page)),
      deps,
    );
    report.stages.push(pdfStage);
    if (!pdfStage.ok) {
      human(`PdfCraft failed: ${pdfStage.failure?.message}`);
      return report;
    }
    const pdf = pdfStage.output!;

    const pdfIssues = preflightFromPdf(pdf.pageImages, job.preflightMinPpi);
    report.stages.push({
      stage: "preflight",
      ok: pdfIssues.length === 0,
      output: pdfIssues,
      failure: pdfIssues.length
        ? { kind: "retryable_with_correction", message: `${pdfIssues.length} PDF images below ${job.preflightMinPpi} PPI`, retryable: true }
        : null,
      attempts: 1,
      elapsedMs: 0,
    });
    if (pdfIssues.length > 0) {
      human(`PDF preflight failed: ${pdfIssues.map((issue) => issue.message).join("; ")}`);
      return report;
    }

    // ---- Global vision audit on the PDF rasters --------------------------
    for (let index = 0; index < design.pages.length; index += 1) {
      const page = design.pages[index];
      const raster = pdf.pageRasters.find((entry) => entry.page === page.page);
      if (!raster) continue;
      const placements = design.placements
        .filter((placement) => placement.page === page.page)
        .map((placement) => ({ sku: placement.sku, frameId: placement.frameId, bounds: placement.bounds }));
      const auditStage = await withStage(
        "vision_global",
        () =>
          deps.vision.global.audit(raster.png, {
            spreadIndex: index,
            page: page.page,
            gutterRectPt: gutterRect(page),
            placements,
            pageWidthPt: page.width,
            pageHeightPt: page.height,
          }),
        deps,
      );
      report.stages.push(auditStage);
      if (!auditStage.ok) {
        human(`Global vision failed on page ${page.page + 1}: ${auditStage.failure?.message}`);
        continue;
      }
      const audit = auditStage.output!;
      report.globalAudit.push(audit);

      if (audit.traceableFindings.length > 0) {
        for (const finding of audit.traceableFindings) {
          human(`Page ${page.page + 1} traces to ${finding.sku}: ${finding.note}`);
        }
        await restoreFromCopy(snapshot, job);
        return report;
      }
      if (audit.imageGutterSpill.length > 0) {
        human(`Page ${page.page + 1}: ${audit.imageGutterSpill.length} image(s) spill into the gutter.`);
      }
    }

    if (report.humanRequired) {
      return report;
    }

    // ---- Save the final PDF ----------------------------------------------
    const saveStage = await withStage(
      "pdfcraft",
      () => deps.pdf.tool("doc_save", { doc: pdf.docId, path: job.outputPdfPath }),
      deps,
    );
    report.stages.push(saveStage);
    if (!saveStage.ok) {
      human(`PdfCraft save failed: ${saveStage.failure?.message}`);
      return report;
    }
    report.finalPdfWritten = existsSync(job.outputPdfPath);

    const stats = cache.stats();
    report.localAuditCacheHits = stats.hits;
    report.localAuditCacheMisses = stats.misses;
    return report;
  } finally {
    const stats = cache.stats();
    report.localAuditCacheHits = stats.hits;
    report.localAuditCacheMisses = stats.misses;
  }
}
