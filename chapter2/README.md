# Chapter 2 — Inside the ArtCraft Architecture - 256² Sparse Tiles, Dual Compositors, and 500+ Command Registries

The engine is not a black box, and this chapter opens it. Documents are cut
into 256×256 sparse tiles, two compositors render them (one for the
viewport, one for export), and more than five hundred commands address the
model. The code measures all three claims instead of taking them on faith.

The chapter starts with a hello-world that prints the architecture it is
about to use, then builds a seven-module factory — session, registry, tile
delta, dual compositor, supervisor, asset store, factory — that runs a
production job end to end. The exercises audit parity between the two
compositors, measure the memory a sparse edit actually touches, map the
command registry, resolve an asset across four suites, and drive a vision
model over the TCP loopback channel.

## The projects

Each project has its own README with the command to run it and the
artifacts it writes.

| project | what it is |
| --- | --- |
| [Advanced Application Implementation](advanced_application_implementation/example/) | A headless banner factory: a tenant brief goes in, a layered document is planned by worker agents, executed as tile-delta batches, reconciled… |
| [Basic Code Example](basic_code_example/example/) | The smallest program that still exercises every pillar of the ArtCraft runtime: the 256² sparse tile store, the command registry, multi-step… |
| [Solutions and Explanations](solutions_and_explanations/exercise_1_sparse-tile-memory-delta-harness-for-interactive-undo-budgets/) | The worked solutions for Exercises 1–5, each with an acceptance harness: sparse-tile deltas, dual-compositor parity, the authenticated loopback agent, the registry topology map and the four-suite bundle. |

## What you need

Node.js 22.5+, Python 3.10+ and the engine binaries — or just Docker. The
root README sets out both paths and the one-time setup:
[what you need](../README.md#what-you-need) and
[install](../README.md#install).

## Run everything

```bash
./chapter2/run_all.sh
```

The script runs every harness in the chapter, prints one line per
harness, and exits non-zero if any of them fails. Each harness leaves
its log in the `output/` directory of the project it exercises.

To run a single project, open its README: it gives the exact command
and the environment that command needs.

## Notes on the engines

- **Native macOS CLIs**, from `tools/craft-cli/bin`; no Docker.
- **One `node_modules` for the whole repository.** Each project's
  `node_modules` is a symlink to the root — the same MCP SDK and `tsx`, not
  ninety copies.
- **LLM calls** go through OpenRouter with a stdlib client. The key lives in
  `tools/secrets.env` (`OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL`, optional
  `OPENROUTER_VISION_MODEL`). With no key, the vision exercise falls back to a
  deterministic luma heuristic and still converges.
- **Python 3.10+**, standard library only. The runner picks the repository
  `.venv` when it exists.
