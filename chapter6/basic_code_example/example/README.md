# 6. Basic Code Example

A self-contained smoke test that boots `photocraft-cli mcp` over stdio,
creates a document, stacks a solid fill, a clipped pixel layer and a curves
adjustment, and saves the result as a layered PSD — all in one file. It proves
the meta-tool surface works before the chapter builds on it.

## What it does

`01_psd-smoke-test.ts` opens a single MCP session, creates a 640×360 document
with `doc_new`, then issues one `command_batch` with three steps
(`layer.newFillLayer.solidColor`, `layer.new.layer` with `clipToPrevious: true`,
and `layer.newAdjustmentLayer.curves` carrying the perceptual knots in the
`lightness` channel). It reads the tree back with `doc_inspect` and saves
with `doc_save { format: "psd" }`.

Nothing about the run is stubbed: the request is validated by Zod before a
child exists, the child is spawned with both automation roots pinned to the
caller's `workRoot`, and the PSD is written by the real engine. The harness
asserts the PSD signature (`8BPS`), the four top-level layers, and that a
`../` output path is refused by the engine's own capability gate.

## The listings

| file | what it is |
| --- | --- |
| `01_psd-smoke-test.ts` | the complete run: schema, session, batch, save |
| `src/psd-smoke-test.ts` | symlink to the same file, so `run_basic.ts` can import it |
| `package.json` | npm scripts (`smoke`) and dependencies |
| `tsconfig.json` | TypeScript config |

## Run it

```bash
cd chapter6/basic_code_example/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_basic.ts
```

```
PASS bad canvas rejected by the schema
PASS document index is the one doc_new returned
PASS four top-level layers (background, fill, clip, curves)
PASS the PSD was written
PASS the file carries the PSD signature
PASS no save warnings
PASS a parent-traversal path is refused

7/7 checks passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/run_basic.log` | the harness log, seven checks |

The harness deletes its sandbox on exit, so the PSD it writes is deliberately
not left in the repository: it is a 49,634-byte, 640×360, four-layer file
written under a `mkdtemp` root and removed with it. To keep one, call
`composeLayeredPsd()` yourself with a persistent `workRoot`.

## Notes

- `photocraft-cli` must be on `PATH` (the repository ships it under
  `tools/craft-cli/bin`).
- The curves step passes the knots through the `lightness` channel, which puts
  the adjustment layer in `space: "Lab"` with the anchors at
  `adjustment.Curves.per_channel[0]`. Reopening the saved PSD reports
  `space: "Rgb"` with the same anchors — the grade is preserved, the space flag
  is not serialized. `points` would instead drive the composite RGB curve.
- `clipToPrevious: true` is the batch-native way to build a clipping mask; the
  post-hoc `layer.createClippingMask` command is the fallback.
- An output path that escapes `workRoot` is refused by the engine
  (`automation path rejected: parent traversal is not allowed`), not by the
  TypeScript schema.
