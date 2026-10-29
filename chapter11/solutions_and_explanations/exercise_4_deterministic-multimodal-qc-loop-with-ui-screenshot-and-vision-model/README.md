# 11. Exercise 4: Deterministic Multimodal QC Loop — solution

The worked A/V sync gate. A Program-monitor pixel is converted to an exact
tick with integer arithmetic, the audio transient is compared in ticks, and
the verdict is expressed against a two-sample threshold.

## What it does

1. `pixelXToTick()` rewrites the pixel mapping as
   `anchor + (2·pxX − W) × duration / (2W)` with every term an integer, then
   rounds half-to-even.
2. The bridge path takes `ui_screenshot`, validates the vision model's
   coordinates against the panel bounds and rejects out-of-bounds answers.
3. `audioTransientTickNear()` finds the nearest waveform peak within the
   search radius; a flat envelope is rejected.
4. `buildSyncReport()` computes the maximum accepted drift, the rejected
   ratio and the verdict: `pass`, `fail` or `inconclusive`.
5. The pass threshold is exactly two samples at 48 kHz,
   `10_584_000` ticks.

## Run it

```bash
cd chapter11/solutions_and_explanations/exercise_4_deterministic-multimodal-qc-loop-with-ui-screenshot-and-vision-model/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex4.ts
```

```
23 assertions passed
```

The harness exercises the deterministic pixel mapping and verdict logic;
`runSyncQc()` is the bridge-mode production path.

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/program-monitor.png` | a real 1280×720 Program-monitor screenshot with a center marker |
| `output/sync-qc-report.json` | pass/fail/inconclusive reports and the anchor rows |
| `output/report.json` | threshold, ticks-per-sample and artifact list |
| `output/run_ex4.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/04_deterministic-multimodal-qc-loop-with-ui-screenshot-and-vision-model.ts` | pixel-to-tick math, vision validation, transient search, correction and report builder |
| `files/run_ex4.ts` | the acceptance harness: exact mapping, threshold and three verdicts |
| `files/01_typescript.ts` | the sync anchor and report contract |
| `files/package.json` | npm scripts and dependencies |
| `files/tsconfig.json` | TypeScript config |

## Notes

- The pass condition is inclusive: drift equal to two samples still passes.
- More than 20 % rejected anchors makes the report `inconclusive`, never
  `pass`.
- Type-check it with `npm run check`.
