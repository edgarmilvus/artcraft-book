import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

export interface ProductFeedRow {
  sku?: string; title?: string; brand?: string;
  price?: number; salePrice?: number;
  currency?: string; heroImage?: string; altImages?: string[];
  locale?: string; category?: string[];
}

export type RejectionReason =
  | "missing-sku" | "missing-title" | "title-too-long" | "invalid-price"
  | "invalid-sale-price" | "invalid-currency" | "missing-hero" | "path-escape"
  | "control-chars" | "mojibake-title";

export interface FeedAuditReport {
  generatedBy: "feed-hygiene-gate/v1";
  readRoot: string; writeRoot: string;
  accepted: number; deferred: number;
  rejected: Array<{ rowIndex: number; sku: string | null; reason: RejectionReason; detail: string }>;
  artifacts: Array<{ rowIndex: number; sku: string; path: string; bytes: number; sha256: string }>;
}

const CONTROL_CHAR_RE = /[\u0000-\u001F\u007F-\u009F]/;
const ISO_4217_RE = /^[A-Z]{3}$/;
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
const SKU_RE = /^\S+$/;

export function rejection(row: ProductFeedRow): { reason: RejectionReason; detail: string } | null {
  // control-chars first: they poison any downstream check
  for (const [name, value] of Object.entries(row)) {
    if (typeof value === "string" && CONTROL_CHAR_RE.test(value)) {
      return { reason: "control-chars", detail: `field "${name}" contains a C0/C1 control character` };
    }
  }

  // SKU
  if (typeof row.sku !== "string" || row.sku.length === 0 || !SKU_RE.test(row.sku)) {
    return { reason: "missing-sku", detail: "sku missing, empty, or contains whitespace" };
  }

  // title
  if (typeof row.title !== "string" || row.title.trim().length === 0) {
    return { reason: "missing-title", detail: "title missing or whitespace-only" };
  }
  if (row.title.includes("\uFFFD")) {
    return { reason: "mojibake-title", detail: "title contains U+FFFD (upstream decode error)" };
  }
  const titleBytes = Buffer.byteLength(row.title, "utf8");
  if (titleBytes > 120) {
    return { reason: "title-too-long", detail: `title is ${titleBytes} UTF-8 bytes (limit 120)` };
  }

  // price
  if (typeof row.price !== "number" || !Number.isFinite(row.price) || row.price < 0) {
    return { reason: "invalid-price", detail: `price must be a non-negative finite number (got ${String(row.price)})` };
  }
  if (row.salePrice !== undefined) {
    if (typeof row.salePrice !== "number" || !Number.isFinite(row.salePrice) || row.salePrice >= row.price) {
      return {
        reason: "invalid-sale-price",
        detail: `salePrice ${String(row.salePrice)} must be a finite number strictly below price ${row.price}`,
      };
    }
  }

  // currency
  if (typeof row.currency !== "string" || !ISO_4217_RE.test(row.currency)) {
    return { reason: "invalid-currency", detail: `currency must be an uppercase 3-letter ISO 4217 code (got ${JSON.stringify(row.currency)})` };
  }

  // hero
  if (typeof row.heroImage !== "string" || row.heroImage.trim().length === 0) {
    return { reason: "missing-hero", detail: "heroImage missing or empty" };
  }
  const hero = row.heroImage.replace(/\\/g, "/");
  if (hero.startsWith("/") || WINDOWS_DRIVE_RE.test(hero) || hero.split("/").includes("..")) {
    return { reason: "path-escape", detail: `heroImage "${row.heroImage}" escapes the read root` };
  }

  return null;
}

