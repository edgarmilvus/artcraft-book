# 4. Basic Code Example

A complete, self-contained implementation of the channel a desktop engine
opens on `127.0.0.1`: one JSON value per line, a mandatory first-frame
`auth`, heartbeats, backpressure, and a client that reconnects on its own.
The server and the client live in the same file and are wired together at the
bottom, so the whole protocol can be read in one sitting. The engine's command
registry is replaced by a three-case `execute` callback.

## What it does

`LoopbackServer` binds `127.0.0.1` — never `0.0.0.0`, because the bind *is* the
firewall — and validates the shared secret at construction: 64 hex characters,
nothing else. `NdjsonFramer` turns the TCP byte stream into complete JSON
values, using a `StringDecoder` so a multi-byte UTF-8 sequence split across two
segments does not turn into replacement characters, and refusing any line above
2 MiB.

Each connection runs a `Session` through three states. `WAIT_AUTH` accepts
exactly one frame, and only if it is `{id:"auth", method:"auth",
params:{token}}`; the token is compared with `crypto.timingSafeEqual`, and a
session that says nothing for three seconds is closed. `READY` dispatches
`engine.execute` into the server's `execute` callback, answers `ping` with
`pong`, and pings the client every fifteen seconds. `CLOSED` is terminal.

Every outbound frame goes through an outbox capped at 1024 entries. When
`socket.write()` returns `false` the pump waits for `'drain'` instead of
piling frames into memory. `LoopbackClient` multiplexes replies by numeric id,
fails an unanswered command after thirty seconds, and reconnects with jittered
exponential backoff from 250 ms up to 5 s.

The demo at the bottom generates a token, starts the server, connects, and
round-trips `doc.inspect`, `layer.new.layer` and `ui_screenshot`.

## The listings

| file | what it is |
| --- | --- |
| `01_loopback-control-channel.ts` | wire types, the NDJSON framer, the server session, the client, and the demo entry point |

## Run it

```bash
cd chapter4/basic_code_example/example/files
npx tsx -e "import('./01_loopback-control-channel.ts').then(m => m.main())"
```

The file ends with a `require.main === module` guard, which never fires in an
ES module — and the repository's `package.json` sets `"type": "module"` — so
the exported `main()` is called explicitly.

```
[server] listening on 127.0.0.1:7979
[server] client connected from 127.0.0.1:51189
[server] client authenticated
doc.inspect     -> { document: { width: 1920, height: 1080, mode: 'rgb' }, layers: [] }
layer.new.layer -> { id: 7, name: 'Ink' }
ui_screenshot   -> { path: '/tmp/audit.png' }
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/run_basic.log` | the demo's stdout, captured from this command |

The three replies come from the stand-in `execute` callback, so nothing is
written to disk apart from the contents of that reply. No engine has to be
installed to read the protocol.

## Notes

- **Node.js 20+** and `npx tsx`; there is no build step and no `package.json`
  in this directory.
- **Port 7979 must be free.** A second run while the first is still listening
  fails with `EADDRINUSE` before the client connects.
- The token is generated per run, so the log lines above are stable but the
  port the client connects *from* is not.
- The same protocol is driven against a protocol-faithful peer in
  `chapter4/advanced_application_implementation/example/`, which is the version to
  read once this one is clear.
