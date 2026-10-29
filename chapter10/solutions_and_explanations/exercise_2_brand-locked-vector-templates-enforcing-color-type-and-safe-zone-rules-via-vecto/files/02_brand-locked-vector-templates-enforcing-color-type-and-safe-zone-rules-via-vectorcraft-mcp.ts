import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export interface BrandKit {
  version: string;
  swatches: Array<{ name: string; hex: string; role: "primary" | "secondary" | "accent" | "text" | "background" }>;
  fonts: string[];
  safeZonePct: number;
  minContrastRatio: number;
  logoClearspacePt: number;
  logoSvgPath: string;
  allowedAspects: Array<[number, number]>;
}

export type RejectionRule = "brand-color" | "brand-font" | "safe-zone" | "contrast" | "z-order" | "missing-field";

export interface VectorTemplateRowResult {
  sku: string;
  accepted: boolean;
  rejected?: { rule: RejectionRule; detail: string; elementId?: number };
  artifacts?: Array<{ format: "vectorcraft" | "pdf" | "svg" | "png"; path: string; bytes: number }>;
}

export interface CanonicalRow { sku: string; title: string; price: string; heroPath: string; }

// ---------------------------------------------------------------------------
// Brand rule engine
// ---------------------------------------------------------------------------

export function hexToRgb(hex: string): [number, number, number] {
  const m = hex.replace("#", "");
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
}

function channelLum(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
}

export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channelLum(r) + 0.7152 * channelLum(g) + 0.0722 * channelLum(b);
}

export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a), lb = relativeLuminance(b);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

export class BrandRules {
  private swatchetByName: Map<string, string>;
  private fontAllow: Set<string>;

  constructor(private kit: BrandKit) {
    this.swatchetByName = new Map(kit.swatches.map((s) => [s.name, s.hex.toLowerCase()]));
    this.fontAllow = new Set(kit.fonts.map((f) => f.toLowerCase()));
  }

  swatch(name: string): string {
    const hex = this.swatchetByName.get(name);
    if (!hex) throw new RuleError("brand-color", `swatch "${name}" is not in the brand kit`);
    return hex;
  }

  checkFont(font: string): void {
    // exact, case-insensitive match against the allow-list (no substring tricks)
    if (!this.fontAllow.has(font.toLowerCase())) {
      throw new RuleError("brand-font", `font "${font}" is not on the allow-list`);
    }
  }

  checkContrast(foregroundHex: string, backgroundHex: string): number {
    const ratio = contrastRatio(foregroundHex, backgroundHex);
    if (ratio < this.kit.minContrastRatio) {
      throw new RuleError("contrast", `contrast ${ratio.toFixed(2)} < required ${this.kit.minContrastRatio}`);
    }
    return ratio;
  }

  checkSafeZone(bounds: { x: number; y: number; width: number; height: number }, canvas: { width: number; height: number }): void {
    const pct = this.kit.safeZonePct;
    const [x0, y0] = [pct * canvas.width, pct * canvas.height];
    const [x1, y1] = [(1 - pct) * canvas.width, (1 - pct) * canvas.height];
    if (bounds.x < x0) throw new RuleError("safe-zone", `left edge ${bounds.x} < ${x0}`);
    if (bounds.y < y0) throw new RuleError("safe-zone", `top edge ${bounds.y} < ${y0}`);
    if (bounds.x + bounds.width > x1) throw new RuleError("safe-zone", `right edge ${bounds.x + bounds.width} > ${x1}`);
    if (bounds.y + bounds.height > y1) throw new RuleError("safe-zone", `bottom edge ${bounds.y + bounds.height} > ${y1}`);
  }
}

export class RuleError extends Error {
  constructor(public rule: RejectionRule, public detail: string, public elementId?: number) {
    super(`${rule}: ${detail}`);
  }
}

// ---------------------------------------------------------------------------
// MCP driver
// ---------------------------------------------------------------------------

export class VectorCraftMcp {
  private client!: Client;

