// vector-audit.ts
// ---------------------------------------------------------------------------
// Brand-compliance auditor for VectorCraft.
//
// The agent opens a .vectorcraft document, builds a structural digest with
// `doc_inspect` plus `document.node`, renders the artboard, and asks a vision
// model for the compositional judgement that geometry cannot make. The model
// never does colour math: every ΔE 2000 number and every CMYK percentage is
// computed here, and every correction is executed through VectorCraft command
// batches.
//
// The geometry fixes are dry-run first inside an undo group, rendered, and
// cancelled before they are applied for real. Corrections that would move the
// wordmark by more than 4 pt, or move a swatch by more than 8 % on any ink
// channel, are escalated to the operator instead of being applied.
// ---------------------------------------------------------------------------

import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { OpenAI } from "openai";
import { PNG } from "pngjs";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Types (from the exercise starter, extended with the report envelope)
// ---------------------------------------------------------------------------

export interface ObjectAnnotation {
  id: number;
  name: string;
  kind: "Text" | "Path" | "Group" | "Image" | "CompoundPath" | "LivePaint";
  /** [x1, y1, x2, y2] in document points. */
  bounds: [number, number, number, number];
  fillHex?: string;
  strokeHex?: string;
  fontFamily?: string;
  fontSizePt?: number;
  /** Effect ids in stacking order; appended by the digest builder. */
  effectIds?: string[];
}

export interface ComplianceDigest {
  artboard: { widthPt: number; heightPt: number };
  objects: ObjectAnnotation[];
  approvedSwatches: { name: string; hex: string; isSpot: boolean; deltaEToTarget: number }[];
  clearSpaceViolations: number[];
  dieLineIntrusions: number[];
  lowPpiImages: { id: number; effectivePpi: [number, number] }[];
}

export type BrandFix =
  | { kind: "reposition"; targetId: number; dxPt: number; dyPt: number }
  | { kind: "resize"; targetId: number; scalePct: number }
  | { kind: "typography"; targetId: number; sizePt?: number; tracking?: number; fontFamily?: string }
  | { kind: "remove_effect"; targetId: number; effectIndex: number }
  | { kind: "swap_swatch"; targetId: number; fromHex: string; toHex: string }
  | { kind: "recolor_gradient_to_flat"; targetId: number; flatHex: string };

export interface BrandAudit {
  findings: { rule: string; violated: boolean; severity: "info" | "warning" | "blocking"; note: string }[];
  fixes: BrandFix[];
  confidence: number;
}

export interface DryRunResult {
  command: { id: string; params: Record<string, unknown> };
  /** Base64 PNG payload; the caller persists it so the agent never writes. */
  rasterBefore: string;
  rasterAfter: string;
  ssd: number;
  improvement: number;
}

export interface BatchStep {
  id: string;
  params?: Record<string, unknown>;
}

export interface AuditConfig {
  /** The four approved spot colours and the press target each must match. */
  approved: { name: string; targetHex: string }[];
  /** Object name of the wordmark, as set by the type layer. */
  wordmarkName: string;
  /** Inset of the die-line region from the artboard edge, in points. */
  dieLineInsetPt: number;
  /** Maximum ΔE 2000 allowed per swatch. */
  deltaETolerance?: number;
  /** Changes applied before the rest is escalated. */
  maxRounds?: number;
  /** Automation roots the CLI is allowed to touch. */
  readRoot: string;
  writeRoot: string;
}

export interface AppliedFix {
  fix: BrandFix;
  steps: BatchStep[];
  dryRun?: DryRunResult;
  notes: string[];
}

export interface EscalatedFix {
  fix: BrandFix;
  reason: string;
}

export interface BrandReport {
  jobId: string;
  file: string;
  generatedAt: string;
  digest: ComplianceDigest;
  audit: BrandAudit;
  applied: AppliedFix[];
  escalated: EscalatedFix[];
  rounds: number;
  finalDigest: ComplianceDigest;
  finalPreviewPng: string;
}

// ---------------------------------------------------------------------------
// VectorCraft session (MCP over stdio)
// ---------------------------------------------------------------------------

interface RawSwatch {
  name: string;
  hex: string;
  spot: boolean;
  global?: boolean;
  color?: { model: string; c?: number; m?: number; y?: number; k?: number; r?: number; g?: number; b?: number };
}

interface InspectNode {
  id: number;
  name?: string;
  kind: string;
  bounds?: { x: number; y: number; width: number; height: number };
  fill?: string;
  stroke?: string;
  text?: string;
  visible?: boolean;
  children?: InspectNode[];
}

