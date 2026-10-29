// spread-audit.ts
// ---------------------------------------------------------------------------
// DesignCraft editorial spread audit.
//
// The engine gives us the page items and the story text; it does not expose
// line boxes, so this module measures them from `render_page` itself: each
// column strip is scanned row by row, ink bands become line boxes, and the
// right edge of each band gives the fill ratio. The geometric heuristics
// (widow, orphan, ragged) run on those boxes; the vision model only confirms
// or rejects the pre-filtered candidates and explains why.
//
// Corrections are paragraph-level commands. DesignCraft's undo is one command
// per step, so the wrapper counts commands and reverts them one by one.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OpenAI } from "openai";
import { PNG } from "pngjs";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

export type CandidateKind = "widow" | "orphan" | "ragged";

export interface LayoutCandidate {
  id: string;
  kind: CandidateKind;
  spread: number;
  frameId: number;
  storyId: number;
  lineIndices: number[];
  paragraphIndex: number;
  fillRatio: number;
  boundsPt: [number, number, number, number];
  cropRect: [number, number, number, number];
}

export interface SpreadMeasurement {
  spread: number;
  columns: number;
  columnMeasurePt: number;
  perColumnFillRatio: number[];
  fillRatioVariance: number;
  candidates: LayoutCandidate[];
}

export type WrapStrategy =
  | "none"
  | "increase_tracking"
  | "decrease_tracking"
  | "hyphenate_on"
  | "loosen_letter_spacing"
  | "rebalance_columns"
  | "reorder_paragraphs";

export interface CandidateVerdict {
  candidateId: string;
  verdict: "confirmed" | "rejected" | "uncertain";
  note: string;
  proposed_wrap_strategy: WrapStrategy;
  confidence: number;
}

export interface WrapTranslationContext {
  frameId: number;
  paragraphIndex: number;
  currentTracking: number;
  currentWordSpacing: number;
  currentHyphenate: boolean;
  minTracking: number;
  maxTracking: number;
  minWordSpacing: number;
  maxWordSpacing: number;
}

export interface WrapProposal {
  commands: { id: string; params: Record<string, unknown> }[];
  attributeChanged: "tracking" | "wordSpacing" | "hyphenate" | "columns";
  estimatedFillRatioDelta: number;
  undoDepth: number;
}

export interface MeasuredLine {
  column: number;
  columnLineIndex: number;
  paragraphIndex: number;
  paragraphLineIndex: number;
  paragraphLines: number;
  boundsPt: [number, number, number, number];
  fillRatio: number;
}

export interface SpreadPass {
  pass: number;
  fillRatioVariance: number;
  perColumn: number[];
}

export interface CandidateRecord {
  candidate: LayoutCandidate;
  verdict: CandidateVerdict;
  appliedCommands: { id: string; params: Record<string, unknown> }[];
}

export interface SpreadManifest {
  spread: number;
  passes: SpreadPass[];
  candidates: CandidateRecord[];
  appliedCommands: { id: string; params: Record<string, unknown> }[];
  undoBudgetAvailable: number;
  rollback: string | null;
}

export interface AuditConfig {
  spread: number;
  page: number;
  /** Pixels per point for the spread raster and the line measurement. */
  scale: number;
  /** Column count and gutter come from document setup; margins from inspect. */
  columns: number;
  gutterPt: number;
  /** Widow threshold: final line shorter than this fraction of the measure. */
  widowFillRatio: number;
  /** Ragged threshold: spread of the last three right edges. */
  raggedVariance: number;
  minParagraphLines: number;
  maxCrops: number;
  maxPasses: number;
  /** Input-token ceiling for the vision request. */
  tokenBudget: number;
}

export interface VisionInput {
  candidates: { id: string; kind: CandidateKind; fillRatio: number; paragraphLines: number }[];
  crops: { candidateId: string; pngBase64: string }[];
}