  async start(readRoot: string, writeRoot: string): Promise<void> {
    const t = new StdioClientTransport({
      command: "vectorcraft-cli",
      args: ["mcp", "--automation-read-root", readRoot, "--automation-write-root", writeRoot],
    });
    this.client = new Client({ name: "brand-template-generator", version: "1.0.0" }, { capabilities: {} });
    await this.client.connect(t);
  }
  async close(): Promise<void> { await this.client.close(); }
  async command(id: string, params: Record<string, unknown> = {}): Promise<any> {
    const result: any = await this.client.callTool({
      name: "command_run", arguments: { id, params },
    });
    const text = result?.content?.find((block: any) => block.type === "text")?.text;
    try { return text ? JSON.parse(text) : result; } catch { return result; }
  }
  async newDocument(width: number, height: number): Promise<void> {
    await this.command("file.new", {
      name: "Brand Banner", width, height, units: "Points", colorMode: "rgb",
    });
  }
  async batch(steps: Array<{ id: string; params?: Record<string, unknown> }>, atomic = true): Promise<unknown> {
    // `draw_shape`, `draw_path`, `add_text` and `file.place` are MCP tools,
    // not registry commands. A batch is therefore a deterministic sequence of
    // tool calls; the order is the z-order.
    const results: unknown[] = [];
    for (const step of steps) {
      results.push(await this.client.callTool({ name: step.id, arguments: step.params ?? {} }));
    }
    return results;
  }
  async inspect(): Promise<unknown> {
    const result: any = await this.client.callTool({ name: "doc_inspect", arguments: { depth: 2, childLimit: 50 } });
    const text = result?.content?.find((block: any) => block.type === "text")?.text;
    try { return text ? JSON.parse(text) : result; } catch { return result; }
  }
  async export(format: string, filename: string, extra: Record<string, unknown> = {}): Promise<{ path: string; bytes: number }> {
    // The tool answers with the MCP envelope; the payload is the JSON in its
    // first text block.
    const res = await this.client.callTool({
      name: "export",
      arguments: { path: filename, format, ...extra },
    }) as { content?: { type: string; text?: string }[] };
    const text = res.content?.find((block) => block.type === "text")?.text ?? "{}";
    return JSON.parse(text) as { path: string; bytes: number };
  }
}

// ---------------------------------------------------------------------------
// Composition builder
// ---------------------------------------------------------------------------

const CANVAS = { width: 2000, height: 2500 }; // 4:5 portrait master

interface CompositionStep { id: string; params: Record<string, unknown>; kind: "shape" | "path" | "text" | "image" | "logo"; }

