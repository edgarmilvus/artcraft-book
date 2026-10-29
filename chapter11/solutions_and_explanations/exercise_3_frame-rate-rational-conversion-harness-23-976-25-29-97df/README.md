# 11. Exercise 3: Frame-Rate Rational Conversion Harness — solution

The worked conversion harness. It maps a 25 fps EDL to 23.976 with one
rational, measures the residual in ticks, microseconds and 48 kHz samples,
and round-trips 29.97 drop-frame timecode.

## What it does

1. Declares the integer ground truth: `254_016_000_000` ticks per second,
   `10_160_640_000` per 25 fps frame and `10_594_584_000` per 23.976 frame.
2. Converts a 25 fps frame with `f25 × 25025 / 24000` and rounds with
   round-half-to-even.
3. Computes the residual from the same integers:
   `(numer − rounded × denom) × TICKS_23976 / denom`.
4. Emits 29.97 drop-frame timecode and recovers the nominal frame; a
   module-load self-test round-trips every 97th frame over two hours.
5. Throws if any residual exceeds half a target frame.
6. `writeCsv()` exports one row per cut edge.

## Run it

```bash
cd chapter11/solutions_and_explanations/exercise_3_frame-rate-rational-conversion-harness-23-976-25-29-97df/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex3.ts
```

```
29 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/edl-conversion.csv` | one row per cut edge with source/target ticks and DF timecode |
| `output/parity-report.json` | all rows plus max residual in ticks, µs and samples |
| `output/report.json` | cut count, bounds, DF failures and artifact list |
| `output/run_ex3.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/03_frame-rate-rational-conversion-harness-23-976-25-29-97df.ts` | rational conversion, residual math, DF timecode and CSV writer |
| `files/run_ex3.ts` | the acceptance harness: 12-cut EDL, half-frame bound and DF round trips |
| `files/01_typescript.ts` | the EDL and parity contract |
| `files/package.json` | npm scripts and dependencies |
| `files/tsconfig.json` | TypeScript config |

## Notes

- The drop-frame helpers were corrected to the standard 17982/1798 frame
  relationship; the original snippet failed its own round trip at frame
  19788.
- The half-frame limit is `5_297_292_000` ticks.
- Type-check it with `npm run check`.
