# 4. Advanced Application Implementation

The production shape of the chapter's loopback channel: a typed client
session with a heartbeating, reconnecting, backpressure-aware transport; an
MCP server that exposes that one session to any agent; and a vision loop that
uses the session to look at a render and correct it. It is the architecture
the chapter argues for — one authenticated engine connection, many consumers.

## What it does

`session.ts` holds the whole client. It refuses any host that is not
`127.0.0.1`, `localhost` or `::1`, and any token that is not 64 hex
characters, before a socket is opened. The handshake has two forms: the raw
token, or — with `challengeResponse` — the server's `auth.challenge` nonce
answered with `HMAC-SHA256(token, nonce)`, falling back to the direct token
after 1.5 s if no challenge arrives. Requests are multiplexed by `id` with
per-request timeouts; `engine.batch` wraps several commands in one undoable
step; `ui.screenshot` unwraps the base64 PNG out of `result.data`.

Liveness is a `system.ping` loop: three consecutive misses inside the timeout
budget tear the socket down and start a jittered exponential reconnect, which
re-authenticates and resumes. State changes are emitted as `state` events, so
a caller can watch `connecting → authenticating → ready`.

`mcp-bridge.ts` wraps a `CraftControlSession` in an MCP server over stdio and
advertises six tools — `command_run`, `command_batch`, `doc_inspect`,
`ui_screenshot`, `doc_save`, `doc_new` — each of which translates one MCP call
into a loopback frame. `vision-loop.ts` closes the loop: screenshot, hand the
PNG to a caller-supplied auditor that must answer `{status:"ok"}` or
`{status:"fix", command, params}`, dispatch the fix on the same session,
repeat. `index.ts` is the composition root.

## The listings

| file | what it is |
| --- | --- |
| `types.ts` | the wire types: `ControlFrame`, `KnownMethod`, `SessionOptions`, the state union and the event map |
| `codec.ts` | `JsonLinesCodec` — buffers bytes, splits on `\n`, caps a frame at `maxFrameBytes` |
| `session.ts` | `CraftControlSession`: handshake, request multiplexing, heartbeat, reconnect, batch and screenshot helpers |
| `mcp-bridge.ts` | the six-tool MCP server and the loopback translation behind each tool |
| `vision-loop.ts` | `runVisionLoop` and the `VisionAuditor` contract |
| `index.ts` | entry point: env-driven session, optional MCP bridge, optional vision demo |
| `bridge-entry.ts` | the child process the bridge harness spawns — one session, MCP on stdio |
| `package.json` | manifest: `build`, `start`, `dev` |
| `tsconfig.json` | the strict TypeScript configuration |

## Run it

```bash
cd chapter4/advanced_application_implementation/example/files
npx tsx run_advanced.ts
npx tsx run_bridge.ts
```

`run_advanced.ts` drives the session against a protocol-faithful engine peer
on port 7901 and checks the handshake, two single commands, a batch, a
screenshot, one vision correction and the heartbeat:

```
  state: connecting
  state: authenticating
  state: ready
PASS handshake (challenge-response)        state=ready
PASS engine.execute doc.inspect            0 layers
PASS engine.execute layer.new.layer        id=1
PASS engine.batch (2 steps)                layers=3
PASS ui.screenshot                         96 b64 chars
PASS vision loop applies one fix           iterations=2
PASS heartbeat observed                    pings=3 calls=12

7/7 checks passed
```

`run_bridge.ts` spawns `bridge-entry.ts` as a child process and speaks MCP to
its stdio, the way an agent host would:

```
PASS tools advertised                      command_run, command_batch, doc_inspect, ui_screenshot, doc_save, doc_new
PASS tool: command_run
PASS tool: command_batch
PASS command_run doc.inspect
PASS command_batch through bridge
PASS tool: doc_inspect

6/6 checks passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/run_advanced.log` | the session harness output — seven checks and their tally |
| `output/run_bridge.log` | the bridge harness output — six checks and their tally |

## Notes

- **No engine binary is required.** The shipped CLIs serve MCP over stdio and
  none of them speaks this TCP protocol, so both harnesses stand up the
  protocol stub in `chapter4/_harness/engine-stub.ts` and drive the real client
  against it. Only the peer is local; everything under test is the listing.
- **Ports are overridable.** `RUN_PORT` moves the stub off 7901 / 7902, and
  `CHALLENGE=0` runs the handshake without the nonce exchange.
- `index.ts` needs `PHOTOCRAFT_TOKEN` (64 hex) and reads `PHOTOCRAFT_PORT`
  (default 7878), `MCP_ENABLED=1` and `VISION_ENABLED=1`. The harnesses do not
  use it; they instantiate the session directly.
- `run_bridge.ts` resolves the `tsx` launcher through the repository's
  shared `node_modules/.bin/tsx`, so run it from a full checkout.
- `npm run build` type-checks and emits `dist/`; `npm start` runs the built
  entry point.
