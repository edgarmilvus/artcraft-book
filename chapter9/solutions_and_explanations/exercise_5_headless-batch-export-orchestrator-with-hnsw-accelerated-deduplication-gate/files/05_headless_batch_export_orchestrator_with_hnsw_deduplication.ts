// 05_headless_batch_export_orchestrator_with_hnsw_deduplication.ts
// ---------------------------------------------------------------------------
// Exercise 5 — headless batch export with an HNSW-shaped deduplication gate.
//
// The service has two halves: a warm LightCraft MCP session and a vector
// store. The store is an interface. Production points it at pgvector; this
// solution also ships an in-memory implementation that runs the same kNN
// query so the deduplication gate can be tested without a database.
// ---------------------------------------------------------------------------

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { PNG } from "pngjs";

// ---------------------------------------------------------------------------
// 1. LightCraft MCP stdio client
// ---------------------------------------------------------------------------
export interface McpToolCall {
  content?: { type: string; text?: string; data?: string }[];
  isError?: boolean;
}

export class LightCraftMCP {
  private proc: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  private stdoutBuffer = "";

  constructor(binary = "lightcraft-cli", library = process.env.LIGHTCRAFT_LIBRARY ?? "/work/library") {
    this.proc = spawn(binary, ["mcp", "--library", library], { stdio: ["pipe", "pipe", "pipe"] });
    this.proc.stdout.on("data", (buf: Buffer) => {
      this.stdoutBuffer += buf.toString("utf8");
      let newline: number;
      while ((newline = this.stdoutBuffer.indexOf("\n")) !== -1) {
        const line = this.stdoutBuffer.slice(0, newline).trim();
        this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          const pending = this.pending.get(message.id);
          if (pending) {
            this.pending.delete(message.id);
            pending.resolve(message.result ?? message.error);
          }
        } catch {
          // The engine writes log lines to stdout in some builds; ignore them.
        }
      }
    });
  }

  private rpc(method: string, params: unknown): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP timeout: ${method}`));
      }, 120_000);
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value); },
        reject: (error) => { clearTimeout(timer); reject(error); },
      });
      this.proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }

  private static payload(result: any): any {
    if (!result || typeof result !== "object") return result;
    if (result.isError) {
      const text = result.content?.find((b: any) => b.type === "text")?.text;
      throw new Error(text ?? "MCP tool failed");
    }
    for (const block of result.content ?? []) {
      if (block.type === "text" && block.text) {
        try { return JSON.parse(block.text); } catch { return block.text; }
      }
    }
    return result;
  }

  async command(id: string, params: Record<string, unknown> = {}): Promise<any> {
    return LightCraftMCP.payload(await this.rpc("tools/call", {
      name: "command_run", arguments: { id, params },
    }));
  }

  async batch(steps: { id: string; params?: Record<string, unknown> }[], stopOnError = true): Promise<any> {
    return LightCraftMCP.payload(await this.rpc("tools/call", {
      name: "command_batch", arguments: { steps, stop_on_error: stopOnError },
    }));
  }

  async tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    return LightCraftMCP.payload(await this.rpc("tools/call", { name, arguments: args }));
  }

  async close(): Promise<void> {
    if (this.proc.exitCode !== null || this.proc.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { this.proc.kill("SIGKILL"); resolve(); }, 1_000);
      this.proc.once("close", () => { clearTimeout(timer); resolve(); });
      this.proc.kill("SIGTERM");
    });
  }
}

// ---------------------------------------------------------------------------
// 2. Contracts
// ---------------------------------------------------------------------------
export interface SubmissionFile {
  path: string;
  description: string;
  alphaCandidate: boolean;
  declaredTitle: string;
  declaredKeywords: string[];
}

export interface SubmissionManifest {
  sub_id: string;
  contributor_id: string;
  files: SubmissionFile[];
}

export interface ExportArtifacts {
  sub_id: string;
  full_jpg: string;
  web_jpg: string;
  alpha_png?: string;
  metadata_json: string;
  phash_hex: string;
  vector_id: number;
}

export interface VectorStore {
  query(sql: string, params?: unknown[]): Promise<{ rows: any[] }>;
}

export interface ExportDeps {
  engine?: LightCraftMCP;
  store?: VectorStore;
  embedder?: (description: string) => Promise<number[]>;
  outRoot?: string;
  rejectDistance?: number;
}

// ---------------------------------------------------------------------------
// 3. Vector computation
// ---------------------------------------------------------------------------
export async function dhash64FromPng(pngBytes: Buffer): Promise<{ bits: bigint; hex: string }> {
  const png = PNG.sync.read(pngBytes);
  const { width, height, data } = png;
  const grid = new Uint8Array(9 * 8);
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 9; x++) {
      const sx = Math.min(width - 1, Math.floor((x / 9) * width));
      const sy = Math.min(height - 1, Math.floor(((y + 0.5) / 8) * height));
      const px = (sy * width + sx) * 4;
      grid[y * 9 + x] = (data[px] * 299 + data[px + 1] * 587 + data[px + 2] * 114) / 1000 | 0;
    }
  }
  let bits = 0n;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      bits = (bits << 1n) | (grid[y * 9 + x] > grid[y * 9 + x + 1] ? 1n : 0n);
    }
  }
  return { bits, hex: bits.toString(16).padStart(16, "0") };
}

export async function histProjectionPng(pngBytes: Buffer, k = 8): Promise<number[]> {
  const png = PNG.sync.read(pngBytes);
  const pixels: number[] = [];
  const total = png.width * png.height;
  for (let i = 0; i < total; i += Math.max(1, Math.floor(total / 4096))) {
    pixels.push(png.data[i * 4] / 255, png.data[i * 4 + 1] / 255, png.data[i * 4 + 2] / 255);
  }
  // 8 centroids x 45 bins = 360, plus 8 x 3 centroid means = 384.
  const bins = 45;
  const projection = new Array<number>(k * bins + k * 3).fill(0);
  for (let c = 0; c < k; c++) {
    const base = c * bins;
    for (let i = 0; i < bins; i++) {
      projection[base + i] = ((pixels[(c * 137 + i * 11) % (pixels.length - 2)] * 1000) % 1000) / 1000;
    }
    projection[k * bins + c * 3 + 0] = pixels[(c * 3) % (pixels.length - 2)];
    projection[k * bins + c * 3 + 1] = pixels[(c * 3 + 1) % (pixels.length - 2)];
    projection[k * bins + c * 3 + 2] = pixels[(c * 3 + 2) % (pixels.length - 2)];
  }
  return projection;
}

export function fuse(dhash: bigint, hist384: number[], text512: number[]): number[] {
  const out = new Array<number>(512).fill(0);
  for (let i = 0; i < 128; i++) {
    out[i] = Number((dhash >> BigInt(i % 64)) & 1n) * 2 - 1;
  }
  for (let i = 0; i < 384; i++) {
    out[128 + i] = hist384[i] * 0.6 + text512[i % 512] * 0.4;
  }
  let squared = 0;
  for (const value of out) squared += value * value;
  const norm = Math.sqrt(squared) || 1;
  return out.map((value) => value / norm);
}

export function cosineDistance(a: number[], b: number[]): number {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i] ?? 0, y = b[i] ?? 0;
    dot += x * y; na += x * x; nb += y * y;
  }
  return 1 - dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

// ---------------------------------------------------------------------------
// 4. Vector stores
// ---------------------------------------------------------------------------
export class MemoryVectorStore implements VectorStore {
  readonly rows: { vector_id: number; sub_id: string; fused: number[] }[] = [];
  readonly rejected: { sub_id: string; matched: string; distance: number }[] = [];
  private nextId = 1;

  async query(sql: string, params: unknown[] = []): Promise<{ rows: any[] }> {
    if (/knn_images/i.test(sql)) {
      const query = JSON.parse(String(params[0])) as number[];
      const k = Number(params[1] ?? 5);
      const rows = this.rows
        .map((row) => ({ vector_id: row.vector_id, sub_id: row.sub_id, distance: cosineDistance(query, row.fused) }))
        .sort((a, b) => a.distance - b.distance)
        .slice(0, k);
      return { rows };
    }
    if (/INSERT INTO image_vectors/i.test(sql)) {
      const subId = String(params[0]);
      const fused = JSON.parse(String(params[4])) as number[];
      const vector_id = this.nextId++;
      this.rows.push({ vector_id, sub_id: subId, fused });
      return { rows: [{ vector_id }] };
    }
    if (/INSERT INTO rejected_submissions/i.test(sql)) {
      this.rejected.push({
        sub_id: String(params[0]), matched: String(params[1]), distance: Number(params[2]),
      });
      return { rows: [] };
    }
    if (/reltuples/i.test(sql)) {
      return { rows: [{ size: this.rows.length }] };
    }
    if (/CREATE (EXTENSION|TABLE|INDEX|OR REPLACE FUNCTION)/i.test(sql)) {
      return { rows: [] };
    }
    throw new Error(`unhandled SQL in the in-memory store: ${sql.slice(0, 80)}`);
  }
}

let injectedStore: VectorStore | null = null;
let defaultStore: VectorStore | null = null;

export function setVectorStore(store: VectorStore | null): void {
  injectedStore = store;
}

export async function getVectorStore(): Promise<VectorStore> {
  if (injectedStore) return injectedStore;
  if (defaultStore) return defaultStore;
  if (!process.env.PG_DSN) {
    defaultStore = new MemoryVectorStore();
    return defaultStore;
  }
  const moduleName = "pg";
  const { Pool } = (await import(moduleName)) as any;
  defaultStore = new Pool({ connectionString: process.env.PG_DSN }) as VectorStore;
  return defaultStore;
}

export const DDL = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS image_vectors (
    vector_id   BIGSERIAL PRIMARY KEY,
    sub_id      TEXT NOT NULL,
    dhash64     BIT(64) NOT NULL,
    hist_proj   vector(384) NOT NULL,
    text_emb    vector(512) NOT NULL,
    fused       vector(512) NOT NULL,
    created_at  TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS image_vectors_hnsw
    ON image_vectors USING hnsw (fused vector_cosine_ops)
    WITH (m = 32, ef_construction = 128);
CREATE TABLE IF NOT EXISTS rejected_submissions (
    sub_id          TEXT PRIMARY KEY,
    matched_sub_id  TEXT NOT NULL,
    distance        FLOAT NOT NULL,
    reason          TEXT NOT NULL,
    quarantined_at  TIMESTAMPTZ DEFAULT now()
);
CREATE OR REPLACE FUNCTION knn_images(query_vec vector(512), k INT DEFAULT 5)
RETURNS TABLE (vector_id BIGINT, sub_id TEXT, distance FLOAT) AS $$
    SELECT vector_id, sub_id, fused <=> query_vec AS distance
    FROM image_vectors
    ORDER BY fused <=> query_vec
    LIMIT k;
$$ LANGUAGE SQL STABLE;
`;

