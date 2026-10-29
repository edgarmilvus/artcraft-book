# 3. Basic Code Example

A "Hello World" SaaS endpoint for this stack: one HTTP route accepts a JSON
payload, spawns the PhotoCraft headless CLI inside a per-request temporary
workspace, sends it three engine commands, and returns the byte count and
latency of the resulting PNG.

One file, no third-party dependencies, and every knob the rest of the chapter
pulls — command chaining, sandboxed I/O, an ephemeral filesystem, a wall-clock
timeout, and strict types at the process boundary.

## What it does

`POST /banner` with `{headline, subhead, width, height}` produces a banner PNG
and a small JSON envelope. The request is narrowed by hand (no Zod, to keep
the image small), so a missing field or a non-positive dimension is a `400`
before a subprocess exists.

The plan is five steps: `file.new` on a dark ground, a vertical gradient fill
layer, two `type.create` calls for headline and subhead, and `file.save` to a
PNG. `planToArgv` is the only code that knows the CLI grammar: `file.new`
becomes the `--new` payload, `file.save` becomes `--out` plus `--format`, and
the three interior steps become `--cmd <id> --params <json>` pairs. `file.save`
is a semantic marker, not a registered command: the 0.8.2 registry has 892 ids
and none of them is `file.save` (the closest is `file.saveACopy`).

Each request gets its own directory from `mkdtemp` under `TMPDIR`, and that
directory is also the CLI's working directory — `run` takes no sandbox flags,
so anything the CLI resolves relative to its cwd lands inside the workspace.
The child is spawned with `PHOTOCRAFT_GPU=0` (CI runners rarely expose a
usable GPU, and probing for one can hang on virtualised hosts), its stderr is
kept in a bounded 8 KB buffer, and it is `SIGKILL`ed on timeout — 30 s by
default, `AUTOMATION_TIMEOUT_MS` overrides it. The workspace is removed in a
`finally` unless `KEEP_WORKSPACE=1`.

Two companion shell files show the container story: the build and `docker run`
invocation with a read-only root filesystem and a `tmpfs` at `/tmp`, and the
curl that exercises the image.

## The listings

| file | what it is |
| --- | --- |
| `01_banner-service.ts` | the service: request narrowing, `buildPlan`, `planToArgv`, the spawn wrapper with timeout and output draining, the HTTP handler |
| `02_the_container_dockerfile.Dockerfile` | the multi-stage image: build the TypeScript, then copy the `photocraft-cli` binary and its fonts into a slim runtime |
| `03_the_container_dockerfile.sh` | `docker build`, then `docker run` with `--memory=512m --cpus=1 --read-only --tmpfs /tmp` |
| `04_the_container_dockerfile.sh` | the `curl` that posts a banner request to the running image |
| `05_1_hallucinated_json_at_the_proce.ts` | a misspelled parameter (`colorr`) — TypeScript accepts it, and the engine drops it silently |
| `06_3_async_await_loops_that_look_fi.ts` | the loop that builds argv correctly |
| `07_3_async_await_loops_that_look_fi.ts` | the same loop awaiting each spawn — serial and correct, but one process per step |
| `08_3_async_await_loops_that_look_fi.ts` | `forEach` with an async callback: the awaits fire but nothing waits for the loop |
| `09_8_reading_process_env_without_st.ts` | `process.env["PHOTOCRAFT_CLI"]!` — the non-null assertion that hides a missing binary until spawn time |
| `10_warm_start_upgrading_to_a_daemon.sh` | the control-channel form of the same idea: `photocraft-cli serve --port 7979` with a token file and explicit automation roots |
| `11_warm_start_upgrading_to_a_daemon.json` | the authenticating frame the server expects first |

## Run it

```bash
cd chapter3/basic_code_example/example/files
TMPDIR="$(cd ../output/tmp && pwd)" KEEP_WORKSPACE=1 PORT=8787 npx tsx 01_banner-service.ts &
curl -sS -X POST http://localhost:8787/banner \
  -H 'content-type: application/json' \
  -d '{"headline":"Hello, World","subhead":"Rendered by PhotoCraft","width":1200,"height":630}'
```

The server logs its port, the workspace it kept, and the response envelope:

```
[banner-service] listening on :8787
[banner-service] kept workspace .../output/tmp/artcraft-LQnXVz
{"ok":true,"bytes":41453,"durationMs":98}
```

`bytes` is the size of the PNG the CLI wrote and `durationMs` is the round
trip, cold start included. Five consecutive requests against a warm process
measured 98–99 ms; the first request after boot measured 120 ms in that run and
237–322 ms on earlier cold runs.

## What it produces

Paths are relative to `example/`:

| artifact | what it is |
| --- | --- |
| `output/banner.png` | the 1200 × 630 banner the CLI wrote |
| `output/response.json` | the `{ok, bytes, durationMs}` envelope |
| `output/service.log` | the server's lines |
| `output/tmp/artcraft-*/` | the per-request workspace, kept because `KEEP_WORKSPACE=1` |

## Notes

- **`photocraft-cli` must be on `PATH`.** `PHOTOCRAFT_CLI` overrides the
  binary; `PORT` overrides the port.
- **Every request is a cold start.** The service spawns a fresh process per
  banner on purpose; the warm-start section of the chapter is the upgrade
  path, not this file.
- **The workspace is the sandbox.** All paths are absolute and confined to the
  per-request temp directory, and the child's working directory is that
  directory.
- **`bytes` and `durationMs` vary between runs** with the machine and the font
  cache; the shape of the envelope does not. The recorded artifact is 41,453
  bytes because the render is deterministic for a fixed CLI build and font set.
