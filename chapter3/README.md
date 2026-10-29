# Chapter 3 — Headless CLI Orchestration - Scripting PhotoCraft and DesignCraft in Docker and CI/CD Pipelines

The engine is only useful if it can be called from somewhere else. This
chapter puts it behind a process boundary: an HTTP service, a two-stage
pipeline, a worker pool, a nightly publishing job, and a CI gate.

The code moves from a single Express route that shells out to
`photocraft-cli run`, through BannerForge — contracts, MCP client, two-stage
pipeline, worker, logger — to a six-exercise arc that ends with a
golden-file harness. The container and CI files are part of the chapter too,
but they describe Linux images while the engine here is a macOS build, so
they are reviewed rather than executed.

## The projects

Each project has its own README with the command to run it and the
artifacts it writes.

| project | what it is |
| --- | --- |
| [Advanced Application Implementation](advanced_application_implementation/example/) | A multi-tenant marketing-asset service: a JSON design brief arrives over HTTP, two Craft MCP servers are already warm, a two-stage… |
| [Basic Code Example](basic_code_example/example/) | A "Hello World" SaaS endpoint for this stack: one HTTP route accepts a JSON payload, spawns the PhotoCraft headless CLI inside a per-request… |
| [Solutions and Explanations](solutions_and_explanations/exercise_1_the-banner-factory-manifest-12-000-deterministic-derivatives-per-cycle/) | The worked solutions for Exercises 1–6, each with an acceptance harness: the banner factory, the curve-grading loop, the WordCraft→DesignCraft→PdfCraft pipeline, the warm-start encoder, signed artifact publishing and the cross-suite golden harness. |

## What you need

Node.js 22.5+, Python 3.10+ and the engine binaries — or just Docker. The
root README sets out both paths and the one-time setup:
[what you need](../README.md#what-you-need) and
[install](../README.md#install).

## Run everything

```bash
./chapter3/run_all.sh
```

The script runs every harness in the chapter, prints one line per
harness, and exits non-zero if any of them fails. Each harness leaves
its log in the `output/` directory of the project it exercises.

To run a single project, open its README: it gives the exact command
and the environment that command needs.

## Notes on the engines

- **One dialect for the whole suite.** PhotoCraft, VectorCraft, FilmCraft,
  LightCraft and PdfCraft take `command_run {id, params}`; DesignCraft and
  WordCraft use `execute {command, params}` with a `list_commands` discovery
  call; EffectCraft and GridCraft use `execute_command`; DeckCraft uses
  `run_command`. The contracts in this chapter name the tool, not a generic
  one.
- **Sandbox roots differ.** PhotoCraft takes `--automation-read-root` and
  `--automation-write-root`; PdfCraft takes `--root`; DesignCraft takes
  neither and relies on the worker.
- **Session lifetime is a resource.** Every client is closed in a `finally`,
  or the stdio child outlives the request.
- **The Dockerfiles and CI/Kubernetes manifests are static.** The daemon is
  not required to read them, and the macOS binaries would not run in those
  images unchanged.

## The chapter's one structural lesson

Four listings — the orchestrator, the publishing pipeline, the provenance
collector and the golden harness — originally contained a hand-rolled
`{"jsonrpc":"2.0","id":…,"method":…}` client that called itself MCP. That is
not the MCP wire protocol, which is `initialize` followed by `tools/call`, so
none of them could complete a handshake. All four now use the official SDK;
the transport was the only thing that had to change in most cases, which is
the chapter's thesis about process boundaries.