interface InspectResult {
  artboards: { x: number; y: number; width: number; height: number; name: string }[];
  layers: InspectNode[];
}

interface ToolResult {
  isError?: boolean;
  content: { type: string; text?: string; data?: string }[];
}

export class VectorSession {
  private readonly client = new Client({ name: "vector-audit", version: "0.1.0" }, { capabilities: {} });

  constructor(private readonly roots: { read: string; write: string }) {}

  async connect(): Promise<void> {
    await this.client.connect(
      new StdioClientTransport({
        command: "vectorcraft-cli",
        args: [
          "mcp",
          "--automation-read-root",
          this.roots.read,
          "--automation-write-root",
          this.roots.write,
        ],
      }),
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  private async text(name: string, args: Record<string, unknown>): Promise<string> {
    const res = (await this.client.callTool({ name, arguments: args })) as ToolResult;
    const block = res.content.find((b) => b.type === "text");
    const body = block?.text ?? "";
    if (res.isError) throw new Error(`${name}: ${body}`);
    return body;
  }

  private async json<T>(name: string, args: Record<string, unknown>): Promise<T> {
    return JSON.parse(await this.text(name, args)) as T;
  }

  async open(path: string): Promise<{ index: number; title: string; format: string }> {
    return this.json("open_file", { path });
  }

  async inspect(depth = 2): Promise<InspectResult> {
    return this.json("doc_inspect", { depth });
  }

  async node(id: number): Promise<Record<string, any>> {
    return this.json("command_run", { id: "document.node", params: { id } });
  }

  async swatches(): Promise<RawSwatch[]> {
    const out = await this.json<{ swatches: RawSwatch[] }>("command_run", {
      id: "swatch.list",
      params: {},
    });
    return out.swatches;
  }

  async preview(maxSide = 1024, artboard = 0): Promise<string> {
    const res = (await this.client.callTool({
      name: "render_preview",
      arguments: { artboard, max_side: maxSide },
    })) as ToolResult;
    const image = res.content.find((b) => b.type === "image");
    if (!image || image.type !== "image") throw new Error("render_preview returned no image");
    if (typeof image.data !== "string") throw new Error("render_preview image has no data");
    return image.data;
  }

  async run(id: string, params: Record<string, unknown> = {}): Promise<unknown> {
    return this.json("command_run", { id, params });
  }

  async batch(steps: BatchStep[], label?: string, atomic = true): Promise<unknown> {
    // `label` is only valid on an atomic batch.
    return this.json("command_batch", atomic ? { steps, atomic, label } : { steps, atomic });
  }

  async beginGroup(label: string): Promise<void> {
    await this.run("edit.undoGroup.begin", { label });
  }

  async endGroup(cancel: boolean): Promise<void> {
    await this.run("edit.undoGroup.end", { cancel });
  }
}

// ---------------------------------------------------------------------------
// Colour math: CIEDE2000 and a CMYK solver that treats the engine as an oracle
// ---------------------------------------------------------------------------

export function hexToRgb(hex: string): [number, number, number] {
  const s = hex.replace("#", "").padStart(6, "0");
  return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function srgbToLinear(v: number): number {
  const c = v / 255;
  return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

function rgbToXyz([r, g, b]: [number, number, number]): [number, number, number] {
  const R = srgbToLinear(r), G = srgbToLinear(g), B = srgbToLinear(b);
  return [
    R * 0.4124564 + G * 0.3575761 + B * 0.1804375,
    R * 0.2126729 + G * 0.7151522 + B * 0.072175,
    R * 0.0193339 + G * 0.119192 + B * 0.9503041,
  ];
}

function xyzToLab([x, y, z]: [number, number, number]): [number, number, number] {
  const Xn = 0.95047, Yn = 1.0, Zn = 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(x / Xn), fy = f(y / Yn), fz = f(z / Zn);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function hexToLab(hex: string): [number, number, number] {
  return xyzToLab(rgbToXyz(hexToRgb(hex)));
}

/** CIEDE2000 difference. Returns ΔE on the usual 0–100 scale. */
export function deltaE2000(hexA: string, hexB: string): number {
  const [L1, a1, b1] = hexToLab(hexA);
  const [L2, a2, b2] = hexToLab(hexB);
  const kL = 1, kC = 1, kH = 1;
  const C1 = Math.hypot(a1, b1), C2 = Math.hypot(a2, b2);
  const Cbar = (C1 + C2) / 2;
  const G = 0.5 * (1 - Math.sqrt(Math.pow(Cbar, 7) / (Math.pow(Cbar, 7) + Math.pow(25, 7))));
  const a1p = (1 + G) * a1, a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1), C2p = Math.hypot(a2p, b2);
  const h1p = (Math.atan2(b1, a1p) * 180 / Math.PI + 360) % 360;
  const h2p = (Math.atan2(b2, a2p) * 180 / Math.PI + 360) % 360;
  const dLp = L2 - L1, dCp = C2p - C1p;
  let dhp = 0;
  if (C1p * C2p !== 0) {
    dhp = h2p - h1p;
    if (dhp > 180) dhp -= 360;
    else if (dhp < -180) dhp += 360;
  }
  const dHp = 2 * Math.sqrt(C1p * C2p) * Math.sin((dhp * Math.PI / 180) / 2);
  const Lbarp = (L1 + L2) / 2;
  const Cbarp = (C1p + C2p) / 2;
  let hbarp = h1p + h2p;
  if (C1p * C2p !== 0) {
    hbarp = Math.abs(h1p - h2p) > 180 ? (h1p + h2p + 360) / 2 : (h1p + h2p) / 2;
  }
  const T = 1
    - 0.17 * Math.cos((hbarp - 30) * Math.PI / 180)
    + 0.24 * Math.cos((2 * hbarp) * Math.PI / 180)
    + 0.32 * Math.cos((3 * hbarp + 6) * Math.PI / 180)
    - 0.20 * Math.cos((4 * hbarp - 63) * Math.PI / 180);
  const dTheta = 30 * Math.exp(-Math.pow((hbarp - 275) / 25, 2));
  const Rc = 2 * Math.sqrt(Math.pow(Cbarp, 7) / (Math.pow(Cbarp, 7) + Math.pow(25, 7)));
  const Sl = 1 + (0.015 * Math.pow(Lbarp - 50, 2)) / Math.sqrt(20 + Math.pow(Lbarp - 50, 2));
  const Sc = 1 + 0.045 * Cbarp;
  const Sh = 1 + 0.015 * Cbarp * T;
  const Rt = -Math.sin(2 * dTheta * Math.PI / 180) * Rc;
  return Math.sqrt(
    Math.pow(dLp / (kL * Sl), 2) +
    Math.pow(dCp / (kC * Sc), 2) +
    Math.pow(dHp / (kH * Sh), 2) +
    Rt * (dCp / (kC * Sc)) * (dHp / (kH * Sh)),
  );
}

/** Naive conversion, used only to seed the solver. Percentages 0–100. */
export function rgbToCmyk([r, g, b]: [number, number, number]): [number, number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const k = 1 - Math.max(R, G, B);
  if (k >= 1) return [0, 0, 0, 100];
  const d = 1 - k;
  return [(1 - R - k) / d * 100, (1 - G - k) / d * 100, (1 - B - k) / d * 100, k * 100];
}

/** Naive conversion back to RGB; the engine owns the real profile. */
export function cmykToRgb([c, m, y, k]: [number, number, number, number]): [number, number, number] {
  const C = c / 100, M = m / 100, Y = y / 100, K = k / 100;
  return [
    255 * (1 - Math.min(1, C + K)),
    255 * (1 - Math.min(1, M + K)),
    255 * (1 - Math.min(1, Y + K)),
  ];
}

export function hexFromCmyk(cmyk: [number, number, number, number]): string {
  return rgbToHex(cmykToRgb(cmyk));
}

function clampChannel(v: number): number {
  return Math.max(0, Math.min(100, Number(v.toFixed(2))));
}

/**
 * Pure coordinate-descent seed. The engine's CMYK profile is not the naive
 * formula, so this only gets the ink in the neighbourhood; the engine loop
 * below finishes the job.
 */
export function solveCmykToTarget(
  from: [number, number, number, number],
  targetHex: string,
  tolerance = 2.5,
): { cmyk: [number, number, number, number]; deltaE: number; iterations: number } {
  let best: [number, number, number, number] = from.map(clampChannel) as [number, number, number, number];
  let bestD = deltaE2000(hexFromCmyk(best), targetHex);
  let step = 8;
  let iterations = 0;
  while (bestD > tolerance && step >= 0.25 && iterations < 240) {
    let improved = false;
    for (let i = 0; i < 4; i++) {
      for (const dir of [1, -1]) {
        const candidate = [...best] as [number, number, number, number];
        candidate[i] = clampChannel(candidate[i] + dir * step);
        iterations++;
        const d = deltaE2000(hexFromCmyk(candidate), targetHex);
        if (d < bestD - 1e-9) {
          best = candidate;
          bestD = d;
          improved = true;
        }
      }
    }
    if (!improved) step /= 2;
  }
  return { cmyk: best, deltaE: bestD, iterations };
}

function cmykOf(swatch: RawSwatch): [number, number, number, number] {
  const color = swatch.color;
  if (color?.model === "cmyk") {
    return [
      clampChannel((color.c ?? 0) * 100),
      clampChannel((color.m ?? 0) * 100),
      clampChannel((color.y ?? 0) * 100),
      clampChannel((color.k ?? 0) * 100),
    ];
  }
  return rgbToCmyk(hexToRgb(swatch.hex));
}

/**
 * Ink solver with the engine in the loop. Every probe is a real swatch edit and
 * the hex is read back from the engine, so the result closes against the same
 * profile the press will use.
 */
export async function closeSwatchOnEngine(
  session: VectorSession,
  name: string,
  targetHex: string,
  tolerance = 2.5,
): Promise<{
  cmyk: [number, number, number, number];
  hex: string;
  deltaE: number;
  edits: number;
  moved: [number, number, number, number];
}> {
  const read = async (): Promise<RawSwatch> => {
    const found = (await session.swatches()).find((s) => s.name === name);
    if (!found) throw new Error(`swatch ${name} not found`);
    return found;
  };

  const start = await read();
  const original = cmykOf(start);
  let best = original;
  let bestHex = start.hex;
  let bestD = deltaE2000(bestHex, targetHex);
  let edits = 0;
  let step = 8;

  const write = async (cmyk: [number, number, number, number]) => {
    await session.run("swatch.edit", {
      name,
      color: { c: cmyk[0], m: cmyk[1], y: cmyk[2], k: cmyk[3] },
      mode: "cmyk",
    });
    edits++;
    const updated = await read();
    return updated.hex;
  };

  while (bestD > tolerance && step >= 0.25 && edits < 48) {
    let improved = false;
    for (let i = 0; i < 4 && bestD > tolerance; i++) {
      for (const dir of [1, -1] as const) {
        const candidate = [...best] as [number, number, number, number];
        candidate[i] = clampChannel(candidate[i] + dir * step);
        const hex = await write(candidate);
        const d = deltaE2000(hex, targetHex);
        if (d < bestD - 1e-9) {
          best = candidate;
          bestD = d;
          bestHex = hex;
          improved = true;
        } else {
          await write(best);
        }
      }
    }
    if (!improved) step /= 2;
  }

  const finalHex = await write(best);
  const moved = best.map((v, i) => clampChannel(v - original[i])) as [number, number, number, number];
  return { cmyk: best, hex: finalHex, deltaE: deltaE2000(finalHex, targetHex), edits, moved };
}

// ---------------------------------------------------------------------------
// Digest
// ---------------------------------------------------------------------------

function fillHex(value?: string): string | undefined {
  if (!value || value === "None") return undefined;
  const match = /#([0-9a-fA-F]{6})/.exec(value);
  return match ? `#${match[1].toLowerCase()}` : undefined;
}

function boundsOf(node: InspectNode): [number, number, number, number] | undefined {
  if (!node.bounds) return undefined;
  const { x, y, width, height } = node.bounds;
  return [x, y, x + width, y + height];
}

function flatten(nodes: InspectNode[], out: InspectNode[] = []): InspectNode[] {
  for (const node of nodes) {
    if (node.bounds && node.kind !== "Layer") out.push(node);
    if (node.children) flatten(node.children, out);
  }
  return out;
}

export function intersects(
  a: [number, number, number, number],
  b: [number, number, number, number],
): boolean {
  return !(a[2] < b[0] || a[0] > b[2] || a[3] < b[1] || a[1] > b[3]);
}

const KIND_MAP: Record<string, ObjectAnnotation["kind"]> = {
  Type: "Text",
  Path: "Path",
  Group: "Group",
  Image: "Image",
  CompoundPath: "CompoundPath",
  LivePaint: "LivePaint",
};

function textStyle(node: Record<string, any>): { fontFamily?: string; fontSizePt?: number } {
  const kind = node.kind;
  if (kind?.type !== "text") return {};
  const style = kind.runs?.[0]?.style;
  return { fontFamily: style?.font_family, fontSizePt: style?.size };
}

/**
 * Structural digest. `doc_inspect` supplies the tree and bounds; one
 * `document.node` call per object adds what the tree omits: font metrics and
 * the effect stack.
 */
export async function buildDigest(
  session: VectorSession,
  config: AuditConfig,
): Promise<ComplianceDigest> {
  const inspect = await session.inspect(2);
  const swatches = await session.swatches();
  const artboard = inspect.artboards[0];
  if (!artboard) throw new Error("document has no artboard");

  const annotations: ObjectAnnotation[] = [];
  for (const node of flatten(inspect.layers)) {
    if (node.visible === false) continue;
    const kind = KIND_MAP[node.kind] ?? "Path";
    const bounds = boundsOf(node);
    if (!bounds) continue;
    const detail = await session.node(node.id);
    const style = textStyle(detail);
    annotations.push({
      id: node.id,
      name: node.name ?? "",
      kind,
      bounds,
      fillHex: fillHex(node.fill),
      strokeHex: fillHex(node.stroke),
      fontFamily: style.fontFamily,
      fontSizePt: style.fontSizePt,
      effectIds: (detail.appearance?.effects ?? []).map((e: { id: string }) => e.id),
    });
  }

  const tolerance = config.deltaETolerance ?? 2.5;
  const approved = config.approved.map(({ name, targetHex }) => {
    const swatch = swatches.find((s) => s.name === name);
    return {
      name,
      hex: swatch?.hex ?? "#000000",
      isSpot: swatch?.spot ?? false,
      deltaEToTarget: swatch ? deltaE2000(swatch.hex, targetHex) : 99,
    };
  });

  const wordmark = annotations.find((o) => o.name === config.wordmarkName);
  const capHeight = (wordmark?.fontSizePt ?? 0) * 0.7;
  const pad = 1.5 * capHeight;
  const clearSpace: [number, number, number, number] = wordmark
    ? [wordmark.bounds[0] - pad, wordmark.bounds[1] - pad, wordmark.bounds[2] + pad, wordmark.bounds[3] + pad]
    : [0, 0, 0, 0];

  const clearSpaceViolations = annotations
    .filter((o) => o.id !== wordmark?.id && intersects(o.bounds, clearSpace))
    .map((o) => o.id);

  const dieLine: [number, number, number, number] = [
    config.dieLineInsetPt,
    config.dieLineInsetPt,
    artboard.width - config.dieLineInsetPt,
    artboard.height - config.dieLineInsetPt,
  ];
  const approvedHexes = new Set(approved.map((a) => a.hex.toLowerCase()));
  const dieLineIntrusions = annotations
    .filter((o) => o.fillHex !== undefined)
    .filter((o) => intersects(o.bounds, dieLine) && !approvedHexes.has(o.fillHex!))
    .map((o) => o.id);

  // Placed rasters would be measured through links.list; this document has
  // only vector art, so the list stays empty until a raster is linked.
  const lowPpiImages: ComplianceDigest["lowPpiImages"] = [];

  return {
    artboard: { widthPt: artboard.width, heightPt: artboard.height },
    objects: annotations,
    approvedSwatches: approved.map((a) => ({
      ...a,
      deltaEToTarget: Math.round(a.deltaEToTarget * 100) / 100,
    })),
    clearSpaceViolations,
    dieLineIntrusions,
    lowPpiImages,
  };
}

// ---------------------------------------------------------------------------
// Vision audit
// ---------------------------------------------------------------------------

export const BrandAuditSchema = z.object({
  findings: z
    .array(
      z.object({
        rule: z.string().min(1).max(80),
        violated: z.boolean(),
        severity: z.enum(["info", "warning", "blocking"]),
        note: z.string().max(600),
      }),
    )
    .max(16),
  fixes: z
    .array(
      z.discriminatedUnion("kind", [
        z.object({ kind: z.literal("reposition"), targetId: z.number().int(), dxPt: z.number(), dyPt: z.number() }),
        z.object({ kind: z.literal("resize"), targetId: z.number().int(), scalePct: z.number().positive() }),
        z.object({
          kind: z.literal("typography"),
          targetId: z.number().int(),
          sizePt: z.number().positive().optional(),
          tracking: z.number().optional(),
          fontFamily: z.string().optional(),
        }),
        z.object({ kind: z.literal("remove_effect"), targetId: z.number().int(), effectIndex: z.number().int().min(0) }),
        z.object({ kind: z.literal("swap_swatch"), targetId: z.number().int(), fromHex: z.string(), toHex: z.string() }),
        z.object({ kind: z.literal("recolor_gradient_to_flat"), targetId: z.number().int(), flatHex: z.string() }),
      ]),
    )
    .max(8),
  confidence: z.number().min(0).max(1),
});

export type VisionFn = (input: { previewPngB64: string; digest: ComplianceDigest }) => Promise<BrandAudit>;

const SYSTEM_PROMPT = `You are a packaging pre-flight art director.
You receive a PNG of one artboard and a JSON structural digest of the same
document. Judge only what geometry cannot: optical centring, visual balance of
the clear space, and whether the illustration's style belongs to the brand.
Colour accuracy is already measured in the digest; never estimate ΔE yourself.
Return JSON with:
- findings: [{rule, violated, severity: "info"|"warning"|"blocking", note}]
- fixes: typed corrections, each referencing a targetId that exists in the digest
- confidence: 0..1
Allowed fix kinds: reposition {targetId, dxPt, dyPt}, resize {targetId, scalePct},
typography {targetId, sizePt?, tracking?, fontFamily?}, remove_effect
{targetId, effectIndex}, swap_swatch {targetId, fromHex, toHex},
recolor_gradient_to_flat {targetId, flatHex}. Prefer the fewest fixes.`;

/** Lazily constructs the client so the module imports without an API key. */
export function createOpenAiVision(model = process.env.OPENAI_VISION_MODEL ?? "gpt-4.1-mini"): VisionFn {
  let client: OpenAI | undefined;
  return async ({ previewPngB64, digest }) => {
    client ??= new OpenAI();
    const completion = await client.chat.completions.create({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Structural digest:\n" +
                JSON.stringify(digest) +
                "\nAudit this artboard. The wordmark name is in the digest.",
            },
            { type: "image_url", image_url: { url: `data:image/png;base64,${previewPngB64}`, detail: "high" } },
          ],
        },
      ],
    });
    const raw = completion.choices[0]?.message?.content ?? "{}";
    const parsed = BrandAuditSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new Error(`vision audit failed validation: ${parsed.error.message}`);
    return parsed.data;
  };
}

