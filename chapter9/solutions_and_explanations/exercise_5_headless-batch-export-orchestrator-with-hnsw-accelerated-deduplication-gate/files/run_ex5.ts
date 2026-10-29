// run_ex5.ts — acceptance harness for the batch export / dedup service.
//
// It runs the real LightCraft session through the service's injectable
// pipeline, using the in-memory vector store and a scripted text embedder,
// then checks the dedup gate and the HTTP JSON-RPC health surface.

import { strict as assert } from "node:assert";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  LightCraftMCP,
  MemoryVectorStore,
  MetricsAccumulator,
  cosineDistance,
  createExportServer,
  dhash64FromPng,
  fuse,
  health,
  histProjectionPng,
  submitBatch,
  type SubmissionManifest,
} from "./05_headless_batch_export_orchestrator_with_hnsw_deduplication.js";

const HERE = process.cwd();
const OUTPUT = resolve(HERE, "..", "output");
const SOURCES = resolve(OUTPUT, "sources");
const EXPORTS = resolve(OUTPUT, "exports");
const LIBRARY = resolve(OUTPUT, "library");

let passed = 0;
function ok(label: string, condition: boolean, detail = ""): void {
  if (!condition) {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`PASS ${label}`);
}

function equal<T>(label: string, actual: T, expected: T): void {
  ok(label, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

function makePhoto(seed: number, shift = 0): Buffer {
  const size = 1200;
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      const dx = (x + shift) % size;
      const wave = Math.sin(dx / 17) * Math.cos(y / 23) + Math.sin((dx + y) / 41);
      const value = seed >= 2
        ? (dx < size / 2 ? 34 : 226)
        : 100 + wave * (30 + seed * 45);
      png.data[i] = Math.max(0, Math.min(255, Math.round(value)));
      png.data[i + 1] = Math.max(0, Math.min(255, Math.round(value * (seed >= 2 ? 1 : 0.7 + seed * 0.1))));
      png.data[i + 2] = Math.max(0, Math.min(255, Math.round(value * (seed >= 2 ? 0.8 : 0.6))));
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function embedderFor(text: string): Promise<number[]> {
  // Deterministic 512-d text vector; the duplicate descriptions are equal.
  let seed = 17;
  for (const char of text) seed = (seed * 31 + char.charCodeAt(0)) % 1_000_003;
  return Promise.resolve(Array.from({ length: 512 }, (_, i) => {
    seed = (seed * 1103515245 + 12345) % 2147483647;
    return (seed % 2000) / 1000 - 1 + (i % 3) * 0.001;
  }));
}

async function post(port: number, body: unknown): Promise<{ status: number; json: any }> {
  const response = await fetch(`http://127.0.0.1:${port}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }
  return { status: response.status, json };
}

async function main(): Promise<void> {
  rmSync(SOURCES, { recursive: true, force: true });
  rmSync(EXPORTS, { recursive: true, force: true });
  rmSync(LIBRARY, { recursive: true, force: true });
  rmSync(resolve(OUTPUT, "report.json"), { force: true });
  mkdirSync(SOURCES, { recursive: true });
  mkdirSync(EXPORTS, { recursive: true });
  mkdirSync(LIBRARY, { recursive: true });

  const first = makePhoto(1);
  const nearDuplicate = makePhoto(1, 1);
  const distinct = makePhoto(3);
  writeFileSync(resolve(SOURCES, "submission-a.png"), first);
  writeFileSync(resolve(SOURCES, "submission-a-copy.png"), nearDuplicate);
  writeFileSync(resolve(SOURCES, "submission-b.png"), distinct);

  console.log("\n# vector units");
  const hashA = await dhash64FromPng(first);
  const hashA2 = await dhash64FromPng(nearDuplicate);
  const hashB = await dhash64FromPng(distinct);
  const differingBits = (BigInt("0x" + hashA2.hex) ^ BigInt("0x" + hashA.hex)).toString(2)
    .split("").filter((bit) => bit === "1").length;
  ok("dhash: a near duplicate stays within two bits", differingBits <= 2, `${differingBits}`);
  ok("dhash: a distinct image differs", hashB.hex !== hashA.hex);
  const hist = await histProjectionPng(first);
  equal("histogram: 384 dimensions", hist.length, 384);
  const text = await embedderFor("same description");
  const fused = fuse(hashA.bits, hist, text);
  equal("fuse: 512 dimensions", fused.length, 512);
  const norm = Math.sqrt(fused.reduce((sum, value) => sum + value * value, 0));
  ok("fuse: L2-normalised", Math.abs(norm - 1) < 1e-9, `${norm}`);
  ok("cosine: identical vectors are zero", Math.abs(cosineDistance(fused, fused)) < 1e-12,
     `${cosineDistance(fused, fused)}`);

  const metrics = new MetricsAccumulator();
  ok("metrics: empty p95 is zero", metrics.percentile(0.95) === 0);

  const store = new MemoryVectorStore();
  const engine = new LightCraftMCP("lightcraft-cli", LIBRARY);
  try {
    console.log("\n# batch");
    const jobs: { sub: string; file: string; description: string; alpha: boolean }[] = [
      { sub: "sub-a", file: "submission-a.png", description: "same description", alpha: true },
      { sub: "sub-a-copy", file: "submission-a-copy.png", description: "same description", alpha: false },
      { sub: "sub-b", file: "submission-b.png", description: "a different scene", alpha: false },
    ];
    const results: any[] = [];
    for (const job of jobs) {
      const manifest: SubmissionManifest = {
        sub_id: job.sub,
        contributor_id: "contributor-01",
        files: [{ path: resolve(SOURCES, job.file), description: job.description,
                  alphaCandidate: job.alpha, declaredTitle: job.sub, declaredKeywords: ["sample"] }],
      };
      const result = await submitBatch(manifest, {
        engine, store, metrics, outRoot: EXPORTS, embedder: embedderFor,
      });
      equal(`batch: ${job.sub} queued one`, result.queued, 1);
      equal(`batch: ${job.sub} batch id is 16 hex`, /^[0-9a-f]{16}$/.test(result.batch_id), true);
      results.push(...result.results);
    }
    equal("batch: two exported", results.filter((item: any) => item.report).length, 2);
    equal("batch: one rejected", results.filter((item: any) => item.rejected).length, 1);
    equal("metrics: two exported", metrics.exported, 2);
    equal("metrics: one rejected", metrics.rejected, 1);

    const accepted = results.filter((item: any) => item.report);
    const rejected = results.find((item: any) => item.rejected)!;
    equal("batch: the duplicate names the first submission", rejected.rejected.matched, "sub-a");
    ok("batch: the duplicate was never exported", !readdirSync(EXPORTS).includes("sub-a-copy"));
    equal("store: two accepted vectors", store.rows.length, 2);
    equal("store: one rejected record", store.rejected.length, 1);
    for (const item of accepted) {
      for (const key of ["full_jpg", "web_jpg", "metadata_json"] as const) {
        const path = (item.report as any)[key] as string;
        const minimum = path.endsWith("metadata.json") ? 50 : 1000;
        ok(`export: ${path.split("/").pop()} exists`, readFileSync(path).length > minimum);
      }
      if ((item.report as any).alpha_png) {
        ok("export: alpha PNG exists", readFileSync((item.report as any).alpha_png).length > 1000);
      }
    }

    console.log("\n# health and HTTP surface");
    const healthReport = await health({ engine, store, metrics });
    equal("health: exported count", healthReport.photos_exported, 2);
    equal("health: rejected count", healthReport.photos_rejected_dupes, 1);
    equal("health: HNSW size", healthReport.hnsw_size, 2);

    const server = createExportServer({ engine, store, metrics });
    await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
    const address = server.address();
    assert(address && typeof address === "object");
    try {
      const reply = await post(address.port, { jsonrpc: "2.0", id: 1, method: "export.health" });
      equal("http: health returns 200", reply.status, 200);
      equal("http: jsonrpc id", reply.json.id, 1);
      equal("http: health shape", typeof reply.json.result.photos_exported, "number");
      const unknown = await post(address.port, { jsonrpc: "2.0", id: 2, method: "export.unknown" });
      equal("http: unknown method is 404", unknown.status, 404);
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }

    const artefacts = [
      "sources/submission-a.png", "sources/submission-a-copy.png", "sources/submission-b.png",
      ...accepted.flatMap((item: any) => {
        const files = ["full.jpg", "web.jpg", "metadata.json"];
        if (item.report.alpha_png) files.push("alpha.png");
        return files.map((file) => `exports/${item.report.sub_id}/${file}`);
      }),
    ];
    for (const artefact of artefacts) {
      ok(`output: ${artefact}`, readFileSync(resolve(OUTPUT, artefact)).length > 0);
    }
    writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
      exercise: 5,
      engine: "lightcraft-cli + in-memory HNSW stand-in",
      assertions: passed + 1,
      batches: jobs.map((job) => job.sub),
      queued: results.length,
      exported: metrics.exported,
      rejected: metrics.rejected,
      rejectedRecord: store.rejected[0],
      health: healthReport,
      results: results.map((item: any) => ({
        file: item.file,
        sub_id: item.report?.sub_id ?? null,
        rejected: item.rejected ?? null,
        error: item.error ?? null,
      })),
      artefacts,
      result: "dedup gate rejected the near-duplicate before export; two survivors exported with metadata and health reported",
    }, null, 2));
    ok("output: report manifest", readFileSync(resolve(OUTPUT, "report.json")).length > 0);
  } finally {
    await engine.close();
  }

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
