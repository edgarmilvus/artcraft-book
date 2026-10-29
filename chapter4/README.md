# Chapter 4 — The Loopback Control Channel - Wiring High-Speed JSON-Lines TCP Sockets and Auth Handshakes

Every project here talks to the engine over a socket instead of a
subprocess. The chapter opens the TCP loopback control channel: a JSON-lines
socket whose first frame is an authentication envelope and whose later
frames carry commands and their replies. The two examples build a client and
a fan-out gateway; the exercises add backpressure, agentic asset resolution,
a vision-driven grading loop, schema-routed multi-engine fan-out and
self-healing assembly.

## The projects

Each project has its own README with the command to run it and the
artifacts it writes.

| project | what it is |
| --- | --- |
| [Advanced Application Implementation](advanced_application_implementation/example/) | The production shape of the chapter's loopback channel: a typed client session with a heartbeating, reconnecting, backpressure-aware transport; an… |
| [Basic Code Example](basic_code_example/example/) | A complete, self-contained implementation of the channel a desktop engine opens on 127.0.0.1: one JSON value per line, a mandatory first-frame… |
| [Solutions and Explanations](solutions_and_explanations/exercise_1_a-backpressure-aware-json-lines-channel-client-for-photocraft-banner-batch/) | The worked solutions for Exercises 1–5, each with an acceptance harness: the backpressure-aware channel client, the DesignCraft asset resolver, the FilmCraft color loop, the four-engine schema-routed fan-out and the self-healing LightCraft/WordCraft/PdfCraft build. |

## What you need

Node.js 22.5+, Python 3.10+ and the engine binaries — or just Docker. The
root README sets out both paths and the one-time setup:
[what you need](../README.md#what-you-need) and
[install](../README.md#install).

## Run everything

```bash
./chapter4/run_all.sh
```

The script runs every harness in the chapter, prints one line per
harness, and exits non-zero if any of them fails. Each harness leaves
its log and generated artifacts in the `output/` directory of the project
it exercises.

To run a single project, open its README: it gives the exact command
and the environment that command needs.

## Notes on the channel

- **The first frame must be the auth frame.** The wire is strict:
  `{"id":"auth","method":"auth","params":{"token":"<64 hex>"}}` comes first,
  and anything pipelined ahead of it is refused and the socket closed.
- **Frames are newline-delimited JSON.** Reads go through a framer that
  accumulates until `\n`, and decode with `StringDecoder` so a multi-byte
  character split across two TCP segments is not corrupted.
- **Bind to `127.0.0.1`.** `server.listen(7979)` binds every interface; on a
  laptop that is a live remote-execution surface.
- **Response ids are not uniform.** Command replies carry numeric ids; the
  auth acknowledgement uses the literal `"auth"`. A dispatcher that coerces
  ids to strings will hand a request the wrong reply.
- **Backpressure is real.** `socket.write()` returns `false` when the buffer
  is full; wait for `drain` instead of queueing without limit.
- **This channel is not MCP.** The MCP examples use `command_run`; these
  listings speak the channel's own framing.