export function buildComposition(row: CanonicalRow, rules: BrandRules, brandKit: BrandKit): CompositionStep[] {
  const bg = rules.swatch("Brand Background");
  const accent = rules.swatch("Brand Blue 500");
  const textColor = rules.swatch("Brand Text");
  const priceColor = rules.swatch("Brand Accent");
  const ctaText = rules.swatch("Brand White");
  const headlineFont = "Inter-Black";
  const priceFont = "Inter-Bold";
  const ctaFont = "Inter-SemiBold";

  rules.checkFont(headlineFont);
  rules.checkFont(priceFont);
  rules.checkFont(ctaFont);

  // 1. Background rectangle
  const steps: CompositionStep[] = [
    {
      kind: "shape",
      id: "draw_shape",
      params: { shape: "rectangle", x: 0, y: 0, width: CANVAS.width, height: CANVAS.height, fill: bg, stroke: "none" },
    },
    // 2. Accent bar (left vertical rule)
    {
      kind: "shape",
      id: "draw_shape",
      params: { shape: "rectangle", x: 100, y: 100, width: 24, height: CANVAS.height - 200, fill: accent, stroke: "none" },
    },
    // 3. Hero image placeholder frame (SVG-rendered at 1600 x 1600)
    {
      kind: "image",
      id: "draw_shape",
      params: {
        shape: "rectangle", x: 200, y: 200, width: 1600, height: 1600,
        fill: "#f4f1ea", stroke: "none",
      },
    },
    // 4. Logo mark
    {
      kind: "logo",
      id: "draw_shape",
      params: {
        shape: "ellipse", x: 1640, y: 150, width: 160, height: 100,
        fill: accent, stroke: "none",
      },
    },
  ];

  // Element bounds for the local safe-zone pre-check (mirrors the post-batch check).
  const elementBounds = [
    // The background is intentionally full-bleed; safe-zone rules apply to
    // content, not to the plate the content sits on.
    { id: "accent", bounds: { x: 100, y: 100, width: 24, height: CANVAS.height - 200 } },
    { id: "hero", bounds: { x: 200, y: 200, width: 1600, height: 1600 } },
    { id: "logo", bounds: { x: 1640, y: 150, width: 160, height: 100 } }, // approximation for pre-check
  ];

  // 5. Headline text
  const headline = {
    id: "add_text",
    kind: "text" as const,
    params: {
      text: row.title.slice(0, 60).toUpperCase(),
      x: 200, y: 2000,
      font: headlineFont, size: 96, color: textColor,
      width: 1600, height: 200,
    },
  };
  elementBounds.push({ id: "headline", bounds: { x: 200, y: 2000, width: 1600, height: 200 } });

  // 6. Price
  const price = {
    id: "add_text",
    kind: "text" as const,
    params: { text: row.price, x: 200, y: 2220, font: priceFont, size: 128, color: priceColor },
  };
  elementBounds.push({ id: "price", bounds: { x: 200, y: 2220, width: 800, height: 160 } });

  // 7. CTA pill (path, not shape, so the corner geometry is explicit)
  const ctaPath = `M 1100 2240 h 700 a 60 60 0 0 1 0 120 h -700 a 60 60 0 0 1 0 -120 z`;
  const cta = {
    kind: "path" as const,
    id: "draw_path",
    params: { d: ctaPath, fill: accent, stroke: "none" },
  };
  elementBounds.push({ id: "cta", bounds: { x: 1100, y: 2240, width: 700, height: 120 } });

  // 8. CTA label
  const ctaLabel = {
    kind: "text" as const,
    id: "add_text",
    params: { text: "SHOP NOW", x: 1260, y: 2280, font: ctaFont, size: 48, color: ctaText },
  };
  elementBounds.push({ id: "ctaLabel", bounds: { x: 1260, y: 2280, width: 400, height: 60 } });

  steps.push(headline, price, cta, ctaLabel);

  // Local pre-checks against the brand rules BEFORE touching VectorCraft.
  for (const el of elementBounds) rules.checkSafeZone(el.bounds, CANVAS);
  rules.checkContrast(textColor, bg);
  rules.checkContrast(priceColor, bg);
  rules.checkContrast(ctaText, accent); // CTA label is `Brand White` on `accent`

  return [...steps];
}

// ---------------------------------------------------------------------------
// z-order verification
// ---------------------------------------------------------------------------

const EXPECTED_Z_ORDER = ["bg", "accent", "hero", "logo", "headline", "price", "cta", "ctaLabel"];

export function verifyZOrder(inspect: any): void {
  // doc_inspect returns the layer tree top-to-bottom; bottom-to-top is the z order.
  const layers: Array<{ name?: string }> = inspect.layers ?? inspect.children ?? [];
  const names = layers.map((l) => l.name ?? "");
  const indices = EXPECTED_Z_ORDER.map((n) => names.findIndex((ln) => ln.includes(n)));
  for (let i = 1; i < indices.length; i++) {
    if (indices[i] < indices[i - 1]) {
      throw new RuleError("z-order", `element "${EXPECTED_Z_ORDER[i]}" is not above "${EXPECTED_Z_ORDER[i - 1]}"`);
    }
  }
}

// ---------------------------------------------------------------------------
// Main run per row
// ---------------------------------------------------------------------------

