# Chapter 6 — Automated PSD Manipulation - Layers, Clipping Masks, and OkLCh Curves via PhotoCraft MCP

The chapter drives PhotoCraft's headless engine through MCP: a layer tree
built from commands, clipping masks treated as scope rules, and
OkLCh-inspired grading expressed as curves, levels and hue/saturation
adjustment layers.

## The projects

Each project has its own README with the command to run it and the
artifacts it writes.

| project | what it is |
| --- | --- |
| [Advanced Application Implementation](advanced_application_implementation/example/) | A production worker that a SaaS web tier invokes to turn structured JSON job payloads into layered, clipping-mask-conditioned, OkLCh-graded PSD… |
| [Basic Code Example](basic_code_example/example/) | A self-contained smoke test that boots photocraft-cli mcp over stdio, creates a document, adds a curves adjustment layer, places an image under a… |
| [Solutions and Explanations](solutions_and_explanations/exercise_1_e-commerce-banner-assembly-with-clipping-mask-discipline-and-contract-layer-nami/) | The worked answer to the chapter's first exercise: a batch assembler that turns a list of SKU specs into layered PSDs that satisfy a versioned… |

## What you need

Node.js 22.5+, Python 3.10+ and the engine binaries — or just Docker. The
root README sets out both paths and the one-time setup:
[what you need](../README.md#what-you-need) and
[install](../README.md#install).

## Run everything

```bash
./chapter6/run_all.sh
```

The script runs every harness in the chapter, prints one line per
harness, and exits non-zero if any of them fails. Each harness leaves
its log and its evidence files — PSDs, renders, audit reports and JSON
summaries — in the `output/` directory of the project it exercises.

To run a single project, open its README: it gives the exact command
and the environment that command needs.

## Notes on the exercises

- **`command_batch` is one round-trip but not a transaction.** A step
  cannot read a previous step's reply, so a pipeline that needs ids from
  the engine splits into create → `doc_inspect` → second batch. A failed
  step keeps what already ran.
- **Clipping mask and layer mask are different commands.** `clipToPrevious`
  restricts a layer to the non-transparent area below it; a layer mask
  multiplies alpha by a grayscale raster. A layer mask issued where a
  clipping mask was intended succeeds and looks plausible, which is why
  `doc_inspect` reports `clipped` and `hasMask` per layer.
- **The write root is canonicalized.** A symlink inside the root that
  points outside is refused on save; resolve output paths against the root
  and check that the relative path does not start with `..`.
- **`doc_save` overwrites without warning.** Give each run a unique output
  name, or a retry will replace the previous artifact.
- **Batch parameters come from the binary, not the prose.** When a
  `command_run` reports an unknown parameter, `command_list` with a filter
  returns the schema the running engine actually exposes.
