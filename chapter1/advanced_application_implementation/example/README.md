# 1. Advanced Application Implementation

The chapter's full production architecture for layered generation: a **recipe** is the source of truth, a compiler turns that recipe into a deterministic command plan, and a forge service executes the plan against the engine, audits the result and writes a provenance ledger. The rendered `.pcraft` is treated as a disposable artifact of the recipe — which is what makes the whole stack replayable, diffable and safe to hand to an agent.

## What it does

`src/artcraft/recipe.ts` defines the `LayeredRecipe` — a versioned, JSON-serializable description of a canvas, its source assets, its layer stack, masks, adjustment layers, type layers and variants. `src/artcraft/compiler.ts` compiles a recipe into phases of planned steps with no engine involved, so the whole "brief → commands" half is pure and testable. `src/artcraft/engine-session.ts` wraps the MCP stdio transport with bounded concurrency, per-call timeouts, normalized errors and job-aware command execution.

`src/artcraft/forge.ts` is the orchestration service: intake → compile → execute → audit → deliver. `src/artcraft/provenance.ts` hashes the sources, writes the ledger, stamps document notes and detects asset drift; `src/artcraft/audit.ts` mixes deterministic pixel probes with a bounded vision oracle. `src/artcraft/legs.ts` opens the secondary engines — FilmCraft for motion, VectorCraft for vector — each in its own session, because no engine shares a document. `src/bin/forge.ts` is the headless CLI entry point, driven by `scripts/forge.sh` from a job file.

## The listings

| file | what it is |
| --- | --- |
| `src/artcraft/recipe.ts` | the `LayeredRecipe` schema: canvas, sources, layer stack, masks, variants |
| `src/artcraft/compiler.ts` | recipe → command plan, with unresolved layer references |
| `src/artcraft/engine-session.ts` | the hardened MCP stdio session: timeouts, backpressure, job model |
| `src/artcraft/provenance.ts` | hashing, the ledger, document notes, snapshots, drift detection |
| `src/artcraft/audit.ts` | deterministic pixel probes plus a bounded multimodal audit |
| `src/artcraft/forge.ts` | the orchestration service: intake → compile → execute → audit → deliver |
| `src/artcraft/legs.ts` | the FilmCraft and VectorCraft legs |
| `src/bin/forge.ts` | the `--job` CLI entry point |
| `scripts/forge.sh` | one job, one process, capability-scoped read/write roots |
| `app/api/art/brief/route.ts` | the streaming art-direction brief (`useCompletion` on the client) |
| `app/(studio)/BriefComposer.tsx` | the studio page that consumes the streamed brief |
| `app/layout.tsx` | the root layout Next's App Router requires |
| `examples/compile-smoke.ts` | runs the pure compiler with no engine at all |
| `examples/forge-real-engine.ts` | the same pipeline against the real `photocraft-cli` |
| `examples/llm-brief.mjs` | the streaming brief, run outside Next.js |
| `examples/mcp-place.mjs` | checks what kind of layer `doc_place` creates |
| `jobs/LF-42/job.json` | the job specification: read root, write root, recipe path |
| `jobs/LF-42/setup.mjs` | writes the recipe and a local job file with real roots |
| `jobs/LF-42/recipe.json` | the generated recipe for the `LF-42` job |
| `notes/thesis.jsonc` | the master-versus-deliverable distinction, in one file |

## Run it

```bash
cd chapter1/advanced_application_implementation/example/files
npm install
npm run forge:real
```

You should see the phases execute and the run finish with a clean count:

```
[canvas] completed=1 failed=0
[layer:forge-real/bg] completed=1 failed=0
   doc_place -> layer 7, smartObject=true
[layer:forge-real/hero] completed=3 failed=0
[adjustment:forge-real/grade] completed=2 failed=0
[group:forge-real/title-block] completed=1 failed=0
[type:forge-real/title-block/headline] completed=1 failed=0
[group.arrange:forge-real/title-block] completed=1 failed=0
[variants] completed=1 failed=0
save    -> {"path":"forge-real.pcraft","warnings":[]}

TOTAL completed=11 failed=0
```

`npm run smoke` runs the same compiler with no engine and prints the plan phase by phase.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/forge-real.pcraft` | the layered document the real-engine run produced |
| `output/forge-real.png` | its 1024×576 preview |
| `output/LF-42/in/hero.png` | the source asset inside the job's read root |
| `output/LF-42/out/LF-42.pcraft` | the master document written by the CLI entry point |
| `output/LF-42/out/LF-42.provenance.json` | the provenance ledger for that job |
| `output/LF-42/out/out.png` | the flattened deliverable |
| `output/brief.txt` | the streamed art-direction brief |
| `output/http-brief.txt` | the same brief, captured from the HTTP route |
| `output/run-log.json` | the per-run record |
| `output/run_smoke.log`, `output/run_forge.log`, `output/run_ledger.log` | the compiler and real-engine logs |

## Notes

- `photocraft-cli` must be on `PATH`; `PHOTOCRAFT_BIN` overrides the binary name.
- The CLI entry point needs the job files that the chapter does not ship, so run
  `node jobs/LF-42/setup.mjs` first, then
  `PHOTOCRAFT_BIN=photocraft-cli bash scripts/forge.sh jobs/LF-42/job.local.json`.
- `examples/llm-brief.mjs` needs `OPENROUTER_API_KEY`; the route reads
  `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL` and
  `OPENAI_MAX_OUTPUT_TOKENS` instead.
- `npm run typecheck` runs `tsc --noEmit` over the project.
- The real-engine run is deterministic: the same recipe produces the same
  document and the same preview.
