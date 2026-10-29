# 9. Exercise 5: Headless Batch Export Orchestrator with HNSW Deduplication — solution

The worked export service. It combines a warm LightCraft MCP session with a
vector store, rejects a submission before any full-size encode when a near
neighbor is already indexed, and exports only the survivors.

## What it does

1. Imports the submission with `library.import`, then renders a 64 px frame.
2. Fuses three signals into one 512-d vector: a 64-bit difference hash, a
   deterministic 384-d colour/histogram projection and a 512-d
   text-embedding of the contributor's description.
3. Queries `knn_images` before writing any output. A neighbor within the
   rejection radius writes a `rejected_submissions` row, removes the
   temporary directory and produces no exports.
4. A survivor is recorded with its fused vector, then exported through one
   batch: full JPEG, web JPEG, optional 16-bit alpha PNG and an XMP
   metadata write.
5. `health()` reports exported/rejected counts, p95 latency, HNSW size,
   memory pressure and the last GPU fallback.
6. The HTTP surface answers `export.health` and `export.submitBatch` with
   JSON-RPC 2.0.
7. The harness injects a real LightCraft session, a deterministic text
   embedder and `MemoryVectorStore`, which implements the same kNN and
   insert SQL as the pgvector sidecar. It stages one accepted image, one
   perceptual near-duplicate and one distinct image.

## Run it

```bash
cd chapter9/solutions_and_explanations/exercise_5_headless-batch-export-orchestrator-with-hnsw-accelerated-deduplication-gate/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex5.ts
```

The engine CLI must be on `PATH`:

```bash
export PATH="/path/to/repo/tools/craft-cli/bin:$PATH"
```

```
46 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/sources/submission-a.png` | the first accepted source |
| `output/sources/submission-a-copy.png` | the perceptual near-duplicate |
| `output/sources/submission-b.png` | a distinct accepted source |
| `output/exports/sub-a/full.jpg` | full-resolution JPEG |
| `output/exports/sub-a/web.jpg` | 800 px web JPEG |
| `output/exports/sub-a/alpha.png` | 16-bit PNG for the alpha candidate |
| `output/exports/sub-a/metadata.json` | title, keywords, pHash and description |
| `output/exports/sub-b/full.jpg` | second survivor, full JPEG |
| `output/exports/sub-b/web.jpg` | second survivor, web JPEG |
| `output/exports/sub-b/metadata.json` | second metadata record |
| `output/library/` | the real LightCraft catalog after the imports |
| `output/report.json` | batch ids, exported/rejected counts, health and artifacts |
| `output/run_ex5.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/05_headless_batch_export_orchestrator_with_hnsw_deduplication.ts` | MCP client, vector maths, stores, export gate, metrics, health and HTTP server |
| `files/run_ex5.ts` | the acceptance harness: vector units, three real exports, dedup rejection and HTTP health |

## Notes

- The service is import-safe: the LightCraft child and the HTTP listener are
  created only when the module is run directly.
- `MemoryVectorStore` is a first-class test implementation, not a mock of the
  service logic: the same cosine scan and rejection SQL are exercised.
- Production switches to pgvector by setting `PG_DSN`; the SQL and thresholds
  are unchanged.
- Type-check it with `npm run check`.