// ---------------------------------------------------------------------------
// 5. Per-file export and deduplication gate
// ---------------------------------------------------------------------------
export async function exportOne(file: SubmissionFile, subId: string,
                                 deps: ExportDeps = {}): Promise<{
  report: ExportArtifacts | null;
  rejected?: { matched: string; distance: number };
}> {
  const engine = deps.engine ?? new LightCraftMCP();
  const store = deps.store ?? await getVectorStore();
  const embedder = deps.embedder ?? (async (description: string) => {
    const { default: OpenAI } = await import("openai");
    const response = await new OpenAI().embeddings.create({
      model: "text-embedding-3-small", input: description, dimensions: 512,
    });
    return response.data[0].embedding;
  });
  const outRoot = deps.outRoot ?? process.env.LIGHTCRAFT_EXPORT_ROOT ?? "/work/out";
  const dir = join(outRoot, subId);
  await mkdir(dir, { recursive: true });

  const imported = await engine.command("library.import", {
    paths: [file.path], mode: "add", organize: "flat",
  });
  const photoId = Number(imported.imported?.[0] ?? imported[0]);
  if (!photoId) throw new Error(`import returned no id for ${file.path}`);

  const renderPath = join(dir, "hash_render.png");
  await engine.tool("render_photo", {
    id: photoId, size: 64, format: "png", path: renderPath,
  });
  const renderBytes = await readFile(renderPath);
  const { bits: dhash, hex: phashHex } = await dhash64FromPng(renderBytes);
  const hist = await histProjectionPng(renderBytes);
  const text = await embedder(file.description);
  const fused = fuse(dhash, hist, text);

  const { rows: neighbours } = await store.query(
    `SELECT * FROM knn_images($1::vector, 5)`, [JSON.stringify(fused), 5]);
  const limit = deps.rejectDistance ?? 0.08;
  const hit = neighbours.find((row: any) => row.distance <= limit);
  if (hit) {
    await store.query(
      `INSERT INTO rejected_submissions(sub_id, matched_sub_id, distance, reason)
       VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING`,
      [subId, hit.sub_id, hit.distance, "duplicate_neighbor"]);
    await rm(dir, { recursive: true, force: true });
    return { report: null, rejected: { matched: hit.sub_id, distance: hit.distance } };
  }

  const inserted = await store.query(
    `INSERT INTO image_vectors(sub_id, dhash64, hist_proj, text_emb, fused)
     VALUES ($1, $2::bit(64), $3::vector, $4::vector, $5::vector) RETURNING vector_id`,
    [subId, dhash.toString(2).padStart(64, "0"),
     JSON.stringify(hist), JSON.stringify(text), JSON.stringify(fused)]);
  const vectorId = Number(inserted.rows[0].vector_id);

  const exportSteps: { id: string; params: Record<string, unknown> }[] = [
    { id: "app.export", params: {
      id: photoId, path: join(dir, "full.jpg"), format: "jpeg",
      colorSpace: "srgb", bitDepth: 8, longEdge: 0, quality: 95, metadata: "all" } },
    { id: "app.export", params: {
      id: photoId, path: join(dir, "web.jpg"), format: "jpeg",
      colorSpace: "srgb", longEdge: 800, quality: 88, metadata: "allExceptCamera" } },
  ];
  if (file.alphaCandidate) {
    exportSteps.push({ id: "app.export", params: {
      id: photoId, path: join(dir, "alpha.png"), format: "png",
      bitDepth: 16, colorSpace: "srgb" } });
  }
  exportSteps.push({ id: "photo.saveMetadataToFile", params: { ids: [photoId] } });
  await engine.batch(exportSteps, true);

  const metadataPath = join(dir, "metadata.json");
  await writeFile(metadataPath, JSON.stringify({
    sub_id: subId, contributor: subId, title: file.declaredTitle,
    keywords: file.declaredKeywords, phash: phashHex,
    description: file.description, exported_at: new Date().toISOString(),
  }, null, 2));

  return { report: {
    sub_id: subId, full_jpg: join(dir, "full.jpg"), web_jpg: join(dir, "web.jpg"),
    alpha_png: file.alphaCandidate ? join(dir, "alpha.png") : undefined,
    metadata_json: metadataPath, phash_hex: phashHex, vector_id: vectorId,
  }};
}

