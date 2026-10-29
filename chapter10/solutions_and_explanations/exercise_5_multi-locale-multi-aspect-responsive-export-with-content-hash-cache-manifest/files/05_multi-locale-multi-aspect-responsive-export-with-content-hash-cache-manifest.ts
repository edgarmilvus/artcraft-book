import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { promises as fs } from "node:fs";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------------

export type Aspect = "1:1" | "4:5" | "9:16" | "16:9" | "3:2";
export type Locale = "en-US" | "en-GB" | "de-DE" | "ja-JP" | "pt-BR" | "ar-SA";
export type Format = "png" | "webp" | "jpg";

export interface VariantKey { sku: string; locale: Locale; aspect: Aspect; }

export interface CacheManifestEntry {
  sku: string;
  locale: Locale;
  aspect: Aspect;
  sourceHash: string;
  artifacts: Array<{ format: Format; path: string; bytes: number; sha256: string }>;
  generatedAt: string;
  commandTrace: string[];
}

export interface CacheManifest {
  version: 1;
  generatedBy: "responsive-fanout/v1";
  entries: Record<string, CacheManifestEntry>;
}

export interface RunLog {
  runId: string;
  startedAt: string;
  finishedAt: string;
  hits: number;
  misses: number;
  errors: Array<{ variantKey: VariantKey; code: string; detail: string }>;
  contended: boolean;
  gitSha: string;
}

const ASPECTS: Record<Aspect, [number, number]> = {
  "1:1": [1080, 1080],
  "4:5": [1080, 1350],
  "9:16": [1080, 1920],
  "16:9": [1920, 1080],
  "3:2": [1620, 1080],
};

const LOCALES: Locale[] = ["en-US", "en-GB", "de-DE", "ja-JP", "pt-BR", "ar-SA"];

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

