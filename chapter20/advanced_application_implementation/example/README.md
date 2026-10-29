# 20. Advanced Application Implementation

The Autonomous Creative Studio capstone: a multi-agent system that authors
a campaign, renders it with the ArtCraft engines, audits it, and publishes
it — headless, reproducible, and governed. The pipeline is a single
TypeScript entry point (`src/13_main.ts`) that composes 12 modules and a
Python live bridge.

## What it does

The studio runs as a single job:

1. **Copywriter** — LLM generates copy from a campaign brief (structured
   JSON: audience, tone, key messages, CTA).
2. **Visual** — drives PhotoCraft, VectorCraft, DesignCraft to produce
   hero image, logo variants, layout assets.
3. **Motion** — drives EffectCraft, FilmCraft to produce lower-thirds,
   transitions, trailer.
4. **Publisher** — drives PdfCraft, WordCraft to produce PDF/A delivery
   sheet, DOCX brief.
5. **Auditor** — vision model audits every render against brand rules;
   failed renders are re-queued with corrections.
6. **Orchestrator** — the composition root: it wires the agents, manages
   the job budget, enforces the audit gate, and emits the campaign bundle.

The Python live bridge (`python/14_live_bridge.py`) exposes the studio as
an MCP server so an IDE agent (Cursor, Claude Code, OpenCode) can drive it
interactively.

## The listings

| file | what it is |
| --- | --- |
| `01_1_package_and_build_configuratio.jsonc` | `package.json` |
| `02_1_package_and_build_configuratio.jsonc` | `tsconfig.json` |
| `03_craft-client.ts` | MCP client wrapper for all ten engines |
| `04_types.ts` | wire types: `Campaign`, `Job`, `Asset`, `AuditResult`, `Budget` |
| `05_store.ts` | brand memory: vector store (SQLite + HNSW) + embedding model |
| `06_budget.ts` | job budget: token budget, render budget, time budget |
| `07_copywriter.ts` | copy generation (injected LLM) |
| `08_visual.ts` | visual asset pipeline (PhotoCraft, VectorCraft, DesignCraft) |
| `09_motion.ts` | motion asset pipeline (EffectCraft, FilmCraft) |
| `10_publisher.ts` | PDF/A + DOCX delivery (PdfCraft, WordCraft) |
| `11_auditor.ts` | vision-model audit gate (injected vision model) |
| `12_orchestrator.ts` | the composition root: wires all agents, runs the job |
| `13_main.ts` | entry point: CLI parsing, env validation, run orchestrator |
| `14_live_bridge.py` | Python MCP server exposing the studio as `studio_run` tool |
| `15_practical_exercises.ts` | the manifest schema the pipeline validates before touching any engine |

## Run it

```bash
cd chapter20/advanced_application_implementation/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_forge.ts
```

```
82 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `files/output/work/<job-id>/approval-snapshot.png` | auditor approval frame |
| `files/output/work/<job-id>/banner-1920x1080.png` | hero banner |
| `files/output/work/<job-id>/campaign-bundle.pdf` | delivery PDF/A |
| `files/output/work/<job-id>/campaign-state.json` | full job state for replay |
| `files/output/work/<job-id>/copy.docx` | campaign brief (WordCraft) |
| `files/output/work/<job-id>/cta-badge-640x160.png` | CTA badge (VectorCraft) |
| `output/run_forge.log` | the harness log |

## Notes

- All ten engines on `PATH` (via `tools/craft-cli/bin`).
- No provider keys: LLM and vision model are injected functions (stubs in
  the harness).
- Brand memory is a local SQLite store with HNSW index; the embedding
  model is an injected function.
- The Python bridge needs Python 3.10+ (repo `.venv` preferred).