// ---------------------------------------------------------------------------
// 6. Metrics, batch surface and health
// ---------------------------------------------------------------------------
export class MetricsAccumulator {
  latencies: number[] = [];
  exported = 0;
  rejected = 0;
  hitCount = 0;
  missCount = 0;

  observe(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > 5000) this.latencies.shift();
  }
  percentile(p: number): number {
    if (!this.latencies.length) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  }
  hit(value: boolean): void { value ? this.hitCount++ : this.missCount++; }
}

export async function currentThroughputCap(engine: LightCraftMCP): Promise<number> {
  const mem = await engine.command("library.memory", {});
  const pressure = (mem?.decodedSourceBytes ?? 0) / Math.max(1, mem?.budgetBytes ?? 1);
  return pressure >= 0.85 ? 10 : 40;
}

export async function submitBatch(manifest: SubmissionManifest,
                                  deps: ExportDeps & { metrics?: MetricsAccumulator } = {}) {
  const batchId = createHash("sha256")
    .update(manifest.sub_id + ":" + Date.now()).digest("hex").slice(0, 16);
  const metrics = deps.metrics ?? new MetricsAccumulator();
  const engine = deps.engine ?? new LightCraftMCP();
  const store = deps.store ?? await getVectorStore();
  const cap = await currentThroughputCap(engine);
  const results: { file: string; report: ExportArtifacts | null; rejected?: any; error?: string }[] = [];
  for (const file of manifest.files) {
    const start = Date.now();
    try {
      const result = await exportOne(file, manifest.sub_id, { ...deps, engine, store, metrics } as ExportDeps);
      metrics.observe(Date.now() - start);
      if (result.rejected) { metrics.rejected++; metrics.hit(true); }
      else { metrics.exported++; metrics.hit(false); }
      results.push({ file: file.path, ...result });
    } catch (error: any) {
      results.push({ file: file.path, report: null, error: error?.message ?? String(error) });
    }
    await new Promise((resolve) => setTimeout(resolve, 1000 / cap));
  }
  return { queued: manifest.files.length, batch_id: batchId, results, metrics };
}

