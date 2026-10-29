# 5. Basic Code Example

The smallest bridge that is still useful: an agent sees one business-level
tool, `hello_world_banner`, and the bridge turns that single call into three
PhotoCraft commands over its own MCP session and returns a PNG. It is the
chapter's argument in miniature — the agent never learns an engine command id,
the capability boundary is a pair of root flags, and every request gets its own
child process.

## What it does

The bridge is both an MCP server and an MCP client. Inbound it speaks stdio to
the coding agent; outbound it spawns `photocraft-cli mcp` with
`--automation-read-root` and `--automation-write-root` pinned to
`ARTCRAFT_WORKSPACE`. That pair of flags is the whole sandbox: the engine
refuses any path outside it, so a traversal attempt is stopped by the engine
rather than by a regex in the bridge.

The tool's schema is a Zod object with two fields. `greeting` is a string of
1 to 80 characters, defaulting to `Hello, World!`; `output` must match
`^[A-Za-z0-9_.-]+\.png$`, so a bare filename and nothing else, defaulting to
`hello.png`. Validation happens before any work, which is why a payload of
`sub/evil.png` comes back as an MCP error and never creates a directory.

A call then runs `doc_new` for an 800×400 RGB canvas named `HelloBanner`,
`command_run` with `type.create` to draw the greeting at (80, 220) in 88 pt
`Inter-Bold`, and `doc_save` with `format: "png"`. The reply to the agent is a
short text summary; a failure anywhere becomes a well-formed `isError` result
with a `hello_world_banner failed:` prefix, never an unhandled rejection. The
child is closed in a `finally`, and a process-level `unhandledRejection` guard
kills the bridge if one still escapes, so no Photocraft process is orphaned.

## The listings

| file | what it is |
| --- | --- |
| `03_src_bridge_ts_the_complete_bridg.ts` | the complete module — the same file as `src/bridge.ts` |
| `04_1_imports_and_module_surface.ts` | section 1: imports |
| `05_2_workspace_configuration.ts` | section 2: `WORKSPACE` and the environment override |
| `06_3_the_downstream_client_factory.ts` | section 3: `connectPhotoCraft()` and the root flags |
| `07_4_creating_the_upstream_mcp_serv.ts` | section 4: the upstream `McpServer` |
| `08_5_tool_registration.ts` | section 5: `registerTool` and the Zod schema |
| `09_6_the_handler_docnew.ts` | section 6: the canvas |
| `10_7_the_handler_commandrun_and_typ.ts` | section 7: `command_run` / `type.create` |
| `11_8_the_handler_docsave.ts` | section 8: the save |
| `12_9_returning_the_result.ts` | section 9: the text reply |
| `13_10_error_handling.ts` | section 10: the `isError` path |
| `14_11_deterministic_teardown.ts` | section 11: the `finally` |
| `15_12_entry_point.ts` | section 12: the stdio transport |
| `16_5_zombie_children_on_unhandled_r.ts` | the `unhandledRejection` guard |
| `01_package.json` | the manifest listing — `start` runs the bridge, `probe` runs the harness |
| `02_supporting_files.sh` | the two commands that install and start it |

## Run it

```bash
cd chapter5/basic_code_example/example/files
npx tsx run_basic.ts
```

The harness plays the agent: it spawns the bridge over stdio, lists the tool,
calls it twice, then starts a second bridge whose `PATH` resolves
`photocraft-cli` to `_shim/photocraft-cli`, a script that exits immediately.

```
connected to bridge

PASS tool surface
PASS defaults produce out/hello.png
PASS custom greeting and filename
PASS schema rejects a path instead of a bare filename
PASS schema rejects a 90-character greeting
PASS bridge exits when the agent disconnects
PASS missing engine becomes a handler-level MCP error

7/7 checks passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `files/out/hello.png` | the default 800×400 banner |
| `files/out/chapter5.png` | the second call, with a custom greeting and filename |
| `output/run_basic.log` | the harness log — seven checks and their tally |

The harness wipes `files/out/` at the start of every run; both PNGs are written
by the engine under the bridge's write root.

## Notes

- **`photocraft-cli` must be on `PATH`.** Only the final check needs the shim,
  and it supplies its own.
- `ARTCRAFT_WORKSPACE` defaults to `$TMPDIR/artcraft-bridge`. The harness sets
  it to `files/out`, which is why the PNGs land in the project.
- `npm start` runs the bridge on its own; that is what an MCP host launches.
  It reads nothing from stdin until a host speaks to it.
- Each tool call spawns and closes a Photocraft child, so a call costs a
  process start. The chapter's advanced example reuses one session instead.
- Node.js 22.5+ and `npx tsx`.
