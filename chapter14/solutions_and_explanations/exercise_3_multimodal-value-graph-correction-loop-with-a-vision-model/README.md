# 14. Exercise 3: Multimodal Value-Graph Correction Loop — solution

The worked value-graph loop. It renders a frame, asks a vision model for a
score in the closed −3…+3 range, changes one influence coordinate, and stops
on convergence, the budget or a local minimum.

## What it does

1. `isVisionScore()` accepts only a numeric score in `[-3, 3]`.
2. `clamp()` keeps each influence handle inside `[0.05, 0.95]`.
3. `mean()` ignores `null` renders and reports +∞ when every sample failed.
4. The engine loop samples six frames per pass, re-renders after every accepted
   coordinate change, and records the scores, mean, best-so-far and action.
5. It stops on `converged`, `budget` or `localMinimum`, and records dropped
   frames instead of hiding them.

## Run it

```bash
cd chapter14/solutions_and_explanations/exercise_3_multimodal-value-graph-correction-loop-with-a-vision-model/files
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
| `output/loop-report.json` | config, three iteration records and the final influence vector |
| `output/frames/iter_1.png` … `iter_3.png` | 960×540 preview frames |
| `output/report.json` | assertion count, final mean and artifact list |
| `output/run_ex3.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/03_multimodal-value-graph-correction-loop-with-a-vision-model.ts` | harness transport, score schema, influence clamp, sampling and loop |
| `files/run_ex3.ts` | the acceptance harness: schema, clamps, means and a converged report |
| `files/01_typescript.ts` | the loop configuration and report contract |

## Notes

- The score range is enforced in code, not by trusting the model's prose.
- An influence value outside the bounds is clamped before it reaches the
  engine; the report keeps the accepted vector.
- Type-check it with `npm run check`.
