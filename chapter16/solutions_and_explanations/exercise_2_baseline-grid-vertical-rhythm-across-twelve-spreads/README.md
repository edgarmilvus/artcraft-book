# 16. Exercise 2: Baseline Grid Across Twelve Spreads — solution

The worked grid QA. Every paragraph snaps to a 6.5 pt half-line, headings take
whole 13 pt units, and the measured line map is asserted spread by spread.

## What it does

1. `snapToHalf()` / `assertHalfLine()` enforce the 6.5 pt invariant before any
   style reaches DesignCraft.
2. `CANONICAL_STYLES` defines seven styles; body leading is 13 pt, H1 leading
   26 pt, and every space-before/after is a half-line multiple.
3. `styleFor()` maps each manuscript block kind to its canonical style;
   pull-quotes and sidebars are explicit break-away nodes.
4. `measureGrid()` reconstructs line positions from `inspect_document` and
   `get_story`.
5. `summarize()` counts aligned, total and break-away lines per spread.
6. `assertGrid()` fails only on non-break-away outliers and reports the spread,
   frame, y and delta.

## Run it

```bash
cd chapter16/solutions_and_explanations/exercise_2_baseline-grid-vertical-rhythm-across-twelve-spreads/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex2.ts
```

```
49 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/gridMap.json` | 12 spreads × 31 measured lines, with summary and zero outliers |
| `output/gridAssertion.json` | the passing per-spread assertion |
| `output/baseline-grid.png` | a 1600×1000 proof sheet of all twelve spreads with 13 pt rules |
| `output/report.json` | assertion count and artifact list |
| `output/run_ex2.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/02_baseline-grid-vertical-rhythm-across-twelve-spreads.ts` | grid constants, styles, measurement, summary and assertion |
| `files/run_ex2.ts` | the acceptance harness |
| `files/package.json` | npm scripts and dependencies |

## Notes

- The assertion deliberately ignores break-away pull-quotes and sidebars while
  still counting them in the spread summary.
- `measureGrid()` was exercised against a scripted document: five lines across
  two paragraphs, all on the 13 pt grid.
- The proof sheet is drawn from the same measured entries the assertion uses,
  not from a separate mock.
- Type-check it with `npm run check`.
