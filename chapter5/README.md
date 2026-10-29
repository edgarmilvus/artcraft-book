# Chapter 5 — The Model Context Protocol (MCP) Bridge - Exposing Native Creative Tools to Autonomous Coding Agents

The chapter is about wrapping a native creative engine in an MCP server,
then orchestrating several of those servers from a TypeScript application.

## The projects

Each project has its own README with the command to run it and the
artifacts it writes.

| project | what it is |
| --- | --- |
| [Advanced Application Implementation](advanced_application_implementation/example/) | The chapter's reference orchestration layer: a brief goes in, a governed multi-app tool loop runs, and finished documents come out with an audit… |
| [Basic Code Example](basic_code_example/example/) | The smallest bridge that is still useful: an agent sees one business-level tool, hello_world_banner, and the bridge turns that single call into… |
| [Solutions and Explanations](solutions_and_explanations/exercise_1_building-a-schema-compatible-mcp-tool-adapter-for-cross-app-command-discovery/) | The worked answer to the chapter's first exercise: one adapter that asks eight engines eight different questions and returns one normalized tool… |

## What you need

Node.js 22.5+, Python 3.10+ and the engine binaries — or just Docker. The
root README sets out both paths and the one-time setup:
[what you need](../README.md#what-you-need) and
[install](../README.md#install).

## Run everything

```bash
./chapter5/run_all.sh
```

The script runs every harness in the chapter, including the five worked
solutions, prints one line per harness, and exits non-zero if any of them
fails. Each harness leaves its log in the project's `output/` directory;
the solution harnesses also save their real artifacts there — normalized
catalogs, ledgers, corrected PNGs, DAG/compensation plans and capability
matrices — so the result can be inspected without re-running the code.

To run a single project, open its README: it gives the exact command
and the environment that command needs.

## Three things worth knowing before you run

- **stdout is the protocol channel.** In the bridge, diagnostics go to
  stderr. One stray `console.log` desynchronizes the JSON-RPC framing and
  the host disconnects.
- **Keep the tool schemas narrow.** A loose record schema lets a
  model-invented parameter reach `command_run`; `.strict()` and enums turn
  that into a validation error the agent can act on.
- **A session is a child process.** `connectPhotoCraft()` costs tens of
  milliseconds of process start, so cap concurrency at one or two, and
  close every client in a `finally` or the child outlives the request.
- The Python exercise needs **Python 3.10+**; the runner picks the
  repository's `.venv` when it exists.
