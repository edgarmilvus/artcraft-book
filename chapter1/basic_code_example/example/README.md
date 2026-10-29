# 1. Basic Code Example

A Next.js route that turns a free-text product brief into a **layered PhotoCraft document** rather than a flat image: the model is asked for a Zod-validated creative plan, the plan is executed as one `command_batch` of discrete engine commands, and the result is saved as a `.pcraft` file whose layers are still addressable. Nothing in the request returns a screenshot, because a screenshot would discard the only thing the pipeline exists for — the ability to revise a decision later without redoing the work.

## What it does

`app/api/studio/layered-render/route.ts` is the whole pipeline. `planFromBrief` makes the single LLM call through `generateObject` with a Zod schema, so a hallucinated JSON blob is rejected before it can reach the engine. `withPhotoCraft` opens one stdio MCP session against `photocraft-cli mcp`, pinned to the working directory with `--automation-read-root` and `--automation-write-root`, and closes it in a `finally` so a failed batch cannot leak the child process.

Inside that session the route makes four MCP calls in order. `doc_new` creates the canvas at the plan's size and background. `command_batch` applies the five visual decisions as one batch: a solid-color fill layer, a rounded-rectangle shape layer, two `type.create` layers for the headline and subhead, and a brightness/contrast adjustment layer. `doc_save` writes `<outputName>.pcraft`, and `doc_inspect` hands the resulting layer tree back so the next revision cycle can address any node by id. `app/studio/page.tsx` is the browser companion — a textarea, an "Interpret brief" button wired to `useCompletion` against a separate `/api/studio/interpret` route, and a "Render as layered .pcraft" button that POSTs to the render route.

The `examples/` scripts run the same pattern outside Next.js: `mcp-probe.mjs` exercises `doc_new → command_batch → doc_export` against the real engine, and `llm-layered-render.mjs` runs the brief → plan → batch pipeline with a real model.

## The listings

| file | what it is |
| --- | --- |
| `app/api/studio/layered-render/route.ts` | the route: brief → Zod-validated plan → `command_batch` → `.pcraft` + inspection |
| `app/studio/page.tsx` | client page: textarea, streamed brief interpretation, render button |
| `app/layout.tsx` | the root layout Next's App Router requires before any page can build |
| `examples/mcp-probe.mjs` | `doc_new → command_batch → doc_export` against the real engine |
| `examples/llm-layered-render.mjs` | the route's plan → batch pipeline, run outside Next.js with a live model |
| `examples/mcp-schemas.mjs` | dumps the real input schemas of the MCP meta-tools |
| `examples/mcp-batch-refs.mjs` | checks whether `command_batch` resolves `$N.layer` cross-step references |
| `examples/mcp-layerref.mjs` | checks whether the engine resolves symbolic `{"$layer":"name"}` references |
| `examples/master-probe.mjs` | drives the master MCP server so one tool call reaches every CLI |
| `notes/common_pitfalls.ts` | the awaited-`for`-loop pitfall, kept as a snippet |
| `notes/setup.sh` | the dependency list and the `.env.local` variables |

## Run it

```bash
cd chapter1/basic_code_example/example/files
npm install
node examples/mcp-probe.mjs
```

You should see the engine's tool list, then the three calls:

```
doc_new -> [{"type":"text","text":"{\"document\":0}"}]
command_batch -> [{"type":"text","text":"{\"completed\":2,\"failed\":0,\"results\":[{"ok":true,...
doc_export -> [{"type":"text","text":"{\"path\":\"probe.png\",\"warnings\":[\"3 layer(s) flattened; layers, masks and blend modes are not kept\"]}"}]
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/probe.png` | the 640×360 flattened preview written by `doc_export` |
| `output/plan.json` | the validated creative plan the model returned |
| `output/studio-render.pcraft` | the layered document from the model-driven run |
| `output/studio-render.png` | the preview of that document |
| `output/inspect.json` | the `doc_inspect` layer tree |
| `output/http-render.pcraft` | the document written by the route when called over HTTP |
| `output/http-layered-render.json` | the route's JSON response |
| `output/master.png` | the export produced through the master MCP server |
| `output/run-log.json` | the per-run record of the probes |
| `output/run_probe.log`, `output/run_master.log` | the two deterministic probe logs |

## Notes

- `photocraft-cli` must be on `PATH`; `PHOTOCRAFT_BIN` overrides the binary name.
- The model-driven scripts need an API key: `OPENROUTER_API_KEY`, plus optionally
  `OPENROUTER_BASE_URL` and `OPENROUTER_MODEL`. The route reads `OPENAI_MODEL`,
  `OPENAI_BASE_URL` and `OPENAI_API_KEY` instead, and falls back to `gpt-4o-mini`.
- `npm run typecheck` runs `tsc --noEmit` over the project.
- The probes are deterministic: same engine, same document, same bytes.