export type SpreadVisionFn = (input: VisionInput) => Promise<CandidateVerdict[]>;

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string; data?: string }[];
}

interface InspectItem {
  id: number;
  kind: string;
  bounds: [number, number, number, number];
  story?: number;
  columns?: number;
  hidden?: boolean;
}

interface InspectDocument {
  spreads: { index: number; items: InspectItem[]; pages: { bounds: number[]; columns: number }[] }[];
  stories: { id: number; frames: number[]; length: number; lines: number; paragraphs: number; overset: boolean | number }[];
}

export class DesignSession {
  private readonly client = new Client({ name: "spread-audit", version: "0.1.0" }, { capabilities: {} });

  async connect(): Promise<void> {
    await this.client.connect(new StdioClientTransport({ command: "designcraft-cli", args: ["mcp"] }));
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async text(name: string, args: Record<string, unknown>): Promise<string> {
    const res = (await this.client.callTool({ name, arguments: args })) as ToolResult;
    if (res.isError) {
      const block = res.content.find((b) => b.type === "text");
      throw new Error(`${name}: ${block?.text ?? "unknown error"}`);
    }
    const block = res.content.find((b) => b.type === "text");
    return block?.text ?? "";
  }

  async json<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
    return JSON.parse(await this.text(name, args)) as T;
  }

  async inspect(): Promise<InspectDocument> {
    return this.json("inspect_document");
  }

  async story(storyId: number): Promise<{ text: string; paragraphs: number; overset: boolean | number }> {
    return this.json("get_story", { story: storyId });
  }

  async execute(command: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.json("execute", { command, params });
  }

  async batch(commands: { command: string; params?: Record<string, unknown> }[]): Promise<unknown> {
    return this.json("batch", { commands });
  }

  async undo(times = 1): Promise<void> {
    for (let i = 0; i < times; i++) await this.execute("edit.undo");
  }

  async render(page: number, scale: number): Promise<string> {
    const res = (await this.client.callTool({
      name: "render_page",
      arguments: { page, scale },
    })) as ToolResult;
    const image = res.content.find((b) => b.type === "image");
    if (!image || typeof image.data !== "string") throw new Error("render_page returned no image");
    return image.data;
  }
}

// ---------------------------------------------------------------------------
// Line measurement from the print-accurate raster
// ---------------------------------------------------------------------------

export interface FrameLayout {
  frameId: number;
  storyId: number;
  bounds: [number, number, number, number];
  columns: number;
  gutterPt: number;
}

export function columnStrips(frame: FrameLayout): { x0: number; x1: number; measure: number }[] {
  const [x0, , x1] = frame.bounds;
  const inner = x1 - x0 - frame.gutterPt * (frame.columns - 1);
  const measure = inner / frame.columns;
  return Array.from({ length: frame.columns }, (_, i) => {
    const left = x0 + i * (measure + frame.gutterPt);
    return { x0: left, x1: left + measure, measure };
  });
}

interface Band {
  top: number;
  bottom: number;
  right: number;
}

/**
 * Row-profile line finder. A row is "inked" when more than 1 % of the column
 * width is darker than mid-grey; runs shorter than 4 px are antialias noise.
 */
