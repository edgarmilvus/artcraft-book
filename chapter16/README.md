# Chapter 16 — Automated Editorial Publishing - Spreads, Threaded Frames, and Knuth-Plass Typography in DesignCraft

The chapter drives DesignCraft's headless engine to build a paginated
magazine: it creates the document, folds the spreads, threads the stories
across the frames, installs the type styles, and exports a tagged PDF, an
EPUB and a self-contained HTML page.

## The projects

Each project has its own README with the command to run it and the
artifacts it writes.

| project | what it is |
| --- | --- |
| [Advanced Application Implementation](advanced_application_implementation/example/) | A publish-job pipeline for an editorial SaaS. |
| [Basic Code Example](basic_code_example/example/) | A self-contained "Hello World" for the DesignCraft MCP server. |
| [Solution — Exercise 1](solutions_and_explanations/exercise_1_nightly-magazine-build-with-autonomous-unmapped-asset-recovery/) | The worked nightly build: three asset tiers, frozen styles, degraded layout and a signed sidecar. |
| [Solution — Exercise 2](solutions_and_explanations/exercise_2_baseline-grid-vertical-rhythm-across-twelve-spreads/) | The worked twelve-spread grid QA: half-line invariant, measured line map and assertion. |
| [Solution — Exercise 3](solutions_and_explanations/exercise_3_knuth-plass-typographic-qa-with-a-vision-model-feedback-loop/) | The worked typographic QA: cascade-safe fixes, vision metrics and snapshot restore. |
| [Solution — Exercise 4](solutions_and_explanations/exercise_4_print-and-digital-dual-export-with-a-preflight-gate/) | The worked dual export: date-stable PDF, EPUB and the transactional preflight gate. |
| [Solution — Exercise 5](solutions_and_explanations/exercise_5_template-rebind-style-map-and-thread-rewiring-from-a-legacy-idml/) | The worked IDML rebind: style map, eight threads, fonts and grid port. |

## What you need

Node.js 22.5+, Python 3.10+ and the engine binaries — or just Docker. The
root README sets out both paths and the one-time setup:
[what you need](../README.md#what-you-need) and
[install](../README.md#install).

## Run everything

```bash
./chapter16/run_all.sh
```

The script runs every harness in the chapter, prints one line per
harness, and exits non-zero if any of them fails. Each harness leaves
its log in the `output/` directory of the project it exercises.

To run a single project, open its README: it gives the exact command
and the environment that command needs.

## Notes on the engine

The details that will bite you first:

- **The meta-tools have different names** — `execute`, `batch`,
  `inspect_document`, `get_story`, `new_document`, `save_document`,
  `render_page`, not `command_run` / `doc_inspect`.
- **A batch stops at the first failure** and keeps what already ran —
  there is no `stop_on_error` and no rollback.
- **`designcraft-cli mcp` takes no sandbox roots** — only `--connect PORT`
  and `--sample`. The worker owns the filesystem boundary.
- **`keepWithNext` is a number, `keepLinesTogether` is a boolean** — the
  style schema is asymmetric and rejects the other spelling of each.
- **`layout.section`'s numbering style is `arabic`** — `decimal` is not
  in the enum.
- **The exported PDF is stamped with the wall clock** — `/ModDate`,
  `/CreationDate`, the XMP dates and the document id all change between
  runs, so a byte-reproducible export has to rewrite them.
