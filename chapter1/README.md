# Chapter 1 — The Death of Flat Generative Pixels - Why Production Demands Layered, Non-Destructive Creative Engines

A generative image is a dead end: once the pixels are flattened, every
revision costs another generation. This chapter builds the alternative. The
code drives PhotoCraft, VectorCraft, FilmCraft, WordCraft and PdfCraft
through their own document models, so a brief becomes a layered `.pcraft`
file, a grade becomes a keyframe on a timeline, and a brand system stays a
set of addressable layers instead of a screenshot.

The chapter runs from a single Next.js route that turns a free-text brief
into a layered document, through a factory that compiles a recipe into a
command plan, to an appendix that speaks the engine's TCP control channel
directly. The five exercises take the same idea apart: an autopsy of a
failed banner, a drift-correction loop, an undoable grade, a brand-family
problem, and a lineage-first batch.

## The projects

Each project has its own README with the command to run it and the
artifacts it writes.

| project | what it is |
| --- | --- |
| [Advanced Application Implementation](advanced_application_implementation/example/) | The chapter's full production architecture for layered generation: a recipe is the source of truth, a compiler turns that recipe into a… |
| [Appendix — the loopback control channel, with mandatory authentication](appendix_the_loopback_control_channel_with_ma/example/) | A worked TCP client for the ArtCraft control channel: the alternative to the MCP stdio transport, used when the engine is already running and an… |
| [Basic Code Example](basic_code_example/example/) | A Next.js route that turns a free-text product brief into a layered PhotoCraft document rather than a flat image: the model is asked for a… |
| [Solutions and Explanations](solutions_and_explanations/exercise_1_the-disposable-banner-autopsy-rebuilding-a-flat-generation-as-a-layered-pcraft-a/) | The worked solutions for Exercises 1–5, each with an acceptance harness: the layered banner autopsy, the authenticated drift-correction loop, the undoable FilmCraft grade, the VectorCraft brand family and the WordCraft→PDF lineage batch. |

## What you need

Node.js 22.5+, Python 3.10+ and the engine binaries — or just Docker. The
root README sets out both paths and the one-time setup:
[what you need](../README.md#what-you-need) and
[install](../README.md#install).

## Run everything

```bash
./chapter1/run_all.sh
```

The script runs every harness in the chapter, prints one line per
harness, and exits non-zero if any of them fails. Each project harness leaves
its log in the `output/` directory it exercises; the chapter-level verifier
writes `verify_examples.log`.

It also re-runs the deterministic paths of the basic and advanced examples
(`mcp-probe`, `master-probe`, `smoke`, `forge:real`, the `LF-42` CLI job) and
finishes with `verify_examples.mjs`, which asserts the PNG dimensions, the
layered `.pcraft` documents, the model-driven JSON and the provenance ledger.
The model-driven scripts that call an LLM are not re-run without an API key;
their captured artifacts are in the same folders.

To run a single project, open its README: it gives the exact command
and the environment that command needs.

## Notes on the engines

The ArtCraft suite publishes macOS CLI builds, so every example runs natively
on Apple Silicon — no Linux container, no daemon.

```bash
bash tools/install_craft_clis.sh
source tools/env.sh
```

The first line downloads the CLIs into `tools/craft-cli/bin`; the second
puts them, and the local Node, on the `PATH`.

- **Two surfaces, one engine.** The CLI has a one-shot `run` mode for a
  single command, and an `mcp` mode that speaks JSON-RPC over stdio. The
  examples use the second: they open a session, issue `command_run` or
  `command_batch`, and close it in a `finally`.
- **Sandbox roots.** PhotoCraft, VectorCraft, FilmCraft and DeckCraft accept
  `--automation-read-root` and `--automation-write-root`; the other engines
  take no root flags and rely on the worker for the boundary.
- **The document is the deliverable.** A `.pcraft`, `.vcraft` or `.fcraft`
  file reopens with its layers intact; the PNG or preview is an export, not
  the result.
- **The appendix is not MCP.** The loopback channel is a raw TCP protocol
  whose first frame is an authentication envelope. It is there for hosts that
  cannot spawn a subprocess.
