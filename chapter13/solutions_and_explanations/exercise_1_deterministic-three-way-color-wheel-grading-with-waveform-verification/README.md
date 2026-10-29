# 13. Exercise 1: Deterministic Three-Way Color Wheel — solution

The worked grade verifier. It builds an eight-step Lumetri batch — LUT first,
then a color vector and luma offset per band — and proves the result with
four scope invariants rather than by eye.

## What it does

1. `buildGradingBatch()` emits the input LUT, enables the Basic section, then
   writes `wheel_shadows`, `wheel_shadows_l`, `wheel_midtones`,
   `wheel_midtones_l`, `wheel_highlights`, `wheel_highlights_l`.
2. The LUT is applied first because the wheels react to post-LUT code values.
3. `extractScope()` tolerates either a top-level or `data`-wrapped scope
   payload and reads 16 parade bins and 16 waveform columns.
4. `assertScopes()` checks four invariants: parade top bins ≤ 100 IRE, the
   waveform within 0–100 IRE, midtone mean Y in 25–75 IRE, and a teal shadow
   lift of at least 0.03 IRE.
5. A failed clip is rolled back one `edit.undo` per applied command; the
   linear undo depth is recorded in the rollback plan.

## Run it

```bash
cd chapter13/solutions_and_explanations/exercise_1_deterministic-three-way-color-wheel-grading-with-waveform-verification/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex1.ts
```

```
26 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/scopes.json` | the four pass/fail readouts, including the three failing counter-examples |
| `output/delivery_report.json` | clip batch depth, scope verdict and rollback plan |
| `output/verification.png` | a 960×540 verification frame |
| `output/report.json` | assertion count, batch shape and artifact list |
| `output/run_ex1.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/01_solutions_and_explanations.ts` | batch builder, scope extractor, four invariants, linear undo and `run()` |
| `files/run_ex1.ts` | the acceptance harness: batch order and scope invariants |
| `files/package.json` | npm scripts and dependencies |
| `files/tsconfig.json` | TypeScript config |

## Notes

- The batch is eight steps, not eleven: one LUT, one Basic flag, and six wheel
  parameters.
- The harness exercises the pure scope layer; `run()` is the live FilmCraft
  path.
- Type-check it with `npm run check`.
