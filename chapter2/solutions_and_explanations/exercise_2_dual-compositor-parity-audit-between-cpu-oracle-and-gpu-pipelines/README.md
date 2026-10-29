# 1. Exercise 2: Dual-Compositor Parity Audit Between CPU-Oracle and GPU Pipelines -- solution

The worked solution for Exercise 2: a headless audit that rebuilds a "Golden
Hour" effect stack on a 16-bit canvas, renders the same document at two
resolutions, and measures how far the compositor drifts per 256-px tile.

## What it does

The audit opens one `photocraft-cli mcp` session and creates a 2600 × 1600
16-bit RGB canvas. It applies a six-step effect batch — gradient map, curves,
color balance, vibrance, photo filter and a texture blend — with
`stop_on_error: false`, so one failed effect still produces a diagnostic
report instead of an empty run.

It then samples the document on a 4 × 4 grid plus twelve points on real
256-px tile boundaries, saves a full-resolution PNG and a native `.pcraft`
master, closes and reopens the master, and re-samples every coordinate. Any
channel that moves by more than one LSB across the save/load boundary is a
modelling regression and is reported separately from the pipeline delta.

Finally it renders a bounded preview (`max_side: 2048`), upscales it
bilinearly onto the reference grid, and computes the mean RGBA delta inside
every tile. A tile is flagged when any channel exceeds the 0.75-LSB epsilon;
the audit converges when no tile is flagged.

The solution deliberately does not call `ui_screenshot`: the live window
composites at display gamma and adds window chrome, so it cannot be a
pixel-parity reference. `doc_save` and `doc_render_preview` are the only
trustworthy sources.

## The listings

| file | what it is |
| --- | --- |
| `02_dual-compositor-parity-audit-between-cpu-oracle-and-gpu-pipelines.ts` | the effect stack, the PNG decoder, the per-tile diff and the report |
| `run_ex2.ts` | acceptance harness: runs the audit, validates the report and reopens both artifacts |
| `package.json` | dependencies for the listing |
| `tsconfig.json` | TypeScript settings |

## Run it

```bash
cd chapter2/solutions_and_explanations/exercise_2_dual-compositor-parity-audit-between-cpu-oracle-and-gpu-pipelines/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex2.ts
```

The harness runs the audit against the real engine, reads the report, and
opens the saved PNG and `.pcraft` with a second PhotoCraft session. The last
line counts the checks and any failures.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/audit/parity_report.json` | canvas, tile grid, samples, per-tile deltas and determinism drift |
| `output/audit/parity_reference.png` | the full-resolution CPU-oracle export |
| `output/audit/parity_roundtrip.pcraft` | the five-layer native master saved before the undo unwind |
| `output/audit.stdout.log` | the audit's stdout and stderr |
| `output/run_ex2.log` | every acceptance check |
| `output/run-log.json` | check count, failures and engine quirks |

## What the harness asserts

- the canvas is 2600 × 1600, RGB and 16-bit, with 11 × 7 = 77 tiles reported
  exactly once;
- the six-effect batch completes with zero failures and the save/load
  determinism drift is empty;
- the 4 × 4 grid plus twelve boundary samples are all inside the canvas and
  carry finite RGBA values;
- `max_mean_delta` is recomputed from the tile list, equals 0.3392578125, and
  stays under the 0.75 epsilon; no tile is flagged;
- the summary printed on stdout agrees with the report;
- the preview is 2048 × 1260 while the reference is a full 2600 × 1600;
- the reference PNG has a valid signature and header, and the round-trip
  master is non-trivial;
- reopening the master yields a 2600 × 1600, 16-bit, five-layer document;
  reopening the PNG yields a single Pixel layer at 2600 × 1600;
- the notes reject `ui_screenshot`, explain the 16-bit canvas and the 256-px
  geometry.

## Notes

- The headless CLI exposes the CPU SIMD oracle only; the wgpu pipeline lives
  in the desktop binary. The audit therefore compares the same model at two
  resolutions and says so in its notes.
- `doc_save` does not create parent directories; the audit creates `audit/`
  before the first save.
- `document.pixel` silently clamps an out-of-range coordinate instead of
  rejecting it, so the audit samples only the boundaries that exist in a
  2600 × 1600 canvas (`x = 256, 512, 1024, 2048`; `y = 256, 512, 1024, 1536`).
- `document.pixel` returns 16-bit values normalized to 0..255 as floats, not
  integers.