/** JSON with sorted keys, no whitespace, floats with fixed precision. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number") return Number.isInteger(value) ? value.toString() : value.toFixed(6);
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
}

export function cacheKeyFor(
  row: Record<string, unknown>,
  brandKitVersion: string,
  locale: Locale,
  aspect: Aspect,
  templateId: string,
  targetFormats: Format[],
): string {
  const input = { row, brandKitVersion, locale, aspect, templateId, targetFormats };
  return createHash("sha256").update(canonical(input)).digest("hex");
}

// ---------------------------------------------------------------------------
// Lock-file discipline
// ---------------------------------------------------------------------------

const LOCK_WAIT_MS = 5000;

export async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + LOCK_WAIT_MS;
  let backoff = 25;
  while (Date.now() < deadline) {
    try {
      const fd = fsSync.openSync(lockPath, "wx");
      fsSync.writeSync(fd, String(process.pid));
      fsSync.closeSync(fd);
      return async () => { try { await fs.unlink(lockPath); } catch {} };
    } catch (err: any) {
      if (err.code !== "EEXIST") throw err;
      await new Promise((r) => setTimeout(r, backoff));
      backoff = Math.min(backoff * 2, 500);
    }
  }
  throw new Error("contended");
}

// ---------------------------------------------------------------------------
// MCP wrappers
// ---------------------------------------------------------------------------

export class McpProcess {
  private client!: Client;
  constructor(private cmd: string, private args: string[]) {}
  async start(): Promise<void> {
    const t = new StdioClientTransport({ command: this.cmd, args: this.args });
    this.client = new Client({ name: "responsive-fanout", version: "1.0.0" }, { capabilities: {} });
    await this.client.connect(t);
  }
  async close(): Promise<void> { await this.client.close(); }
  async call(name: string, args: Record<string, unknown>): Promise<any> {
    const result: any = await this.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: Number(process.env.MCP_TIMEOUT_MS ?? 60_000) },
    );
    const text = result?.content?.find((block: any) => block.type === "text")?.text;
    if (result?.isError) throw new Error(`${name}: ${text ?? "unknown error"}`);
    if (text) {
      try { return JSON.parse(text); } catch { return text; }
    }
    return result;
  }
}

// ---------------------------------------------------------------------------
// Manifest I/O
// ---------------------------------------------------------------------------

export async function loadManifest(manifestPath: string): Promise<CacheManifest> {
  try {
    const raw = await fs.readFile(manifestPath, "utf8");
    return JSON.parse(raw) as CacheManifest;
  } catch {
    return { version: 1, generatedBy: "responsive-fanout/v1", entries: {} };
  }
}

export async function saveManifest(manifestPath: string, manifest: CacheManifest): Promise<void> {
  // Sort keys so diffs are stable.
  const sorted: CacheManifest = {
    version: manifest.version,
    generatedBy: manifest.generatedBy,
    entries: Object.fromEntries(
      Object.entries(manifest.entries).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
  };
  const tmp = `${manifestPath}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(sorted, null, 2));
  await fs.rename(tmp, manifestPath);
}

export function mergeManifest(local: CacheManifest, remoteOnDisk: CacheManifest): CacheManifest {
  // Deterministic collision resolution: identical sourceHash means they should
  // be identical; keep whichever is picked by lexicographic tie-break on generatedAt.
  const merged: CacheManifest = { version: 1, generatedBy: "responsive-fanout/v1", entries: {} };
  const keys = new Set([...Object.keys(local.entries), ...Object.keys(remoteOnDisk.entries)]);
  for (const k of keys) {
    const a = local.entries[k]; const b = remoteOnDisk.entries[k];
    if (a && !b) merged.entries[k] = a;
    else if (b && !a) merged.entries[k] = b;
    else if (a && b) merged.entries[k] = a.sourceHash === b.sourceHash ? a : (a.generatedAt < b.generatedAt ? a : b);
  }
  return merged;
}

// ---------------------------------------------------------------------------
// Variant pipeline
// ---------------------------------------------------------------------------

interface PipelineDeps {
  designcraft: McpProcess;
  photocraft: McpProcess;
  writeRoot: string;
  templateId: string;
  brandKitVersion: string;
  dryRun: boolean;
}

export async function processVariant(
  key: VariantKey,
  feedRow: Record<string, unknown>,
  deps: PipelineDeps,
): Promise<{ hit: boolean; entry: CacheManifestEntry; trace: string[] }> {
  const [w, h] = ASPECTS[key.aspect];
  const formats: Format[] = ["png", "webp", "jpg"];
  const sourceHash = cacheKeyFor(feedRow, deps.brandKitVersion, key.locale, key.aspect, deps.templateId, formats);
  const trace: string[] = [];
  const outStem = `${key.sku}-${key.locale.replace("-", "")}-${key.aspect.replace(":", "x")}`;
  const artifacts: CacheManifestEntry["artifacts"] = [];

  // 1. DesignCraft: open template, populate story text, RTL if needed, export PDF.
  await deps.designcraft.call("open_document", { path: deps.templateId });
  trace.push("open_document");

  const template = await deps.designcraft.call("inspect_document", {});
  const textFrame = (template.spreads ?? [])
    .flatMap((spread: any) => spread.items ?? [])
    .find((item: any) => item.kind === "<text frame>");
  if (!textFrame) throw new Error("template has no text frame");
  const storyId = Number(textFrame.story);
  await deps.designcraft.call("set_story_text", { story: storyId, text: String(feedRow.title ?? "") });
  trace.push("set_story_text");

  await deps.designcraft.call("execute", {
    command: "selection.set",
    params: { ids: [textFrame.id] },
  });
  trace.push("selection.set");
  await deps.designcraft.call("execute", {
    command: "style.paragraph.apply",
    params: { name: `${key.locale}-heading`, clearOverrides: true },
  });
  trace.push("style.paragraph.apply");

  await deps.designcraft.call("execute", {
    command: "story.setDirection",
    params: { story: storyId, direction: key.locale === "ar-SA" ? "rightToLeft" : "leftToRight" },
  });
  trace.push("story.setDirection");

  await deps.designcraft.call("execute", {
    command: "object.textFrameOptions",
    params: { verticalJustification: "center", ids: [textFrame.id] },
  });
  trace.push("object.textFrameOptions");

  // Alternate layout for this aspect
  await deps.designcraft.call("execute", {
    command: "layout.createAlternate",
    params: { name: key.aspect, width: w, height: h, rule: "reCenter" },
  });
  trace.push("layout.createAlternate");

  // Safety-zone validation on the layout
  const inspect = await deps.designcraft.call("inspect_document", {});
  validateSafeZone(inspect, 0.05, w, h);
  const pageIndex = Math.max(0, Number(inspect.pageCount ?? 1) - 1);

  // Export intermediate PDF
  const pdfPath = path.join(deps.writeRoot, `${outStem}-proof.pdf`);
  await deps.designcraft.call("execute", {
    command: "file.exportPdf",
    params: { path: pdfPath, pages: [pageIndex + 1], compressImages: true },
  });
  trace.push("file.exportPdf");

  // 2. Rasterize: DesignCraft writes PNG and JPEG proofs directly. The WebP
  //    deliverable is a PhotoCraft export of the PNG, because PhotoCraft does
  //    not open a PDF as an image document.
  const pngAbs = path.join(deps.writeRoot, `${outStem}.png`);
  await deps.designcraft.call("export_png", { page: pageIndex, path: pngAbs, scale: 2 });
  trace.push("export_png:png");

  const jpgAbs = path.join(deps.writeRoot, `${outStem}.jpg`);
  await deps.designcraft.call("export_png", { page: pageIndex, path: jpgAbs, scale: 2 });
  trace.push("export_png:jpg");

  const webpAbs = path.join(deps.writeRoot, `${outStem}.webp`);
  await deps.photocraft.call("doc_open", { path: pngAbs });
  trace.push("doc_open");
  await deps.photocraft.call("doc_export", {
    path: webpAbs, format: "webp", quality: 86,
  });
  trace.push("doc_export:webp");

  for (const [fmt, abs] of [["png", pngAbs], ["webp", webpAbs], ["jpg", jpgAbs]] as const) {
    const buf = await fs.readFile(abs);
    artifacts.push({
      format: fmt, path: path.basename(abs), bytes: buf.byteLength,
      sha256: createHash("sha256").update(buf).digest("hex"),
    });
  }

  return {
    hit: false,
    entry: {
      sku: key.sku, locale: key.locale, aspect: key.aspect,
      sourceHash,
      artifacts,
      generatedAt: new Date().toISOString(),
      commandTrace: trace,
    },
    trace,
  };
}

export function validateSafeZone(inspect: any, pct: number, width?: number, height?: number): void {
  const pageW = width ?? inspect?.settings?.pageWidth ?? inspect?.settings?.width ?? inspect?.pages?.[0]?.width;
  const pageH = height ?? inspect?.settings?.pageHeight ?? inspect?.settings?.height ?? inspect?.pages?.[0]?.height;
  if (!pageW || !pageH) throw new Error("invalid-inspect: missing page size");
  const [x0, y0] = [pct * pageW, pct * pageH];
  const [x1, y1] = [(1 - pct) * pageW, (1 - pct) * pageH];
  const items = inspect.items ?? (inspect.spreads ?? []).flatMap((spread: any) => spread.items ?? []);
  for (const item of items) {
    const b = item.bounds;
    if (!b) continue;
    if (b[0] < x0 || b[1] < y0 || b[2] > x1 || b[3] > y1) {
      throw new Error(`safe-zone: item ${item.id} bounds [${b}] outside [${x0},${y0},${x1},${y1}]`);
    }
  }
}

async function linkOrCopy(from: string, to: string): Promise<void> {
  try { await fs.link(from, to); }
  catch { await fs.copyFile(from, to); }
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

export async function run(opts: {
  feedPath: string; readRoot: string; writeRoot: string; templateId: string;
  brandKitVersion: string; dryRun: boolean; gitSha: string;
}): Promise<RunLog> {
  const runId = createHash("sha256").update(`${Date.now()}-${Math.random()}`).digest("hex").slice(0, 16);
  const log: RunLog = {
    runId, startedAt: new Date().toISOString(), finishedAt: "",
    hits: 0, misses: 0, errors: [], contended: false, gitSha: opts.gitSha,
  };

  const manifestPath = path.join(opts.writeRoot, "cache-manifest.json");
  const lockPath = `${manifestPath}.lock`;

  let release: (() => Promise<void>) | null = null;
  try {
    release = await acquireLock(lockPath);
  } catch {
    log.contended = true;
    log.finishedAt = new Date().toISOString();
    return log;
  }

  // DesignCraft has no automation-root flags; paths are sandboxed by the
  // process working directory and the explicit write root used below.
  const designcraft = new McpProcess("designcraft-cli", ["mcp"]);
  const photocraft = new McpProcess("photocraft-cli", ["mcp",
    "--automation-read-root", opts.readRoot, "--automation-write-root", opts.writeRoot]);

  try {
    if (!opts.dryRun) {
      await designcraft.start();
      await photocraft.start();
    }

    // Snapshot the manifest we will mutate.
    const disk = await loadManifest(manifestPath);
    const working: CacheManifest = JSON.parse(JSON.stringify(disk));

    const feed: Array<Record<string, unknown>> = JSON.parse(await fs.readFile(opts.feedPath, "utf8"));

    const deps: PipelineDeps = {
      designcraft, photocraft,
      writeRoot: opts.writeRoot,
      templateId: opts.templateId,
      brandKitVersion: opts.brandKitVersion,
      dryRun: opts.dryRun,
    };

    for (const row of feed) {
      const sku = String(row.sku ?? "");
      for (const locale of LOCALES) {
        for (const aspect of Object.keys(ASPECTS) as Aspect[]) {
          const key: VariantKey = { sku, locale, aspect };
          const sourceHash = cacheKeyFor(row, deps.brandKitVersion, locale, aspect, opts.templateId, ["png", "webp", "jpg"]);

          // Cache hit?
          const hitEntry = working.entries[sourceHash];
          if (hitEntry) {
            if (!opts.dryRun) {
              // Re-materialize the artifacts at their fresh paths via hard link.
              for (const art of hitEntry.artifacts) {
                const cached = path.join(opts.writeRoot, art.path);
                await linkOrCopy(cached, cached); // no-op: artifacts already at their canonical path
              }
            }
            log.hits += 1;
            continue;
          }

          if (opts.dryRun) {
            log.misses += 1;
            continue;
          }

          try {
            const { entry } = await processVariant(key, row, deps);
            working.entries[sourceHash] = entry;
            log.misses += 1;
          } catch (err) {
            log.errors.push({
              variantKey: key,
              code: "pipeline-error",
              detail: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }
    }

    // Reread the disk manifest under the lock, merge deterministically, and write.
    const diskUnderLock = await loadManifest(manifestPath);
    const merged = mergeManifest(working, diskUnderLock);
    if (!opts.dryRun) await saveManifest(manifestPath, merged);
  } finally {
    if (!opts.dryRun) {
      await designcraft.close().catch(() => {});
      await photocraft.close().catch(() => {});
    }
    if (release) await release();
    log.finishedAt = new Date().toISOString();
  }

  return log;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run({
    feedPath: process.argv[2],
    readRoot: path.resolve(process.argv[3]),
    writeRoot: path.resolve(process.argv[4]),
    templateId: path.resolve(process.argv[5]),
    brandKitVersion: process.argv[6],
    dryRun: process.argv.includes("--dry-run"),
    gitSha: process.env.GIT_SHA ?? "unknown",
  })
    .then((log) => console.log(JSON.stringify(log)))
    .catch((e) => { console.error(e); process.exit(1); });
}