export function findBands(
  png: PNG,
  strip: { x0: number; x1: number },
  y0: number,
  y1: number,
): Band[] {
  const left = Math.max(0, Math.round(strip.x0));
  const right = Math.min(png.width, Math.round(strip.x1));
  const top = Math.max(0, Math.round(y0));
  const bottom = Math.min(png.height, Math.round(y1));
  if (right <= left || bottom <= top) return [];

  const ink = new Array<number>(bottom - top).fill(0);
  const rightEdge = new Array<number>(bottom - top).fill(-1);
  for (let y = top; y < bottom; y++) {
    for (let x = left; x < right; x++) {
      const i = (y * png.width + x) * 4;
      const luma = 0.2126 * png.data[i] + 0.7152 * png.data[i + 1] + 0.0722 * png.data[i + 2];
      if (luma < 160) {
        ink[y - top]++;
        rightEdge[y - top] = Math.max(rightEdge[y - top], x);
      }
    }
  }

  const threshold = Math.max(2, Math.floor((right - left) * 0.01));
  const runs: [number, number][] = [];
  for (let i = 0; i < ink.length; ) {
    if (ink[i] <= threshold) {
      i++;
      continue;
    }
    let j = i;
    while (j < ink.length && ink[j] > threshold) j++;
    if (j - i >= 4) runs.push([i, j - 1]);
    i = j;
  }

  const bands: Band[] = [];
  for (const [start, end] of runs) {
    const last = bands[bands.length - 1];
    if (last && start + top - last.bottom <= 3) {
      last.bottom = end + top;
      last.right = Math.max(last.right, ...rightEdge.slice(start, end + 1));
    } else {
      bands.push({
        top: start + top,
        bottom: end + top,
        right: Math.max(...rightEdge.slice(start, end + 1)),
      });
    }
  }
  return bands;
}

/**
 * Turns bands into measured lines and assigns paragraph ids in reading order.
 * A column's first line continues the previous paragraph when the previous
 * column ended on a full line; otherwise it starts a new paragraph.
 */
export function measureLines(
  png: PNG,
  frame: FrameLayout,
  scale: number,
  spread: number,
): MeasuredLine[] {
  const strips = columnStrips(frame);
  const lines: MeasuredLine[] = [];
  let paragraphIndex = 0;
  let paragraphLineIndex = 0;
  let started = false;
  let previous: MeasuredLine | undefined;

  for (let column = 0; column < strips.length; column++) {
    const strip = strips[column];
    const bands = findBands(
      png,
      { x0: strip.x0 * scale, x1: strip.x1 * scale },
      frame.bounds[1] * scale,
      frame.bounds[3] * scale,
    );
    const gaps: number[] = [];
    for (let i = 1; i < bands.length; i++) gaps.push(bands[i].top - bands[i - 1].top);
    const sorted = [...gaps].sort((a, b) => a - b);
    const medianGap = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 12 * scale;
    const paragraphGap = Math.max(6 * scale, medianGap * 1.6);

    for (let i = 0; i < bands.length; i++) {
      const band = bands[i];
      const newParagraph = !started
        ? true
        : i === 0
          ? !(previous !== undefined && previous.column < column && previous.fillRatio > 0.8)
          : band.top - bands[i - 1].top > paragraphGap;

      if (newParagraph) {
        if (started) paragraphIndex++;
        paragraphLineIndex = 0;
        started = true;
      }

      const line: MeasuredLine = {
        column,
        columnLineIndex: i,
        paragraphIndex,
        paragraphLineIndex,
        paragraphLines: 0,
        boundsPt: [
          strip.x0,
          band.top / scale,
          strip.x0 + strip.measure,
          band.bottom / scale,
        ],
        fillRatio: Math.max(0, Math.min(1, (band.right / scale - strip.x0) / strip.measure)),
      };
      paragraphLineIndex++;
      previous = line;
      lines.push(line);
    }
  }

  const counts = new Map<number, number>();
  for (const line of lines) counts.set(line.paragraphIndex, (counts.get(line.paragraphIndex) ?? 0) + 1);
  for (const line of lines) line.paragraphLines = counts.get(line.paragraphIndex) ?? 1;
  void spread;
  return lines;
}

export function fillRatioVariance(ratios: number[]): number {
  if (!ratios.length) return 0;
  const mean = ratios.reduce((a, b) => a + b, 0) / ratios.length;
  return ratios.reduce((a, b) => a + (b - mean) * (b - mean), 0) / ratios.length;
}

/**
 * The raster cannot always tell a paragraph break from a column break, so the
 * measured blocks are reconciled with the number of visible paragraphs in the
 * story: the smallest block merges into its predecessor until the counts match.
 * Reading order is preserved, so paragraph n still indexes the nth non-empty
 * paragraph of the story.
 */
