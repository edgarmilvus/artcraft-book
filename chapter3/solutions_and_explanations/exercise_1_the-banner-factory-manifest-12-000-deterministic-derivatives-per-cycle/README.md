# 3. Solutions and Explanations

The worked solution for Exercise 1: a TypeScript orchestrator that turns a
SKU manifest into deterministic banner PNGs over warm MCP sessions, plus the
container and CronJob that run it at twelve thousand banners a cycle.

A bounded pool of MCP sessions per worker, one manifest, one PNG per
(SKU, palette, aspect).

## What it does

`01_orchestrator.ts` reads `manifest.json`, builds the full work list from
`rows × aspects`, and filters it to this replica's shard with
`REPLICA_INDEX` / `REPLICA_COUNT`. It then opens a pool of up to
`min(4, AVAILABLE_WORKERS)` MCP sessions and hands each worker one banner at a
time.

A banner is a fixed recipe: `file.new` with a name derived from the row
(`{campaign}_{sku}_{palette}_{aspect}`), `doc_place` for the hero as a smart
object with its crop centered on the row's focal point, one `command_batch`
carrying the palette curves and the blur so the look is a single history
entry, a wait for the document's job to leave the queue, `doc_export` to
`{campaign}_{sku}_{palette}_{aspect}_{w}x{h}.png`, and `doc_close` without
saving.

The pool exists because one session holds one document: `file.new` replaces
the active canvas, so two banners sharing a client steal each other's
document. Warmth is pooled per worker exactly like a database connection, not
shared across the shard.

Every banner emits one JSON line — `{ts, campaignUuid, sku, palette, aspect,
durationMs, bytesWritten, warmStartHit, jobId}` — and a failure emits
`{sku, reason, exitCode}` on stderr so it can be redirected to
`failures.jsonl`. `warmStartHit` is read from the session itself (`cli.warm`),
not from an environment variable, so the log cannot claim a warm hit that did
not happen.

Two other modes make the file container-friendly. `--warmup` opens a 64 × 64
document, renders an 8-px preview and closes it, which proves the CLI boots and
completes the MCP handshake inside the image. `--probe` connects, calls
`jobs_list` and `session_list`, then disconnects — that is what the Kubernetes
liveness probe runs.

On `SIGTERM` the orchestrator cancels any running job through `jobs_list` /
`jobs_cancel` and closes every session before exiting.

## The listings

| file | what it is |
| --- | --- |
| `01_orchestrator.ts` | the orchestrator: MCP client, manifest contract, `renderBanner`, the bounded pool, job draining, structured logging, `--warmup`, `--probe`, signal handling |
| `02_solutions_and_explanations.Dockerfile` | the image: a `rust` stage builds `photocraft-cli`, the runtime stage adds the fonts, runs `fc-cache`, adds a non-root `craft` user, and smoke-tests the build with `--warmup` |
| `03_cronjob.yaml` | the CronJob: four parallel completions, CPU and memory requests and limits, PVCs for assets and output, and a `--probe` liveness probe |

## Run it

```bash
cd chapter3/solutions_and_explanations/exercise_1_the-banner-factory-manifest-12-000-deterministic-derivatives-per-cycle/files
npx tsx run_ex1.ts
```

`run_ex1.ts` builds the manifest and assets, runs the orchestrator twice for
determinism, runs both shards, and reopens every PNG. It exits non-zero on a
failed assertion and writes the full transcript to `output/run_ex1.log`.

The orchestrator can also be run by hand:

```bash
OUT="$(cd ../output && pwd)"
ASSET_ROOT="$OUT/assets" OUT_ROOT="$OUT/output" \
  MANIFEST_PATH="$OUT/assets/manifest.json" npx tsx 01_orchestrator.ts
```

One line per banner, and nothing else on stdout; the quarantined row goes to
stderr:

```
{"ts":"2026-10-24T15:53:31.367Z","campaignUuid":"FW26","sku":"chair-01","palette":"autumn","aspect":"portrait","durationMs":185,"bytesWritten":13384,"warmStartHit":true,"jobId":null}
{"ts":"2026-10-24T15:53:31.368Z","campaignUuid":"FW26","sku":"chair-01","palette":"autumn","aspect":"square","durationMs":186,"bytesWritten":12198,"warmStartHit":true,"jobId":null}
{"ts":"2026-10-24T15:53:31.451Z","campaignUuid":"FW26","sku":"chair-01","palette":"autumn","aspect":"wide","durationMs":83,"bytesWritten":10193,"warmStartHit":true,"jobId":null}
```

The harness runs with `AVAILABLE_WORKERS=2`, so two sessions serve the deck.
The first banner on each paid 185–186 ms for its first render on a fresh engine;
the remaining ten measured 79–120 ms. That gap is the warm start, and it is
why the pool is created once per process rather than once per banner.

## What it produces

Paths are relative to this directory:

| artifact | what it is |
| --- | --- |
| `output/assets/manifest.json` | the work order the run reads: three good SKUs × four aspects, plus one deliberately broken row |
| `output/assets/hero.png` | the 1200 × 900 product hero every good row places |
| `output/output/FW26_chair-01_autumn_wide_1200x628.png` | the wide banner |
| `output/output/FW26_chair-02_spring_square_1080x1080.png` | the square banner |
| `output/orchestrator.stdout.log` | the twelve per-banner JSON lines |
| `output/orchestrator.stderr.log` | the one quarantined row |
| `output/run_ex1.log` | every acceptance check |
| `output/run-log.json` | check count, failures, banner count and quarantine summary |
| `output/failures.jsonl` | the same quarantined row, as the sidecar the CronJob ships |

## What the harness asserts

- the manifest expands to twelve banners (3 SKUs × 4 aspects) and each row is
  rendered once; the thirteenth row is the deliberate failure;
- every PNG exists, has the requested dimensions, and every log record's
  `bytesWritten` matches the file on disk;
- the warm-start flag is set on every banner and the two runs are
  byte-identical per `(SKU, palette, aspect)`;
- shards `0/2` and `1/2` are disjoint and their union is the full deck;
- the deliberately failing SKU is quarantined without aborting the other
  eleven banners, and the run still exits `0`;
- the Dockerfile, CronJob and orchestrator satisfy the container contract:
  non-root `craft` user, both automation roots, an 8-px warm-up through the
  MCP client, a `--probe` that calls `jobs_list` and `session_list`, four
  parallel completions, and resource limits.

The current run is 83 checks, 0 failing, 12 banners and 1 quarantined row.

## Notes

- **`photocraft-cli` must be on `PATH`.** The client spawns `photocraft-cli
  mcp` with `--automation-read-root "$ASSET_ROOT"` and
  `--automation-write-root "$OUT_ROOT"`.
- **`MANIFEST_PATH` defaults to `$ASSET_ROOT/manifest.json`**; set it
  explicitly when the manifest lives elsewhere.
- **The output paths are relative to `OUT_ROOT`**, which is also where the
  file size is read back from after each export.
- **`fc-cache` is the persistent font cache; the build warm-up is a smoke
  test.** Fonts are indexed per process, so the `--warmup` step proves the
  binary runs inside the image but bakes nothing the next process reuses. The
  `fc-cache -f` after `COPY Fonts/` is what persists.
- **The liveness probe is liveness, not readiness.** It spawns its own
  session and calls two methods; it says nothing about the orchestrator's
  pool. Gating traffic on warm readiness would need a probe of the pool
  itself.
