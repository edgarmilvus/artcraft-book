# 6. Exercise 2: OkLCh-Inspired Curve Grading with Runtime Schema Validation and Cross-Machine Reproducibility -- solution

The worked answer to Exercise 2: a validated translation from an untrusted
OkLCh-style grading spec to a deterministic stack of PhotoCraft adjustment
layers, plus the two renders that prove the translation is reproducible.

## What it does

`OkLchGradeSpecSchema` is the trust boundary. Lightness offset is limited to
±0.1, contrast pivot to 0.3..0.7, contrast amount to 0..1 and chroma gain to
0.5..2.0. A payload outside those bounds raises a `ZodError` before an MCP
session is opened, so malformed webhook traffic never reaches the engine.

Three pure translators do the color work. Lightness becomes
`levels.gamma = 2^(-4·offset)`, clamped into the engine's `0.01..9.99` range.
Contrast becomes five curve anchors: black, a flank below the pivot, the pivot,
a flank above it, and white; the flanks move by `contrastAmount · 40` code
values, so amount zero is the identity curve and the pivot never moves. Chroma
gain becomes `round((gain − 1) · 100)` saturation units, clamped to ±100.

One color-balance layer carries both intents — a `+8` blue push in the
highlights and a `−8` pull in the shadows — because two layers would stack two
transfer functions and double the effect in the midtones. The magnitude is a
named constant, not a literal.

`gradePhoto` opens the photo, sends the adjustment stack as one
`command_batch` with `stop_on_error: true`, and on a rejected step undoes
exactly `completed` steps before throwing. The report is read back from
`doc_inspect`, the optional PSD is saved, and `doc_render_preview` at 1024 px
is hashed with SHA-256. No wall clock, RNG, locale or ambient environment is in
the batch, so the same spec renders the same bytes.

## The listings

| file | what it is |
| --- | --- |
| `02_oklch-inspired-curve-grading-with-runtime-schema-validation-and-cross-machine-reproducibility.ts` | the schema, the three translators, the batch, `undoAppliedPrefix`, `gradePhoto` and the report |
| `run_ex2.ts` | the acceptance harness — two renders, clamp cases, rejection and compensation |
| `package.json` | manifest — `npm run harness` runs the acceptance harness |
| `tsconfig.json` | the strict TypeScript configuration |

`src/oklch.ts` is a symlink to the worked file so the harness imports it the
same way the book's listing does.

## Run it

```bash
cd chapter6/solutions_and_explanations/exercise_2_oklch-inspired-curve-grading-with-runtime-schema-validation-and-cross-machine-re/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex2.ts
```

```
PASS two runs render the same bytes
PASS the report carries the applied gamma
PASS nothing was clamped inside the schema's range
PASS the curve passes through the pivot unchanged
PASS the curve has five anchors
PASS the document reports one base layer plus four adjustments
PASS both colour-balance intents ride on one layer
PASS the unsupported list is non-empty
PASS no colour work means no colour-balance layer
PASS gamma clamps at the engine floor
PASS saturation clamps at +100
PASS a brutal S-curve reports its clamp
PASS a pivot outside the contract never reaches the engine
PASS a mid-batch failure still reports the applied prefix
PASS the compensation restores the opening history depth
PASS the two saved PSDs are byte-identical

16/16 checks passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/workspace/read/photo.png` | the 320×240 gradient source the two grades start from |
| `output/previews/pass-1.png` | the first 320×240 render at `max_side: 1024` |
| `output/previews/pass-2.png` | the second render; byte-identical to the first |
| `output/previews/plain.png` | the render with both color-balance intents off |
| `output/graded/graded-1.psd` | the first saved graded document |
| `output/graded/graded-2.psd` | the second saved document, byte-identical to the first |
| `output/graded/plain.psd` | the document with three adjustments instead of four |
| `output/graded/inspect.json` | the layer tree read back from `graded-1.psd` |
| `output/report.json` | the spec, both hashes, the full grade report, asset hashes and checks |
| `output/run_ex2.log` | the harness log — sixteen checks and their tally |

## Notes

- **`photocraft-cli` must be on `PATH`.** The harness uses its `run` subcommand
  to make the source photo and its `mcp` server for the grade.
- **No GUI, no GPU, no network.** Both automation roots are pinned under
  `output/workspace/` and the graded PSDs are saved under `output/graded/`.
- The clamp flags stay in the report even where the schema makes them
  unreachable, because direct callers of `translateLightness` and
  `translateChroma` can still pass values past the bounds.
- `previewPath` and `savePath` are optional evidence hooks on `gradePhoto`; the
  SHA-256 is always returned whether or not the bytes are kept.
- Node.js 22.5+ and `npx tsx`.