export function reconcileParagraphs(lines: MeasuredLine[], target: number): MeasuredLine[] {
  if (target <= 0 || lines.length === 0) return lines;

  const groups = (): MeasuredLine[][] => {
    const out: MeasuredLine[][] = [];
    for (const line of lines) {
      const last = out[out.length - 1];
      if (last && last[0].paragraphIndex === line.paragraphIndex) last.push(line);
      else out.push([line]);
    }
    return out;
  };

  let blocks = groups();
  while (blocks.length > target) {
    let smallest = 1;
    for (let i = 2; i < blocks.length; i++) {
      if (blocks[i].length < blocks[smallest].length) smallest = i;
    }
    const [merged] = blocks.splice(smallest, 1);
    blocks[smallest - 1] = [...blocks[smallest - 1], ...merged];
  }

  const flat: MeasuredLine[] = [];
  blocks.forEach((block, paragraphIndex) => {
    block.forEach((line, paragraphLineIndex) => {
      line.paragraphIndex = paragraphIndex;
      line.paragraphLineIndex = paragraphLineIndex;
      line.paragraphLines = block.length;
      flat.push(line);
    });
  });
  return flat;
}

// ---------------------------------------------------------------------------
// Heuristics
// ---------------------------------------------------------------------------

interface DetectOptions {
  widowFillRatio: number;
  raggedVariance: number;
  minParagraphLines: number;
  columnCount: number;
  measurePt: number;
  scale: number;
  spread: number;
  frameId: number;
  storyId: number;
  page: { width: number; height: number };
}

function crop(
  bounds: [number, number, number, number],
  scale: number,
  page: { width: number; height: number },
): [number, number, number, number] {
  const [x0, y0, x1, y1] = bounds;
  const width = 600;
  const height = 160;
  const cx = ((x0 + x1) / 2) * scale;
  const cy = ((y0 + y1) / 2) * scale;
  const left = Math.max(0, Math.min(page.width * scale - width, Math.round(cx - width / 2)));
  const top = Math.max(0, Math.min(page.height * scale - height, Math.round(cy - height / 2)));
  return [left, top, left + width, top + height];
}

export function detectCandidates(lines: MeasuredLine[], opts: DetectOptions): LayoutCandidate[] {
  const candidates: LayoutCandidate[] = [];
  const seen = new Map<string, number>();
  const nextId = (column: number, kind: CandidateKind): string => {
    const key = `${column}-${kind}`;
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    return `c${column + 1}-${kind[0]}${String(n).padStart(2, "0")}`;
  };

  const make = (kind: CandidateKind, line: MeasuredLine, indices: number[]): LayoutCandidate => ({
    id: nextId(line.column, kind),
    kind,
    spread: opts.spread,
    frameId: opts.frameId,
    storyId: opts.storyId,
    lineIndices: indices,
    paragraphIndex: line.paragraphIndex,
    fillRatio: Math.round(line.fillRatio * 1000) / 1000,
    boundsPt: line.boundsPt,
    cropRect: crop(line.boundsPt, opts.scale, opts.page),
  });

  const columnLines = new Map<number, MeasuredLine[]>();
  for (const line of lines) {
    const list = columnLines.get(line.column) ?? [];
    list.push(line);
    columnLines.set(line.column, list);
  }

  for (const line of lines) {
    const isParagraphEnd = line.paragraphLineIndex === line.paragraphLines - 1;
    const isParagraphStart = line.paragraphLineIndex === 0;

    // Widow: single short word closing a paragraph of four lines or more.
    if (isParagraphEnd && line.paragraphLines >= opts.minParagraphLines && line.fillRatio < opts.widowFillRatio) {
      candidates.push(make("widow", line, [line.columnLineIndex]));
    }

    // Orphan: the paragraph's first line is the last line of its column and
    // the paragraph continues in the next one.
    if (isParagraphStart && line.paragraphLines > 1) {
      const list = columnLines.get(line.column) ?? [];
      if (list[list.length - 1] === line && line.column < opts.columnCount - 1) {
        candidates.push(make("orphan", line, [line.columnLineIndex]));
      }
    }
  }

  // Ragged: the last three right edges of a column spread more than 12 % of
  // the measure.
  for (const [column, list] of columnLines) {
    if (list.length < 3) continue;
    const lastThree = list.slice(-3);
    const ratios = lastThree.map((l) => l.fillRatio);
    const spread = Math.max(...ratios) - Math.min(...ratios);
    if (spread > opts.raggedVariance) {
      candidates.push(make("ragged", lastThree[2], lastThree.map((l) => l.columnLineIndex)));
    }
  }

  return candidates;
}

