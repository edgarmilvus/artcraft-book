# 5. Advanced Application Implementation

The chapter's reference orchestration layer: a brief goes in, a governed
multi-app tool loop runs, and finished documents come out with an audit trail
and a bill. CreativeForge owns one session per tenant, spawns ArtCraft workers
lazily into that session's sandbox, routes every model-proposed call through a
router with four rules, and exposes the whole thing to a SaaS front end as a
Next.js route handler that streams server-sent events.

## What it does

`src/session.ts` is the unit of work. A `Session` carries the tenant identity,
a private read/write sandbox under `$TMPDIR/creativeforge/tenant-…`, the map of
live MCP clients, the list of documents written, the accumulated cost in cents,
and an `AuditRecord` for every tool call. Identity fields never change;
bookkeeping fields do.

`src/pool.ts` binds one MCP client to each `(session, app)` pair and starts it
only when the loop first needs that app. Each worker is a `*-cli mcp` process
launched with both root flags pointing at the session's sandbox. A crashed
worker is respawned at most twice, after 250 ms and 1.5 s, and its stderr is
forwarded into the orchestrator's log.

`src/router.ts` is where policy lives. `ui_screenshot` is refused unless the
tenant was provisioned for Visual Attach Mode. Every tool name must be in the
declared `META_TOOLS` set, and every argument object must pass a Zod schema
before anything is dispatched. A call with no app falls back to a small default
table — `doc_new`, `doc_open`, `doc_save` and `doc_render_preview` to
PhotoCraft — and an ambiguous tool with no default is rejected rather than
guessed. `ui_screenshot` is deliberately absent from that table.

`src/agent-loop.ts` builds the tool catalog from what each worker advertises
in `tools/list`, namespaced `photocraft__command_run` and so on, and runs the
loop for at most 24 turns. `src/app/api/briefs/route.ts` is the HTTP seam: it
requires `x-tenant-id`, validates the body, and streams `status`, `result` and
`error` events.

## The listings

| file | what it is |
| --- | --- |
| `01_session.ts` | `creativeforge/session.ts` — tenant, sandbox, clients, audit trail, cost |
| `02_pool.ts` | `creativeforge/pool.ts` — lazy workers, root flags, respawn budget |
| `03_router.ts` | `creativeforge/router.ts` — meta-tool schemas and the four dispatch rules |
| `04_agent-loop.ts` | `creativeforge/agent-loop.ts` — tool catalog, turn loop, `runBrief` |
| `05_route.ts` | `app/api/briefs/route.ts` — the SSE handler |
| `06_end_to_end_workflow_the_acme_q3.sh` | the one-command shell recipe that pins PhotoCraft to a sandbox |
| `07_end_to_end_workflow_the_acme_q3.json` | the three-step batch the recipe sends |
| `package.json` | manifest: `brief`, `typecheck` |
| `tsconfig.json` | the TypeScript configuration |

The runnable modules are mirrored under `files/src/` at the paths the listings
declare, which is what the harnesses import.

## Run it

```bash
cd chapter5/advanced_application_implementation/example/files
npx tsx run_advanced.ts
npx tsx run_router.ts
npx tsx run_route.ts
npx tsx run_shell.ts
npx tsx run_workflow.ts
```

`run_advanced.ts` replays a scripted four-turn brief with no API key, against a
real PhotoCraft worker:

```
brief complete

PASS catalog is the worker registry intersected with META
PASS loop runs one turn per scripted step
PASS doc_save is recorded in the tenant output list
PASS engine wrote an 1200x600 PNG under the session write root
PASS every tool result came back without an error
PASS billing is derived from audited worker time
PASS session sandbox is disposed of its workers

7/7 checks passed
```

The other four cover the router's rules (6/6), the route handler (4/4), the
shell recipe (2/2) and the batch workflow (3/3). Their logs are in `output/`.

## What it produces

| artifact | what it is |
| --- | --- |
| `files/out/tmp/creativeforge/<tenant>-*/write/brief.png` | the 1200×600 banner the scripted brief saves |
| `files/out/workflow/write/q3-launch.png` | the 1920×1080 workflow render |
| `output/run_advanced.log`, `run_router.log`, `run_route.log`, `run_shell.log`, `run_workflow.log` | one log per harness |

## Notes

- **`photocraft-cli` must be on `PATH`.** The router, loop and workflow
  harnesses start real workers; the route harness only needs the SSE path.
- **No API key.** `run_advanced.ts` injects a scripted `LlmClient`; the model
  name `claude-sonnet-4-20250514` is what the real client would ask for,
  `ANTHROPIC_API_KEY` is only read when `runBrief` builds its own client.
- Each harness wipes its own output subtree first, so runs do not accumulate
  sandboxes.
- `npm run typecheck` type-checks the listings; `npm run brief` is the same
  command as `npx tsx run_advanced.ts`.
