# 1. Appendix — the loopback control channel, with mandatory authentication

A worked TCP client for the ArtCraft **control channel**: the alternative to the MCP stdio transport, used when the engine is already running and an agent needs a long-lived socket instead of a fresh child process per call. The appendix exists to make one rule unmissable — the **auth frame must be the first line on the socket**, and the engine drops the connection if it is not.

## What it does

`01_loopback_client.py` is the client itself. `ArtCraftControl.__init__` validates that the token is exactly 64 hex characters, opens the TCP socket, and immediately sends `{"id": "auth", "method": "auth", "params": {"token": …}}` as the very first line. Every later call is one JSON object per line and one reply per request, read back through a buffered reader.

`03_loopback_roundtrip.py` drives the full round trip on top of that client: `doc.new` creates the document, two `engine.execute` frames add a Curves adjustment layer and a shape, `doc.save` writes the `.pcraft`, and `doc.render` writes the PNG preview. `02_appendix_the_loopback_control_ch.sh` is the launch line for the engine itself — the port, the control token and the automation roots. `run_loopback.sh` ties the three together: it starts `photocraft-cli serve` with a freshly minted token, runs the round trip, and stops the server.

## The listings

| file | what it is |
| --- | --- |
| `01_loopback_client.py` | `ArtCraftControl`: the mandatory auth frame, then one JSON line per call |
| `02_appendix_the_loopback_control_ch.sh` | the engine launch line: `--control`, `--automation-read-root`, `--automation-write-root` |
| `03_loopback_roundtrip.py` | `doc.new → engine.execute → doc.save → doc.render` over the socket |
| `run_loopback.sh` | starts the server, runs the round trip, keeps the artifacts in `../output` |

## Run it

```bash
cd chapter1/appendix_the_loopback_control_channel_with_ma/example/files
bash run_loopback.sh
```

You should see the five frames answered with `ok: true`, followed by the artifact listing:

```
doc.new  -> {"id": 1, "ok": true, "result": {"document": 0}}
curves   -> {"id": 2, "ok": true, "result": {"layer": 3}}
shape    -> {"id": 3, "ok": true, "result": {"bounds": [40, 40, 760, 560], "fill": "#f2aa4c", ...
save     -> {"id": 4, "ok": true, "result": {"path": "loopback.pcraft", "warnings": []}}
render   -> {"id": 5, "ok": true, "result": {"bytes": 3247, "path": "loopback.png"}}
artifacts in .../example/output:
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/loopback.pcraft` | the document saved over the control channel |
| `output/loopback.png` | the 800×600 render written by `doc.render` |
| `output/serve.log` | the engine's own log line for the `serve` process |
| `output/run_loopback.log` | the transcript of the round trip |

## Notes

- `photocraft-cli` must be on `PATH`; `PHOTOCRAFT_BIN` overrides the binary name.
- `CRAFT_CONTROL_PORT` selects the port (default `7979`); the token is generated
  per run and passed to the client through `CRAFT_CONTROL_TOKEN`.
- `RUN_OUTPUT` overrides where the artifacts are written (default `../output`).
- Python 3.10+ and the standard library only — no third-party packages.
- The channel exposes `doc.new`, `doc.save`, `doc.render`, `doc.inspect`,
  `engine.execute`, `session.list`, `jobs.list` and `methods`. There is no
  `doc.export` method on the channel; that name belongs to the MCP tool.
