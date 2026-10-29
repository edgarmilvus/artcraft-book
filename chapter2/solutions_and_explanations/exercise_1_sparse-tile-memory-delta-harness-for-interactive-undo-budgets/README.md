# 1. Exercise 1: Sparse-Tile Memory Delta Harness for Interactive Undo Budgets -- solution

The worked solution for Exercise 1: a stdlib-only Python harness that proves
PhotoCraft's 256² copy-on-write tiles isolate localized edits, plus the
fixture builder that materializes the 8000 × 6000 retouch target the exercise
assumes.

## What it does

`make-fixture.mjs` opens an 8000 × 6000 RGB document, fills it with a neutral
base so multiply strokes read on the preview, and saves it as
`output/retouch/FW26_hero_048.tif` under the automation write root.

`01_sparse_tile_delta.py` speaks line-delimited JSON-RPC 2.0 to
`photocraft-cli mcp` and measures three classes of mutation against that one
document, without ever closing it:

1. **`localized_brush_strokes`** — ten `paint.stroke` steps inside one
   `command_batch` with `stop_on_error: true`, each constrained to a small
   island of the canvas.
2. **`layer.newAdjustmentLayer.curves`** — one global four-point curve
   through `command_run`.
3. **`filter.blur.gaussianBlur`** — submitted with `"wait": false`, so the
   engine returns a job handle; the harness polls `jobs.list` until the job
   leaves `running` before it reads the result.

The report records the engine damage rectangle for every step, turns each
rectangle into a set of 256-px tiles anchored at `(0, 0)`, subtracts the tiles
already touched by an earlier step, and sums the union. That union is the
memory delta a copy-on-write store would actually allocate.

`run_ex1.py` builds the fixture, runs the harness, re-derives every tile count
from the recorded rectangles and reopens the TIFF with a second engine
session.

## The listings

| file | what it is |
| --- | --- |
| `01_sparse_tile_delta.py` | the MCP harness, the tile arithmetic and the JSON report |
| `make-fixture.mjs` | builds the 8000 × 6000 TIFF retouch target |
| `run_ex1.py` | acceptance harness: runs the measurement and verifies the report and the TIFF |

## Run it

```bash
cd chapter2/solutions_and_explanations/exercise_1_sparse-tile-memory-delta-harness-for-interactive-undo-budgets/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
../../../../.venv/bin/python run_ex1.py
```

The `PATH` export puts the `*-cli` binaries in front of any system install;
the repository venv is the interpreter the harness is tested with. It writes every check as it runs and exits non-zero on a failed
assertion.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/retouch/FW26_hero_048.tif` | the 8000 × 6000 deflate-compressed retouch target |
| `output/reports/sparse_tile_delta_FW26_hero_048.json` | per-step damage, tile counts and cumulative union |
| `output/sparse_tile_delta.stdout.json` | the harness transcript, including the raw MCP replies |
| `output/run_ex1.log` | every acceptance check |
| `output/run-log.json` | check count, failures and engine quirks |
| `output/fixture.log` | the fixture builder's output |

## What the harness asserts

- the TIFF is a real 8000 × 6000 TIFF, not a renamed placeholder;
- the ten strokes touch 60 tiles, the global curve touches the remaining 708,
  and the destructive blur touches none because the full canvas is already
  dirty;
- the cumulative union is 768 tiles, equals the recomputed union, and no tile
  is counted twice;
- every step's damage area and coverage percentage recompute from its own
  rectangles (inclusive endpoints, 1 × 1 = one pixel);
- the localized batch covers under 10 % of the canvas while both global edits
  cover 100 %;
- every rectangle lies inside the canvas, every duration is finite, and the
  layer tree grows from two nodes to three;
- the saved TIFF reopens at full resolution in a fresh engine session.

## Notes

- `doc_save` does not create missing parent directories: the fixture builder
  and the harness create `output/retouch` first.
- `doc_inspect` exposes the layer tree but not a tile census, so the tile
  counts are derived from the engine-reported damage rectangles.
- The TIFF is deflate-compressed; 144 MB of pixels fit in roughly 160 kB on a
  flat base.
- `doc_inspect` reports the mode capitalised (`Rgb`), while `doc_new` accepts
  lowercase `rgb`.
