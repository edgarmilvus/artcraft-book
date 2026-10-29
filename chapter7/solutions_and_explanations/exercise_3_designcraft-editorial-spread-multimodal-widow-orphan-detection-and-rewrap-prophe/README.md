# 7. Exercise 3: DesignCraft Editorial Spread — Multimodal Widow/Orphan Detection and Rewrap Prophecy — solution

The worked solution for Exercise 3. It uses DesignCraft as the source of
truth for line breaks, measures the rendered spread, asks a vision model to
confirm or reject each candidate, and applies the confirmed rewrap as engine
commands.

## What it does

1. Opens a six-column editorial spread and inspects its frames and stories.
2. Renders the page and measures line boxes directly from the raster: ink
   bands become lines, and each line gets a fill ratio and paragraph index.
3. Detects three candidate classes: widows, orphans and ragged paragraphs.
   Only compact candidate records and small crops are sent to the model.
4. Sends each candidate crop plus geometry to the vision model for a verdict
   (`confirmed` or `rejected`) and a wrap strategy.
5. Compiles confirmed candidates into a tracking, word-spacing or
   hyphenation step, applies one batch, measures a second pass, and rolls
   back if the pass makes the spread worse.
6. Saves the corrected `.designcraft` document and renders the after image.

The harness exercises the confirmed fix and the all-rejected path, then
unit-tests the widow/orphan/ragged heuristics, byte-based paragraph ranges
and the wrap proposal ladder.

## Run it

```bash
cd chapter7/solutions_and_explanations/exercise_3_designcraft-editorial-spread-multimodal-widow-orphan-detection-and-rewrap-prophe/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex3.ts
```

The engine CLI must be on `PATH`:

```bash
export PATH="/path/to/repo/tools/craft-cli/bin:$PATH"
```

```
85 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/spread-before.png` | the rendered spread before the rewrap |
| `output/spread-after.png` | the rendered spread after the confirmed tracking fix |
| `output/spread-corrected.designcraft` | the saved corrected document |
| `output/measurement.json` | measured line boxes, column fill ratios and candidates |
| `output/spread_manifest.json` | pass ledger, applied commands, verdicts and rollback state |
| `output/reject-manifest.json` | the same manifest for the all-rejected scenario |
| `output/report.json` | scenario index, assertion count and artifact list |
| `output/run_ex3.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/03_designcraft-editorial-spread-multimodal-widow-orphan-detection-and-rewrap-prophecy.ts` | measurement, candidate detection, wrap proposals and the audit loop |
| `files/run_ex3.ts` | the acceptance harness: real spread fixtures and both verdict paths |
| `files/package.json` | npm scripts and dependencies |
| `files/tsconfig.json` | TypeScript config |

## Notes

- `designcraft-cli` must be on `PATH`; the harness injects a deterministic
  verifier, so no API key is needed.
- The harness creates `files/input/spread.designcraft` and writes evidence to
  `../output/`.
- The before/after assertion decodes both PNGs and requires a non-zero pixel
  change, so a render that silently ignores the fix fails the run.
- `npm run check` type-checks the solution module and the harness.