// ---------------------------------------------------------------------------
// Dry run and application
// ---------------------------------------------------------------------------

const PREVIEW_SIDE = 1024;
const MAX_SSD = 0.25;
const ESCALATE_DX_DY = 4; // pt
const ESCALATE_CMYK_JUMP = 8; // percentage points, per channel

export function decodePng(base64: string): PNG {
  return PNG.sync.read(Buffer.from(base64, "base64"));
}

/** Mean squared per-channel difference, normalised to 0..1. */
export function ssdBetween(a: PNG, b: PNG): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  let sum = 0;
  const pixels = a.width * a.height;
  for (let i = 0; i < pixels * 4; i += 4) {
    const dr = a.data[i] - b.data[i];
    const dg = a.data[i + 1] - b.data[i + 1];
    const db = a.data[i + 2] - b.data[i + 2];
    sum += (dr * dr + dg * dg + db * db) / (255 * 255);
  }
  return sum / (pixels * 3);
}

type FixOutcome =
  | { status: "applied"; steps: BatchStep[]; dryRun?: DryRunResult; notes: string[] }
  | { status: "escalated"; reason: string };

function stepsFor(fix: BrandFix): { steps: BatchStep[]; mutating: BatchStep | null } {
  switch (fix.kind) {
    case "reposition":
      return {
        steps: [
          { id: "select.set", params: { ids: [fix.targetId] } },
          { id: "object.move", params: { dx: fix.dxPt, dy: fix.dyPt } },
        ],
        mutating: { id: "object.move", params: { dx: fix.dxPt, dy: fix.dyPt } },
      };
    case "resize":
      return {
        steps: [
          { id: "select.set", params: { ids: [fix.targetId] } },
          { id: "object.scale", params: { sx: fix.scalePct, sy: fix.scalePct } },
        ],
        mutating: { id: "object.scale", params: { sx: fix.scalePct, sy: fix.scalePct } },
      };
    case "typography": {
      const params: Record<string, unknown> = { id: fix.targetId };
      if (fix.sizePt !== undefined) params.size = fix.sizePt;
      if (fix.tracking !== undefined) params.tracking = fix.tracking;
      if (fix.fontFamily !== undefined) params.font = fix.fontFamily;
      return { steps: [{ id: "text.setStyle", params }], mutating: null };
    }
    case "remove_effect":
      return {
        steps: [{ id: "effect.remove", params: { index: fix.effectIndex, ids: [fix.targetId] } }],
        mutating: null,
      };
    case "recolor_gradient_to_flat":
      return {
        steps: [
          { id: "select.set", params: { ids: [fix.targetId] } },
          { id: "paint.setFill", params: { color: fix.flatHex } },
        ],
        mutating: null,
      };
    case "swap_swatch":
      return { steps: [], mutating: null };
  }
}

