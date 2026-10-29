# 4. Solutions and Explanations

The worked answer to the chapter's first exercise: a `ChannelClient` for the
loopback control channel that survives a banner farm's load. It is the same
contract the exercise hands out — `connect`, `run`, `batch`, `withDocument`,
`close` — implemented with framing that cannot be fooled by a split UTF-8
sequence, a bounded in-flight window, a heartbeat, and a reconnect policy that
knows which commands are safe to replay.

## What it does

`JsonLinesChannelClient` decodes with `TextDecoder("utf-8", {fatal: true})` in
streaming mode and keeps a buffer it never lets grow past `maxFrameBytes`
(8 MiB); a violation is a protocol error, not something to skip. Authentication
is the first frame on every connection, and a reply that is not `ok` raises
`AuthFailedError` without a retry — a rejected credential is an incident, not a
transient failure. `assertLoopbackHost` accepts only the literal addresses
`127.0.0.1` and `::1`.

Concurrency is bounded by a hand-written `Scheduler`: sixteen requests in
flight, and a seventeenth waits rather than being dropped. Each request gets a
monotonic numeric id and an entry in the pending map, and the classifier tags
it `readOnly` or `mutating` from the command id — `doc_save`, `doc_new`,
`doc_close`, `doc_export` and anything under `layer.`, `filter.`, `edit.`,
`image.`, `paint.`, `type.`, `shape.` or `path.` counts as mutating.

A `ping` goes out every five seconds; two unanswered heartbeats tear the socket
down and start the reconnect. The reconnect uses `min(2000, 100 · 2^(n-1))`
milliseconds, re-authenticates, resets its attempt counter, and re-issues only
the read-only requests that were in flight. Mutations are never replayed —
the caller decides what to do about a document that may or may not carry a
half-applied edit.

`withDocument` is the transaction wrapper: it opens a document, hands the body
`run`, `inspect` and `save` helpers, and closes the document in a `finally`,
so a throwing body still leaves the engine clean.

## The listings

| file | what it is |
| --- | --- |
| `01_channel-client.ts` | the whole client — wire types, errors, scheduler, framing, reconnect, `withDocument` |
| `run_channel_client.ts` | the harness that drives it against the protocol peer |

## Run it

```bash
cd chapter4/solutions_and_explanations/exercise_1_a-backpressure-aware-json-lines-channel-client-for-photocraft-banner-batch/files
npx tsx run_channel_client.ts
```

The peer is the stub in `chapter4/_harness/engine-stub.ts` on port 7903, with the
plain-token handshake. The harness first tries a wrong token, then the happy
path, then kills every live socket while keeping the listener.

```
PASS wrong token rejected                    AuthFailedError
PASS run doc.inspect
PASS run layer.new.layer                     id=1
PASS batch (2 steps)
  [scoped] inspect…
  [scoped] inspect ok
  [scoped] run ok
  [scoped] save ok
PASS withDocument scope                      layers before=0
PASS survives a dropped socket               dropped=1

6/6 checks passed
```

The "survives a dropped socket" check is the one that matters: after
`dropConnections()` the next `run` has to reach a reconnected,
re-authenticated channel within the harness's 600 ms grace period. A watchdog
prints the stub's call log and exits non-zero if the run stalls.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/run-log.json` | check tally, port and the stub call trace |
| `output/run_channel_client.log` | the harness log — six checks and their tally |

## Notes

- **No engine binary is required.** The stub speaks the same `auth` →
  `engine.execute` / `engine.batch` → `ping` protocol as the chapter.
- `RUN_PORT` moves the stub off 7903 if that port is taken.
- The client is strict-mode TypeScript with `noUncheckedIndexedAccess` in mind:
  every indexed access is narrowed before use, and `JSON.parse` results are
  typed `unknown` and narrowed by a predicate.
- Node.js 20+ and `npx tsx`.