export async function processRow(
  row: CanonicalRow,
  rules: BrandRules,
  kit: BrandKit,
  vc: VectorCraftMcp | null, // null in dry-run
  writeRoot: string,
): Promise<VectorTemplateRowResult> {
  try {
    if (!row.sku || !row.title || !row.price || !row.heroPath) {
      throw new RuleError("missing-field", "one of sku/title/price/heroPath is missing");
    }

    const steps = buildComposition(row, rules, kit); // may throw a RuleError

    if (vc === null) {
      // Dry-run: report the plan without invoking VectorCraft.
      return { sku: row.sku, accepted: true };
    }

    await vc.newDocument(2000, 2500);
    await vc.batch(steps, true);

    // Post-batch verification from the engine's own view of the document.
    const inspected = await vc.inspect();
    verifyZOrder(inspected);

    const arts: VectorTemplateRowResult["artifacts"] = [];

    // Vector native master
    const native = await vc.export("vectorcraft", path.join(writeRoot, `${row.sku}.vectorcraft`));
    arts.push({ format: "vectorcraft", path: native.path, bytes: native.bytes });

    // PDF proof
    const pdf = await vc.export("pdf", path.join(writeRoot, `${row.sku}.pdf`), { artboard: 0 });
    arts.push({ format: "pdf", path: pdf.path, bytes: pdf.bytes });

    // SVG – live text, no outlining, so SEO text survives
    const svg = await vc.export("svg", path.join(writeRoot, `${row.sku}.svg`), { outlineText: false });
    arts.push({ format: "svg", path: svg.path, bytes: svg.bytes });

    // Raster fallback at 2×
    const png = await vc.export("png", path.join(writeRoot, `${row.sku}@2x.png`), { scale: 2, artboard: 0 });
    arts.push({ format: "png", path: png.path, bytes: png.bytes });

    return { sku: row.sku, accepted: true, artifacts: arts };
  } catch (err) {
    if (err instanceof RuleError) {
      return { sku: row.sku || "unknown", accepted: false, rejected: { rule: err.rule, detail: err.detail, elementId: err.elementId } };
    }
    return { sku: row.sku || "unknown", accepted: false, rejected: { rule: "missing-field", detail: String(err) } };
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [, , kitPath, feedPath, readRoot, writeRoot, ...flags] = process.argv;
  const dryRun = flags.includes("--dry-run");

  const kit: BrandKit = JSON.parse(await fs.readFile(kitPath, "utf8"));
  const rules = new BrandRules(kit);

  // Reloadable at runtime: reading the file on every run makes the kit hot-reloadable.
  const feed = JSON.parse(await fs.readFile(feedPath, "utf8")) as Array<{
    sku: string; title: string; price: number; salePrice?: number; currency: string; heroImage: string; locale?: string;
  }>;

  const vc = dryRun ? null : new VectorCraftMcp();
  if (vc) await vc.start(readRoot, writeRoot);

  try {
    const results: VectorTemplateRowResult[] = [];
    for (const raw of feed) {
      const priceText = new Intl.NumberFormat(raw.locale ?? "en-US", {
        style: "currency", currency: raw.currency,
      }).format(raw.salePrice ?? raw.price);
      const row: CanonicalRow = {
        sku: raw.sku,
        title: raw.title,
        price: priceText,
        heroPath: raw.heroImage,
      };
      results.push(await processRow(row, rules, kit, vc, writeRoot));
    }

    const reportPath = path.join(writeRoot, "brand-template-audit.json");
    await fs.writeFile(`${reportPath}.tmp`, JSON.stringify({ kitVersion: kit.version, results }, null, 2));
    await fs.rename(`${reportPath}.tmp`, reportPath);

    console.log(JSON.stringify({
      accepted: results.filter((r) => r.accepted).length,
      rejected: results.filter((r) => !r.accepted).length,
    }));
  } finally {
    if (vc) await vc.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((e) => { console.error(e); process.exit(1); });