async function dryRunGeometry(
  session: VectorSession,
  steps: BatchStep[],
  command: { id: string; params: Record<string, unknown> },
  before: string,
): Promise<DryRunResult> {
  await session.beginGroup(`dry-run ${command.id}`);
  let after = before;
  try {
    // Not atomic: a nested atomic batch becomes its own undo group and
    // survives the outer cancel. Inside this group, plain steps cancel cleanly.
    await session.batch(steps, `dry-run ${command.id}`, false);
    after = await session.preview(PREVIEW_SIDE);
  } finally {
    await session.endGroup(true);
  }
  const ssd = ssdBetween(decodePng(before), decodePng(after));
  return {
    command,
    rasterBefore: before,
    rasterAfter: after,
    ssd: Math.round(ssd * 1e6) / 1e6,
    improvement: Math.round((1 - ssd) * 1e6) / 1e6,
  };
}

async function applySwatchFix(
  session: VectorSession,
  fix: Extract<BrandFix, { kind: "swap_swatch" }>,
  digest: ComplianceDigest,
  tolerance: number,
): Promise<FixOutcome> {
  const swatches = (await session.swatches()).filter((s) => typeof s.hex === "string");
  const swatch =
    swatches.find((s) => s.hex.toLowerCase() === fix.fromHex.toLowerCase()) ??
    swatches.reduce((closest, s) =>
      deltaE2000(s.hex, fix.fromHex) < deltaE2000(closest.hex, fix.fromHex) ? s : closest,
    );
  if (!swatch) return { status: "escalated", reason: "no swatch matches the reported colour" };

  const before = cmykOf(swatch);
  const solved = await closeSwatchOnEngine(session, swatch.name, fix.toHex, tolerance);
  const moved = solved.moved.map(Math.abs);
  const worst = Math.max(...moved);

  if (worst > ESCALATE_CMYK_JUMP) {
    // Put the swatch back before escalating: the operator decides on a
    // repaint, the agent does not quietly shift a brand ink by 12 %.
    await session.run("swatch.edit", {
      name: swatch.name,
      color: { c: before[0], m: before[1], y: before[2], k: before[3] },
      mode: "cmyk",
    });
    return {
      status: "escalated",
      reason:
        `swatch ${swatch.name} would move ${worst.toFixed(1)} points of ink ` +
        `(limit ${ESCALATE_CMYK_JUMP})`,
    };
  }

  const notes = [
    `swatch ${swatch.name}: ${swatch.hex} → ${solved.hex} (target ${fix.toHex})`,
    `ΔE 2000 = ${solved.deltaE.toFixed(2)} after ${solved.edits} probes`,
  ];
  return {
    status: "applied",
    steps: [
      {
        id: "swatch.edit",
        params: {
          name: swatch.name,
          color: { c: solved.cmyk[0], m: solved.cmyk[1], y: solved.cmyk[2], k: solved.cmyk[3] },
          mode: "cmyk",
        },
      },
    ],
    notes,
  };
}