// ---------------------------------------------------------------------------
// Vision verifier
// ---------------------------------------------------------------------------

export const VerdictSchema = z.object({
  candidateId: z.string(),
  verdict: z.enum(["confirmed", "rejected", "uncertain"]),
  note: z.string().max(240),
  proposed_wrap_strategy: z.enum([
    "none",
    "increase_tracking",
    "decrease_tracking",
    "hyphenate_on",
    "loosen_letter_spacing",
    "rebalance_columns",
    "reorder_paragraphs",
  ]),
  confidence: z.number().min(0).max(1),
});

const VerdictArraySchema = z.array(VerdictSchema);

const SYSTEM_PROMPT = `You are a typographic pre-flight editor.
Each crop shows a region of a magazine spread around a line that a geometric
heuristic already flagged. You do not search the page: confirm or reject the
specific candidate. A widow is a single short word ending a paragraph of four
or more lines. An orphan is the first line of a paragraph stranded at the
bottom of a column. A ragged column has last lines whose right edges swing by
more than 12 % of the measure.
Return a JSON array with one object per candidate, in the same order:
{candidateId, verdict: "confirmed"|"rejected"|"uncertain", note, proposed_wrap_strategy, confidence}.
Allowed strategies: none, increase_tracking, decrease_tracking, hyphenate_on,
loosen_letter_spacing, rebalance_columns, reorder_paragraphs.`;

/** Lazy client so the module imports without an API key. */
export function createOpenAiVerifier(model = process.env.OPENAI_VISION_MODEL ?? "gpt-4.1-mini"): SpreadVisionFn {
  let client: OpenAI | undefined;
  return async ({ candidates, crops }) => {
    client ??= new OpenAI();
    const blocks: unknown[] = [
      {
        type: "text",
        text: "Candidates:\n" + JSON.stringify(candidates),
      },
      ...crops.map((c) => ({
        type: "image_url",
        image_url: { url: `data:image/png;base64,${c.pngBase64}`, detail: "high" },
      })),
    ];
    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: blocks as never },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? "[]";
    const parsed = VerdictArraySchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error(`verdicts failed validation: ${parsed.error.message}`);
    return parsed.data;
  };
}

// ---------------------------------------------------------------------------
// Translation layer
// ---------------------------------------------------------------------------

const TRACKING_STEP = 20; // thousandths of an em

