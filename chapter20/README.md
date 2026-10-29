# Chapter 20 — Capstone Project - The Autonomous Creative Studio: An End-to-End Multimodal Marketing and Publishing Engine

The chapter assembles the whole book: a multi-agent studio that authors a
campaign, renders it with the ArtCraft engines, audits it, and publishes it
— headless, reproducible, and governed.

## The projects

Each project has its own README with the command to run it and the
artifacts it writes.

| project | what it is |
| --- | --- |
| [Advanced Application Implementation](advanced_application_implementation/example/) | The Autonomous Creative Studio capstone: a multi-agent system that authors a campaign, renders it with the ArtCraft engines, audits it, and… |
| [Basic Code Example](basic_code_example/example/) | The studio's "Hello World": a minimal campaign pipeline that validates a manifest, renders a hero banner via PhotoCraft, writes a campaign-state… |
| [Solution — Exercise 1](solutions_and_explanations/exercise_1_the-banner-factory-campaign-kickoff-to-published-asset/) | The worked banner factory: manifest, product shots, three channels and replayable trace. |
| [Solution — Exercise 2](solutions_and_explanations/exercise_2_the-multimodal-aesthetic-feedback-loop-closing-the-loop-between-tcp-auth-ui-scre/) | The worked colorist loop: authenticated control channel, bounded nudges and rollback. |
| [Solution — Exercise 3](solutions_and_explanations/exercise_3_autonomous-trailer-assembly-ripple-aware-tempo-synced-editing-in-filmcraft-via-m/) | The worked trailer: beat grid, ripples, transitions, ducking and loudness. |
| [Solution — Exercise 4](solutions_and_explanations/exercise_4_the-single-source-of-truth-publishing-pipeline-designcraft-pdfcraft-and-wordcraf/) | The worked publish pipeline: PDF/A brochure, DOCX review and HTML summary from one manifest. |
| [Solution — Exercise 5](solutions_and_explanations/exercise_5_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a/) | The worked self-healing campaign: repair, degrade, escalate, budget and security gates. |

## What you need

Node.js 22.5+, Python 3.10+ and the engine binaries — or just Docker. The
root README sets out both paths and the one-time setup:
[what you need](../README.md#what-you-need) and
[install](../README.md#install).

## Run everything

```bash
./chapter20/run_all.sh
```

The script runs every harness in the chapter, prints one line per
harness, and exits non-zero if any of them fails. Each harness leaves
its log in the `output/` directory of the project it exercises.

To run a single project, open its README: it gives the exact command
and the environment that command needs.

## No key, no server, no network

The studio runs with an empty environment. The brand memory is a local
store over the same rows the pgvector schema declares, the embedding
model is an injected function, and the language model is an injected
closure — the production paths (`text-embedding-3-small`, a hosted model)
are preserved in the listings as comments and as the production DDL.

## Notes on the engines

The details that will bite you first:

- **The suite does not speak a uniform dialect** — `command_run` on
  PhotoCraft, `execute` on DesignCraft, `execute_command` on EffectCraft,
  `run_command` on DeckCraft.
- **Only four binaries take the sandbox flags** — and DesignCraft,
  EffectCraft, LightCraft and WordCraft have no filesystem confinement at
  all, so the worker owns the boundary for those.
- **`doc_save` needs a granted write root** and rejects absolute paths.
- **`ui_screenshot` is bridge-mode only** — headless, the sensor is
  `doc_render_preview`.
- **PhotoCraft requires the MCP `initialize` handshake**; the other three
  office engines do not.
- **A `batch` is a grouping, not a transaction** — there is no rollback.