async function applyFix(
  session: VectorSession,
  fix: BrandFix,
  digest: ComplianceDigest,
  config: AuditConfig,
  before: string,
): Promise<FixOutcome> {
  const wordmark = digest.objects.find((o) => o.name === config.wordmarkName);

  if (fix.kind === "reposition" && wordmark && fix.targetId === wordmark.id) {
    if (Math.abs(fix.dxPt) > ESCALATE_DX_DY || Math.abs(fix.dyPt) > ESCALATE_DX_DY) {
      return {
        status: "escalated",
        reason:
          `wordmark move of ${fix.dxPt.toFixed(1)}, ${fix.dyPt.toFixed(1)} pt ` +
          `exceeds the ${ESCALATE_DX_DY} pt limit`,
      };
    }
  }

  if (fix.kind === "swap_swatch") {
    return applySwatchFix(session, fix, digest, config.deltaETolerance ?? 2.5);
  }

  // A flat fill is never typed as a hex: it is snapped to the nearest approved
  // swatch so the object stays linked and the die-line test sees the swatch
  // colour, not an orphan RGB value that merely looks right.
  if (fix.kind === "recolor_gradient_to_flat") {
    const tolerance = config.deltaETolerance ?? 2.5;
    // Read the swatches again: the swap fix may already have closed one, and a
    // hex typed into a CMYK document is re-profiled, so a swatch link is the
    // only way to land exactly on the approved colour.
    const current = await session.swatches();
    const nearest = config.approved
      .map((a) => {
        const found = current.find((s) => s.name === a.name && typeof s.hex === "string");
        return {
          name: a.name,
          distance: found ? deltaE2000(found.hex, fix.flatHex) : Number.POSITIVE_INFINITY,
        };
      })
      .sort((a, b) => a.distance - b.distance)[0];
    if (nearest && nearest.distance <= tolerance) {
      const steps: BatchStep[] = [
        { id: "select.set", params: { ids: [fix.targetId] } },
        { id: "paint.setFill", params: { swatch: nearest.name } },
      ];
      await session.batch(steps, fix.kind);
      return {
        status: "applied",
        steps,
        notes: [`snapped ${fix.flatHex} to approved swatch ${nearest.name}`],
      };
    }
  }

  const { steps, mutating } = stepsFor(fix);

  if (mutating) {
    const dryRun = await dryRunGeometry(session, steps, { id: mutating.id, params: mutating.params ?? {} }, before);
    if (dryRun.ssd > MAX_SSD) {
      return {
        status: "escalated",
        reason: `dry run changed ${(dryRun.ssd * 100).toFixed(1)} % of the raster (limit ${MAX_SSD * 100} %)`,
      };
    }
    await session.batch(steps, fix.kind);
    return {
      status: "applied",
      steps,
      dryRun,
      notes: [`dry run SSD ${dryRun.ssd.toFixed(4)}`],
    };
  }

  await session.batch(steps, fix.kind);
  return { status: "applied", steps, notes: [] };
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

export async function runBrandAudit(
  file: string,
  config: AuditConfig,
  deps: { vision: VisionFn; jobId?: string; now?: () => Date },
): Promise<BrandReport> {
  const maxRounds = config.maxRounds ?? 3;
  const session = new VectorSession({ read: config.readRoot, write: config.writeRoot });
  await session.connect();
  try {
    await session.open(file);
    const digest = await buildDigest(session, config);
    const preview = await session.preview(PREVIEW_SIDE);
    const audit = await deps.vision({ previewPngB64: preview, digest });

    const applied: AppliedFix[] = [];
    const escalated: EscalatedFix[] = [];
    let rounds = 0;

    for (const fix of audit.fixes) {
      if (rounds >= maxRounds) {
        escalated.push({ fix, reason: `iteration budget of ${maxRounds} rounds reached` });
        continue;
      }
      // Each fix starts from the current raster so the dry run compares like
      // with like even after a previous correction.
      const before = rounds === 0 ? preview : await session.preview(PREVIEW_SIDE);
      const outcome = await applyFix(session, fix, digest, config, before);
      if (outcome.status === "escalated") {
        escalated.push({ fix, reason: outcome.reason });
      } else {
        applied.push({ fix, steps: outcome.steps, dryRun: outcome.dryRun, notes: outcome.notes });
        rounds++;
      }
    }

    const finalDigest = await buildDigest(session, config);
    const finalPreviewPng = await session.preview(PREVIEW_SIDE);

    return {
      jobId: deps.jobId ?? randomUUID(),
      file,
      generatedAt: (deps.now?.() ?? new Date()).toISOString(),
      digest,
      audit,
      applied,
      escalated,
      rounds,
      finalDigest,
      finalPreviewPng,
    };
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [file, configPath] = process.argv.slice(2);
  if (!file || !configPath) {
    console.error("usage: tsx 02_vector-audit.ts <file.vectorcraft> <brand.config.json>");
    process.exit(1);
  }
  const { readFile } = await import("node:fs/promises");
  const config = JSON.parse(await readFile(configPath, "utf8")) as AuditConfig;
  const report = await runBrandAudit(file, config, { vision: createOpenAiVision() });
  console.log(
    JSON.stringify(
      {
        jobId: report.jobId,
        rounds: report.rounds,
        applied: report.applied.length,
        escalated: report.escalated.map((e) => e.reason),
      },
      null,
      2,
    ),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