export function proposeWrap(
  verdict: CandidateVerdict,
  ctx: WrapTranslationContext,
  frameId: number,
): WrapProposal | null {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

  switch (verdict.proposed_wrap_strategy) {
    case "increase_tracking": {
      const next = clamp(ctx.currentTracking + TRACKING_STEP, ctx.minTracking, ctx.maxTracking);
      if (next === ctx.currentTracking) return null;
      return {
        commands: [{ id: "type.char", params: { attrs: { tracking: next } } }],
        attributeChanged: "tracking",
        estimatedFillRatioDelta: 0.04,
        undoDepth: 1,
      };
    }
    case "decrease_tracking": {
      const next = clamp(ctx.currentTracking - TRACKING_STEP, ctx.minTracking, ctx.maxTracking);
      if (next === ctx.currentTracking) return null;
      return {
        commands: [{ id: "type.char", params: { attrs: { tracking: next } } }],
        attributeChanged: "tracking",
        estimatedFillRatioDelta: -0.03,
        undoDepth: 1,
      };
    }
    case "loosen_letter_spacing": {
      const next = clamp(ctx.currentTracking + 5, ctx.minTracking, ctx.maxTracking);
      if (next === ctx.currentTracking) return null;
      return {
        commands: [{ id: "type.char", params: { attrs: { tracking: next } } }],
        attributeChanged: "tracking",
        estimatedFillRatioDelta: 0.01,
        undoDepth: 1,
      };
    }
    case "hyphenate_on":
      if (ctx.currentHyphenate) return null;
      return {
        commands: [{ id: "type.para", params: { attrs: { hyphenate: true } } }],
        attributeChanged: "hyphenate",
        estimatedFillRatioDelta: 0.06,
        undoDepth: 1,
      };
    case "rebalance_columns":
      return {
        commands: [
          { id: "object.textFrameOptions", params: { ids: [frameId], balanceColumns: true } },
        ],
        attributeChanged: "columns",
        estimatedFillRatioDelta: 0.05,
        undoDepth: 1,
      };
    case "none":
    case "reorder_paragraphs":
      return null;
  }
}

// ---------------------------------------------------------------------------
// Measurement pass
// ---------------------------------------------------------------------------

export async function measureSpread(
  session: DesignSession,
  config: AuditConfig,
): Promise<{ measurement: SpreadMeasurement; raster: string; frame: FrameLayout; lines: MeasuredLine[] }> {
  const inspect = await session.inspect();
  const spread = inspect.spreads[config.spread];
  if (!spread) throw new Error(`spread ${config.spread} not found`);
  const frameItem = spread.items.find((item) => item.story !== undefined && !item.hidden);
  if (!frameItem || frameItem.story === undefined) throw new Error("spread has no text frame");

  const frame: FrameLayout = {
    frameId: frameItem.id,
    storyId: frameItem.story,
    bounds: frameItem.bounds,
    columns: frameItem.columns ?? config.columns,
    gutterPt: config.gutterPt,
  };

  const raster = await session.render(config.page, config.scale);
  const png = PNG.sync.read(Buffer.from(raster, "base64"));
  const story = await session.story(frame.storyId);
  const lines = reconcileParagraphs(
    measureLines(png, frame, config.scale, config.spread),
    paragraphRanges(story.text).length,
  );
  const strips = columnStrips(frame);

  const page = spread.pages[0];
  const pageBox = { width: page?.bounds[2] ?? png.width / config.scale, height: page?.bounds[3] ?? png.height / config.scale };

  // Per-column fill is the mean right-edge fill of the column's lines: a
  // column of tight lines scores near 1, a ragged column scores lower.
  const perColumn = strips.map((_, ci) => {
    const columnLines = lines.filter((l) => l.column === ci);
    if (!columnLines.length) return 0;
    return columnLines.reduce((sum, l) => sum + l.fillRatio, 0) / columnLines.length;
  });

  const candidates = detectCandidates(lines, {
    widowFillRatio: config.widowFillRatio,
    raggedVariance: config.raggedVariance,
    minParagraphLines: config.minParagraphLines,
    columnCount: strips.length,
    measurePt: strips[0]?.measure ?? 0,
    scale: config.scale,
    spread: config.spread,
    frameId: frame.frameId,
    storyId: frame.storyId,
    page: pageBox,
  });

  return {
    measurement: {
      spread: config.spread,
      columns: strips.length,
      columnMeasurePt: Math.round((strips[0]?.measure ?? 0) * 100) / 100,
      perColumnFillRatio: perColumn.map((v) => Math.round(v * 1000) / 1000),
      fillRatioVariance: Math.round(fillRatioVariance(perColumn) * 1e6) / 1e6,
      candidates,
    },
    raster,
    frame,
    lines,
  };
}

