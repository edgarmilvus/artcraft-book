# 20. Basic Code Example

The studio's "Hello World": a minimal campaign pipeline that validates a
manifest, renders a hero banner via PhotoCraft, writes a campaign-state
JSON, and proves the brand memory (SQLite + HNSW) works. It is the
composition root the capstone builds on.

## What it does

The pipeline is split into modules that mirror the capstone:

- `src/env.ts` — turn the process environment into a typed config.
- `src/dbClient.ts` — the runtime half of the brand memory (SQLite + HNSW).
- `src/brandMemory.ts` — the vector-memory module: embedding model + query.
- `src/photocraftBridge.ts` — the PhotoCraft MCP bridge (lifecycle, retries).
- `src/pipeline.ts` — orchestration: validate manifest → render banner →
  write state.
- `src/main.ts` — entry point: parse CLI → run pipeline → exit code.

The published test (`test/pipeline.test.ts`) runs the pipeline end-to-end
and asserts the output banner exists, the state JSON is valid, and the
brand memory returns the embedded banner on query.

## The listings

| file | what it is |
| --- | --- |
| `01_project_layout.txt` | the project directory tree |
| `02_package_json.json` | `package.json` |
| `03_src_env_ts_the_environment_modul.ts` | `src/env.ts` — environment → typed config |
| `04_src_dbclient_ts_the_local_store.ts` | `src/dbClient.ts` — SQLite + HNSW runtime |
| `05_supabase_migrations_0001brandass.sql` | the pgvector schema (for production; SQLite used here) |
| `06_src_brandmemory_ts_the_vector_me.ts` | `src/brandMemory.ts` — embedding + query |
| `07_src_photocraftbridge_ts_the_mcp.ts` | `src/photocraftBridge.ts` — MCP lifecycle |
| `08_src_pipeline_ts_the_orchestratio.ts` | `src/pipeline.ts` — the orchestration |
| `09_src_main_ts_the_entry_point.ts` | `src/main.ts` — CLI entry point |
| `10_pipeline.test.ts` | `test/pipeline.test.ts` — the published test |
| `package-lock.json` | lockfile |
| `package.json` | npm scripts (`harness`, `listing:test`, `typecheck`) |
| `tsconfig.json` | TypeScript config |

## Run it

```bash
cd chapter20/basic_code_example/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_basic.ts
npx tsx --test output/work/project/test/pipeline.test.ts
```

```
the published test on its own: npx tsx --test output/work/project/test/pipeline.test.ts
```

## What it produces

| artifact | what it is |
| --- | --- |
| `files/output/work/project/src/brandMemory.ts` | generated brand memory module |
| `files/output/work/project/src/dbClient.ts` | generated DB client |
| `files/output/work/project/src/env.ts` | generated env module |
| `files/output/work/project/src/main.ts` | generated entry point |
| `files/output/work/project/src/photocraftBridge.ts` | generated bridge |
| `files/output/work/project/src/pipeline.ts` | generated pipeline |
| `output/run_basic.log` | the harness log |

## Notes

- `photocraft-cli` on `PATH`.
- SQLite (no Postgres required); the pgvector schema is for production.
- No provider keys: LLM and embedding model are injected stubs.
- The published test is the authoritative verification.
