# 9. Advanced Application Implementation

A production-shaped RAW delivery worker. It ingests a staged folder into a
LightCraft catalog, optionally merges brackets, culls each burst, applies a
32-bit float linear grade, queues denoise and exports every delivery tier the
platform bills for — then returns a report and a catalog snapshot for the
job ledger.

Every stage is idempotent and resumable, and the MCP session is always
closed, including on failure, so a Kubernetes pod cannot leak handles.

## What it does

`RawPipeline.run()` validates its envelope with `PipelineConfigSchema`,
spawns `lightcraft-cli mcp` with the library folder as `--library`, and runs
six stages, timing each one:

| stage | work |
| --- | --- |
| `stageImport` | `library.import` in `copy` mode, with a dated destination tree, a rename template, the tenant metadata preset and the delivery album |
| `stageHdrMerge` | `merge.hdr` for bracketed sets, skipped unless the job asks for it |
| `stageCull` | `photo.analyze` and the burst stack, then picks and rejects |
| `stageGrade` | the 32-bit float linear graph, applied through begin/end interaction so the grade is one undo step |
| `stageDenoise` | queued on the graded picks |
| `stageExport` | one `export` per tier, each with its own format, bit depth, color space and long edge |

`stageImport` is where deduplication happens: the report carries `imported`
and `duplicates`, and a re-run of the same staging folder imports nothing new.
The final `inspect()` snapshot is the idempotency key recorded with the
delivery.

## The listings

| file | what it is |
| --- | --- |
| `01_lightcraft-raw-pipeline.ts` | the configuration schema, the typed `LightCraftClient`, the retry/backoff wrapper and the result types |
| `02_advanced_application_implementat.ts` | the six pipeline stages and the `timed()` helper |
| `03_advanced_application_implementat.ts` | the orchestrator: `RawPipeline`, the stage order, the snapshot and `handleDeliveryJob()` |
| `04_ingest_contract.py` | the Python-side MCP contract: the call shapes and the face-row schema |
| `05_vector_setup.sql` | the `photo_faces` table, its HNSW index and the `knn_faces` function |
| `06_practical_exercises.sh` | the launch line the exercises build against |
| `run_forge.ts` | the harness: a staged folder, the pipeline, the report and the delivered file |
| `package.json` | the project's scripts and dependencies |
| `tsconfig.json` | the TypeScript target |

## Run it

```bash
cd chapter9/advanced_application_implementation/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_forge.ts
```

The harness writes four staged photos, runs the pipeline twice — the second
time to prove the import is idempotent — and checks both the report and the
delivery folder:

```
# the report
PASS report: the event date survives
PASS report: the album survives
PASS report: the burst was re-imported, not duplicated
PASS report: the four photos were already in the library
PASS report: at least one frame was picked
PASS report: one export tier ran
PASS report: the HDR stage was skipped

# the delivery
PASS delivery: the export is a JPEG
PASS delivery: the file has a JPEG header

# the library
PASS library: the catalog holds the photos

20 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `files/output/staging/frame-0.png` | the four staged sources, `frame-0.png` to `frame-3.png` |
| `files/output/library/` | the catalog the engine opened: `catalog.snap`, `catalog.log`, `catalog.lock` and `view.json` |
| `files/output/delivery/web/20260314_0001_web.jpg` | the `web_preview` tier export |

## Notes

- **`lightcraft-cli` must be on `PATH`.** LightCraft has no automation
  roots: the library is opened with `--library` and the engine reads the
  files the import tool is given.
- **The run is local.** The harness generates its own photos; no RAW camera
  files, model or network are required.
- **Re-running is the point.** The second run reports four duplicates and
  still produces the delivery, which is the idempotency contract in action.
- **`npx tsx`, not `node`.** The listings are TypeScript with `.js`
  specifiers.
- Type-check it with `npm run check` (which is `tsc --noEmit`).