function cropPng(raster: string, rect: [number, number, number, number]): string {
  const source = PNG.sync.read(Buffer.from(raster, "base64"));
  const [x0, y0, x1, y1] = rect;
  const width = Math.max(1, Math.min(source.width - x0, x1 - x0));
  const height = Math.max(1, Math.min(source.height - y0, y1 - y0));
  const out = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = ((y0 + y) * source.width + (x0 + x)) * 4;
      const dst = (y * width + x) * 4;
      out.data[dst] = source.data[src];
      out.data[dst + 1] = source.data[src + 1];
      out.data[dst + 2] = source.data[src + 2];
      out.data[dst + 3] = source.data[src + 3];
    }
  }
  return PNG.sync.write(out).toString("base64");
}

// ---------------------------------------------------------------------------
// Paragraph byte ranges
// ---------------------------------------------------------------------------

export function paragraphRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let offset = 0;
  for (const part of text.split("\n")) {
    const bytes = Buffer.byteLength(part, "utf8");
    if (part.trim()) ranges.push([offset, offset + bytes]);
    offset += bytes + 1;
  }
  return ranges;
}

async function readContext(
  session: DesignSession,
  storyId: number,
  range: [number, number],
  frameId: number,
  paragraphIndex: number,
): Promise<WrapTranslationContext> {
  await session.execute("text.select", { story: storyId, anchor: range[0], focus: range[1] });
  const attrs = await session.json<{ chars?: Record<string, unknown>; para?: Record<string, unknown> }>(
    "execute",
    { command: "type.selectionAttrs", params: {} },
  );
  const chars = attrs.chars ?? {};
  return {
    frameId,
    paragraphIndex,
    currentTracking: Number(chars.tracking ?? 0),
    currentWordSpacing: Number(chars.wordSpacing ?? 0),
    currentHyphenate: Boolean(attrs.para?.hyphenate ?? false),
    minTracking: -50,
    maxTracking: 200,
    minWordSpacing: -20,
    maxWordSpacing: 20,
  };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function auditSpread(
  session: DesignSession,
  config: AuditConfig,
  vision: SpreadVisionFn,
  meta: { jobId?: string } = {},
): Promise<{ manifest: SpreadManifest; measurement: SpreadMeasurement; raster: string }> {
  const first = await measureSpread(session, config);
  const story = await session.story(first.frame.storyId);
  const ranges = paragraphRanges(story.text);

  const verified = first.measurement.candidates.slice(0, config.maxCrops);
  const overflow = first.measurement.candidates.slice(config.maxCrops);

  const crops = verified.map((candidate) => ({
    candidateId: candidate.id,
    pngBase64: cropPng(first.raster, candidate.cropRect),
  }));

  const payload: VisionInput = {
    candidates: verified.map((c) => ({
      id: c.id,
      kind: c.kind,
      fillRatio: c.fillRatio,
      paragraphLines: first.lines.find((l) => l.paragraphIndex === c.paragraphIndex)?.paragraphLines ?? 1,
    })),
    crops,
  };

  // Images are priced per tile, not per base64 character. Only the text
  // payload counts against the per-spread budget; each crop is ~200 tokens.
  const tokens = Math.ceil(JSON.stringify(payload.candidates).length / 4) + crops.length * 200;
  if (tokens > config.tokenBudget) {
    throw new Error(`vision payload is ${tokens} tokens, over the ${config.tokenBudget} budget`);
  }

  const verdicts = verified.length ? await vision(payload) : [];
  const byCandidate = new Map(verdicts.map((v) => [v.candidateId, v]));
  for (const candidate of verified) {
    if (!byCandidate.has(candidate.id)) {
      throw new Error(`vision returned no verdict for ${candidate.id}`);
    }
  }

  const records: CandidateRecord[] = [
    ...verified.map((candidate) => ({
      candidate,
      verdict: byCandidate.get(candidate.id)!,
      appliedCommands: [],
    })),
    ...overflow.map((candidate) => ({
      candidate,
      verdict: {
        candidateId: candidate.id,
        verdict: "uncertain" as const,
        note: "not verified: crop budget reached",
        proposed_wrap_strategy: "none" as const,
        confidence: 0,
      },
      appliedCommands: [],
    })),
  ];

  const appliedCommands: { id: string; params: Record<string, unknown> }[] = [];
  const passes: SpreadPass[] = [
    {
      pass: 0,
      fillRatioVariance: first.measurement.fillRatioVariance,
      perColumn: first.measurement.perColumnFillRatio,
    },
  ];
  let last = first.measurement;
  let rollback: string | null = null;

  for (let pass = 0; pass < config.maxPasses; pass++) {
    const wanted = pass === 0 ? "confirmed" : "uncertain";
    const eligible = records.filter((r) => r.verdict.verdict === wanted && !r.appliedCommands.length);
    if (!eligible.length) break;

    let appliedThisPass = 0;
    for (const record of eligible) {
      const range = ranges[record.candidate.paragraphIndex];
      if (!range) continue;
      const ctx = await readContext(
        session,
        first.frame.storyId,
        range,
        first.frame.frameId,
        record.candidate.paragraphIndex,
      );
      const proposal = proposeWrap(record.verdict, ctx, first.frame.frameId);
      if (!proposal) continue;

      if (proposal.attributeChanged !== "columns") {
        await session.execute("text.select", {
          story: first.frame.storyId,
          anchor: range[0],
          focus: range[1],
        });
      }
      for (const command of proposal.commands) {
        await session.execute(command.id, command.params);
        appliedCommands.push(command);
        record.appliedCommands.push(command);
        appliedThisPass++;
      }
    }

    if (!appliedThisPass) break;

    const next = await measureSpread(session, config);
    passes.push({
      pass: passes.length,
      fillRatioVariance: next.measurement.fillRatioVariance,
      perColumn: next.measurement.perColumnFillRatio,
    });

    if (pass === 0 && next.measurement.fillRatioVariance > first.measurement.fillRatioVariance) {
      // DesignCraft's edit.undo is one command per step: revert exactly what
      // pass 1 applied, newest first.
      await session.undo(appliedCommands.length);
      rollback =
        `pass 1 raised fill-ratio variance from ${first.measurement.fillRatioVariance} ` +
        `to ${next.measurement.fillRatioVariance}; reverted ${appliedCommands.length} commands`;
      appliedCommands.length = 0;
      for (const record of records) record.appliedCommands = [];
      last = first.measurement;
      break;
    }
    last = next.measurement;
  }

  const manifest: SpreadManifest = {
    spread: config.spread,
    passes,
    candidates: records,
    appliedCommands,
    undoBudgetAvailable: appliedCommands.length,
    rollback,
  };
  void meta;
  return { manifest, measurement: last, raster: first.raster };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [file, configPath] = process.argv.slice(2);
  if (!file || !configPath) {
    console.error("usage: tsx 02_spread-audit.ts <file.designcraft> <config.json>");
    process.exit(1);
  }
  const { readFile, writeFile } = await import("node:fs/promises");
  const session = new DesignSession();
  await session.connect();
  try {
    await session.execute("file.open", { path: file });
    const config = JSON.parse(await readFile(configPath, "utf8")) as AuditConfig;
    const { manifest } = await auditSpread(session, config, createOpenAiVerifier(), {
      jobId: randomUUID(),
    });
    await writeFile("spread_manifest.json", JSON.stringify(manifest, null, 2));
    console.log(JSON.stringify({ candidates: manifest.candidates.length, applied: manifest.appliedCommands.length, rollback: manifest.rollback }, null, 2));
  } finally {
    await session.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}


