# 11. Exercise 1: Dialogue Ducking on the Integer Timebase — solution

The worked ducking tier. Dialogue word timings become exact tick positions,
overlapping words are coalesced into spoken groups, and every group gets an
attack/hold/release audit row measured in 48 kHz samples.

## What it does

1. Lifts a transcript millisecond to a tick with one integer multiply,
   `ms * 254_016_000`, and refuses a non-integral millisecond.
2. Sorts the words and coalesces overlapping intervals; the gap tolerance is
   `180_000_000` ticks (about 709 µs).
3. Emits one audit row per spoken group with the attack tick, release tick,
   expected 48 kHz samples and zero drift.
4. The engine-backed path sends one atomic `effects.setParam` /
   `effects.setInterpolation` batch per group and probes the music level one
   tick before, at and after the attack.
5. The audit is written as JSON and CSV, so it can be diffed or loaded by a
   downstream caption/sync step.

## Run it

```bash
cd chapter11/solutions_and_explanations/exercise_1_dialogue-ducking-on-the-integer-timebase/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex1.ts
```

```
22 assertions passed
```

The harness exercises the pure timebase and audit builder; the TCP ducking
entry point is the production path and needs a FilmCraft instance on 7979.

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/ducking_audit.json` | per-group attack/release ticks and sample counts |
| `output/ducking_audit.csv` | the same audit as a diffable CSV |
| `output/report.json` | timebase constants, assertion count and artifact list |
| `output/run_ex1.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/01_solutions_and_explanations.ts` | integer primitives, `msToTicks()`, `coalesce()`, `buildDuckingAudit()`, TCP client and ducking batch |
| `files/run_ex1.ts` | the acceptance harness: exact ticks, coalescing and audit rows |
| `files/package.json` | npm scripts and dependencies |
| `files/tsconfig.json` | TypeScript config |

## Notes

- No floating-point seconds are used in the plan; `render_frame` is the only
  place that converts for a measurement.
- One second is exactly `48_000 × 5_292_000` ticks.
- Type-check it with `npm run check`.