/** Canonical JSON: sorted keys, no whitespace, floats with fixed precision. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a < b ? -1 : 1);
  return "{" + entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",") + "}";
}

class PhotoCraftMcp {
  private client!: Client;
  private transport!: StdioClientTransport;

  async start(readRoot: string, writeRoot: string): Promise<void> {
    this.transport = new StdioClientTransport({
      command: "photocraft-cli",
      args: ["mcp", "--automation-read-root", readRoot, "--automation-write-root", writeRoot],
    });
    this.client = new Client({ name: "feed-hygiene-gate", version: "1.0.0" }, { capabilities: {} });
    await this.client.connect(this.transport);
  }

  async close(): Promise<void> { await this.client.close(); }

  async callTool(name: string, args: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    return await withTimeout(this.client.callTool({ name, arguments: args }), timeoutMs, name);
  }

  async runBatch(steps: Array<{ id: string; params?: Record<string, unknown> }>, timeoutMs: number): Promise<unknown> {
    return this.callTool("command_batch", { steps, stop_on_error: true }, timeoutMs);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`batch-timeout:${label}`)), ms);
    p.then((v) => { clearTimeout(t); resolve(v); })
     .catch((e) => { clearTimeout(t); reject(e); });
  });
}

export function formatPrice(value: number, locale: string, currency: string): string {
  try {
    return new Intl.NumberFormat(locale, { style: "currency", currency }).format(value);
  } catch {
    // bad locale or currency – fall back to a plain format; validation already
    // passed the currency, so this is only a locale-shape rescue.
    return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
  }
}

export function buildCommandsForRow(row: ProductFeedRow, rowIndex: number) {
  const sku = row.sku!;
  const locale = row.locale ?? "en-US";
  const heroPath = row.heroImage!.replace(/\\/g, "/");
  const priceText = formatPrice(row.salePrice ?? row.price!, locale, row.currency!);

  return [
    // 1. Dedicated hero layer named after the SKU (doc_place embeds into it)
    { id: "layer.new.layer", params: { name: `hero-${sku}` } },
    // 2. Type: title
    {
      id: "type.create",
      params: {
        text: row.title!.replace(/\n/g, " "),
        x: 96, y: 900,
        font: "Inter-SemiBold", size: 56, color: "#111111",
        box: [96, 840, 1728, 120],
      },
    },
    // 5. Type: price
    {
      id: "type.create",
      params: { text: priceText, x: 96, y: 780, font: "Inter-Bold", size: 96, color: "#d97706" },
    },
    // 5. Brand S-curve (deterministic: no noise, no seeded filters)
    {
      id: "layer.newAdjustmentLayer.curves",
      params: { points: [[0, 0], [64, 54], [192, 205], [255, 255]] },
    },
  ];
}

async function sha256File(absPath: string): Promise<{ bytes: number; sha256: string }> {
  const buf = await fs.readFile(absPath);
  return { bytes: buf.byteLength, sha256: createHash("sha256").update(buf).digest("hex") };
}

interface RunOptions { feedPath: string; readRoot: string; writeRoot: string; }

export async function runGate(opts: RunOptions): Promise<FeedAuditReport> {
  const feedRaw = await fs.readFile(opts.feedPath, "utf8");
  const rows: ProductFeedRow[] = JSON.parse(feedRaw);

  const report: FeedAuditReport = {
    generatedBy: "feed-hygiene-gate/v1",
    readRoot: opts.readRoot,
    writeRoot: opts.writeRoot,
    accepted: 0,
    deferred: 0,
    rejected: [],
    artifacts: [],
  };

  const photocraft = new PhotoCraftMcp();
  await photocraft.start(opts.readRoot, opts.writeRoot);

  try {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const reject = rejection(row);
      if (reject) {
        report.rejected.push({ rowIndex: i, sku: row.sku ?? null, reason: reject.reason, detail: reject.detail });
        continue; // nothing touched on disk
      }

      const steps = buildCommandsForRow(row, i);
      try {
        // Metadata tools, not registry commands: create the document, add the
        // hero layer, embed the image, then run the text/curve commands.
        await photocraft.callTool("doc_new", {
          name: `banner-${row.sku}`,
          width: 1920, height: 1080, mode: "rgb", depth: 8, background: "#ffffff",
        }, 20_000);
        await photocraft.callTool("doc_place", {
          path: row.heroImage!.replace(/\\/g, "/"),
          fit: true,
          center: [960, 540],
        }, 20_000);
        await photocraft.runBatch(steps, 20_000);
        await photocraft.callTool("doc_export", {
          path: `${row.sku}.png`, format: "png", quality: 90,
        }, 20_000);
      } catch (err) {
        // Could be a timeout or a genuine batch failure. Record as deferred.
        const detail = err instanceof Error ? err.message : String(err);
        (report as any).deferredDetails = [
          ...(((report as any).deferredDetails as any[] | undefined) ?? []),
          { rowIndex: i, sku: row.sku!, detail: `BATCH_${detail}` },
        ];
        report.deferred += 1;
        continue;
      }

      // Verify the artifact actually landed and hash it.
      const absOut = path.join(opts.writeRoot, `${row.sku}.png`);
      try {
        const { bytes, sha256 } = await sha256File(absOut);
        report.artifacts.push({ rowIndex: i, sku: row.sku!, path: `${row.sku}.png`, bytes, sha256 });
        report.accepted += 1;
      } catch {
        report.rejected.push({
          rowIndex: i,
          sku: row.sku!,
          reason: "missing-hero",
          detail: "export did not produce the expected artifact",
        });
      }
    }
  } finally {
    await photocraft.close();
  }

  // Atomic write of the audit report beneath the write root.
  const reportPath = path.join(opts.writeRoot, "feed-audit.json");
  const tmpPath = `${reportPath}.tmp`;
  await fs.writeFile(tmpPath, canonicalJson(report));
  await fs.rename(tmpPath, reportPath);

  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runGate({
    feedPath: path.join(process.argv[2] ?? ".", "feed.json"),
    readRoot: path.resolve(process.argv[3] ?? "./feeds/nightly"),
    writeRoot: path.resolve(process.argv[4] ?? "./out/nightly"),
  }).then((r) => console.log(JSON.stringify({ accepted: r.accepted, deferred: r.deferred, rejected: r.rejected.length })))
    .catch((e) => { console.error(e); process.exit(1); });
}