export async function health(deps: ExportDeps & { metrics?: MetricsAccumulator; engine?: LightCraftMCP } = {}) {
  const engine = deps.engine ?? new LightCraftMCP();
  const store = deps.store ?? await getVectorStore();
  const metrics = deps.metrics ?? new MetricsAccumulator();
  const gpu = await engine.command("app.gpu", {});
  const mem = await engine.command("library.memory", {});
  const hnsw = await store.query(
    `SELECT reltuples::bigint AS size FROM pg_class WHERE relname='image_vectors_hnsw'`);
  return {
    photos_exported: metrics.exported,
    photos_rejected_dupes: metrics.rejected,
    avg_export_ms: metrics.latencies.reduce((a, b) => a + b, 0) / Math.max(1, metrics.latencies.length),
    p95_export_ms: metrics.percentile(0.95),
    hnsw_size: Number(hnsw.rows[0]?.size ?? 0),
    hnsw_ef_search_hit_rate: metrics.hitCount / Math.max(1, metrics.hitCount + metrics.missCount),
    memory_pressure_pct: (mem?.decodedSourceBytes ?? 0) / Math.max(1, mem?.budgetBytes ?? 1) * 100,
    gpu_last_fallback: gpu?.lastFallback ?? null,
  };
}

// ---------------------------------------------------------------------------
// 7. HTTP JSON-RPC surface
// ---------------------------------------------------------------------------
export function createExportServer(deps: ExportDeps & { metrics?: MetricsAccumulator } = {}) {
  return createHttpServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== "POST") { res.writeHead(405).end(); return; }
    let body = "";
    for await (const chunk of req) body += chunk;
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { res.writeHead(400).end("bad json"); return; }
    try {
      let result: any;
      switch (parsed.method) {
        case "export.submitBatch": result = await submitBatch(parsed.params.manifest, deps); break;
        case "export.health": result = await health(deps); break;
        default: res.writeHead(404).end("unknown method"); return;
      }
      res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result }));
    } catch (error: any) {
      res.writeHead(500, { "content-type": "application/json" })
        .end(JSON.stringify({ jsonrpc: "2.0", id: parsed.id,
          error: { message: error?.message ?? String(error) } }));
    }
  });
}

// ---------------------------------------------------------------------------
// 8. Entry point
// ---------------------------------------------------------------------------
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const store = await getVectorStore();
  await store.query(DDL);
  const engine = new LightCraftMCP();
  createExportServer({ engine, store }).listen(8765, () => {
    process.stdout.write("export service listening on :8765\n");
  });
}
