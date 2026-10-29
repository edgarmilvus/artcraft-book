# 2. Basic Code Example

The smallest program that still exercises every pillar of the ArtCraft
runtime: the 256² sparse tile store, the command registry, multi-step
batching, and the two compositors. One TypeScript file, one
`photocraft-cli mcp` child process, no GUI.

Read it as a walking tour. Each numbered section of the listing corresponds
to one tool call, and the four companion fragments isolate the four pitfalls
that bite agents hardest.

## What it does

The program spawns `photocraft-cli mcp` with
`--automation-read-root` and `--automation-write-root` pointed at
`output/`, then drives it over line-delimited JSON-RPC 2.0 through the
official MCP SDK.

1. `doc_new` allocates a 1024 × 1024 RGB document — sixteen potential
   256-px tiles, of which only one will ever be materialized.
2. `command_run layer.new.layer` adds a pixel layer, then `select.rect` and
   `edit.fill` paint a 100 × 100 rectangle at (16, 16). Because the
   rectangle fits inside a single tile, the tile store promotes exactly one
   copy-on-write tile.
3. `command_batch` adds a Curves adjustment layer and sets its opacity in
   one round trip. Each step is still its own undo entry.
4. `command_run document.pixel` reads the composite at (50, 50) inside the
   stroke and at (900, 900) outside it, proving the fill landed where it
   should without flattening the document.
5. `doc_render_preview` returns a bounded PNG, `doc_save` writes the native
   `.pcraft` document, `doc_export` writes a flat PNG, and `session_list`
   reports the final state before the transport is closed.

## The listings

| file | what it is |
| --- | --- |
| `01_hello-artcraft-arch.ts` | the walkthrough: connect, create, paint one tile, batch, probe two pixels, preview, save, export, close |
| `02_2_treating_commandbatch_as_a_tra.ts` | the corrected rollback for a failed batch: read `failed` and `results` out of the JSON text block, then undo the applied prefix |
| `03_3_forgetting_await_on_client_cal.ts` | the fragment that fires `callTool` in a loop without awaiting it — the requests race and the last reply wins |
| `04_6_zombie_child_processes_on_time.ts` | a self-contained session that closes the transport in a `finally`, so the child process cannot outlive the parent |
| `05_11_omitting_await_in_the_tcp_loo.json` | the authenticating first frame of the loopback channel: `{"id":"auth","method":"auth","params":{"token":"<64 hex chars>"}}` |
| `verify-pitfalls.mjs` | the harness for `02`: builds a three-layer document, runs a batch whose third step is an unknown id, and rolls back the two that committed |

## Run it

```bash
cd chapter2/basic_code_example/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
OUT_DIR="$(cd ../output && pwd)" npx tsx 01_hello-artcraft-arch.ts
node verify-pitfalls.mjs
npx tsx 04_6_zombie_child_processes_on_time.ts
```

The walkthrough prints one labelled block per tool call. The pixel probes
are the interesting ones — the stroke reads back as the accent color, the
untouched tile as paper white:

```
── pixel inside stroke ─────────────────────────────────
[0.06666667014360428,0.545098066329956,0.9411764740943909,1.0]
── pixel outside stroke ─────────────────────────────────
[1.0,1.0,1.0,1.0]

── session_list ─────────────────────────────────
{"active":0,"background":[1.0,1.0,1.0,1.0],"documents":[{"dirty":false,"height":1024,"index":0,"name":"hello.pcraft","path":"hello.pcraft","revision":6,"width":1024}],"foreground":[0.0,0.0,0.0,1.0]}

✔ Hello, Architecture.
```

The pitfall harness ends with the proof that a batch is not a transaction:

```
batch reply: {"completed":2,"failed":1,"results":[true,true,false]}
layers after batch (committed, NOT rolled back): [ 'step-ok-2', 'step-ok-1', 'Background' ]
original  (res as any).failed  = undefined → rollback loop runs 0 times
corrected: undoing 2 applied step(s)
layers after rollback: [ 'Background' ]
PASS: rollback restored the document
```

The zombie check prints one `session_list` line and, crucially, exits.

## What it produces

All paths are under `output/`:

| artifact | what it is |
| --- | --- |
| `files/output/preview.png` | the bounded render returned by `doc_render_preview` |
| `files/output/hello.pcraft` | the native document, saved incrementally |
| `files/output/hello.png` | the flat PNG export |
| `output/run.log` | the full walkthrough trace |
| `output/verify-pitfalls.log` | the batch-rollback proof |
| `output/run-zombie.log` | the one-line session read from the close-on-exit fragment |

## Notes

- **`photocraft-cli` must be on `PATH`.** The snippets spawn the binary by
  name; set `PHOTOCRAFT_CLI` to override the path.
- **`npx tsx`, not `node`.** The listings are TypeScript with `.js`
  specifiers; `tsx` resolves them.
- **`command_batch` is not atomic.** `stop_on_error: true` stops at the first
  failure and leaves the earlier steps committed. The whole reply arrives as
  JSON text inside `content[0].text`, and `failed` is a count, not an index.
- **`edit.fill` takes opacity 0–100**, while `layer.setProps` takes 0–1.
- Type-check it with `npm run typecheck` (`tsc --noEmit`).
