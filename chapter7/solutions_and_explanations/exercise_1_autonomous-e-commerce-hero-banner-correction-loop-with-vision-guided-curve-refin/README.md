# 7. Solutions and Explanations

The worked solution to Exercise 1: a complete autonomous banner loop that
runs against `photocraft-cli mcp` with a vision stub. It captures the
document state before each pass, applies the vision model's corrections in a
`command_batch`, and stops when the model returns `clean: true` or after
three passes. Rollback is implemented via document snapshots (`doc_inspect`
before each pass, `doc_open` the snapshot on regression).

## What it does

`01_banner-loop.ts` implements the full Aperture loop for a single banner:
prefilter → render → vision audit (stub) → compile → apply → converge. The
stub returns a fixed sequence of corrections (add mask, reduce opacity,
adjust curves) so the loop is deterministic. The harness runs the loop,
asserts on the audit trail, and verifies the final document has all
corrections applied.

## The listings

| file | what it is |
| --- | --- |
| `01_banner-loop.ts` | the complete banner loop with snapshots and rollback |
| `02_solutions_and_explanations.json` | the correction sequence the stub returns |
| `03_solutions_and_explanations.json` | the expected final layer tree |
| `package.json` | npm scripts (`check`, `harness`) and dependencies |
| `tsconfig.json` | TypeScript config |

## Run it

```bash
cd chapter7/solutions_and_explanations/exercise_1_autonomous-e-commerce-hero-banner-correction-loop-with-vision-guided-curve-refin/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex1.ts
```

```
71 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/ex1/batch-failure/audit.ndjson` | audit trail for a failing batch |
| `output/ex1/batch-failure/iteration_0_after.png` | after correction |
| `output/ex1/batch-failure/iteration_0_before.png` | before correction |
| `output/ex1/batch-failure/iteration_0_critique.json` | vision model output |
| `output/ex1/batch-failure/iteration_0_ssd.json` | structural diff |
| `output/ex1/batch-failure/iteration_0_batch.json` | commands applied |
| `output/ex1/converge/result.png` | converged banner after the applied curve |
| `output/ex1/low-confidence/result.png` | escalation run with no correction applied |
| `output/ex1/dangerous/result.png` | footprint-guard escalation |
| `output/ex1/ssd/iteration_0_after.png` | document restored pixel-for-pixel after SSD rollback |
| `output/ex1/hero.png` | the generated fixture master |
| `output/ex1/report.json` | scenario index, assertion count and result summary |
| `output/run_ex1.log` | the harness log |

## Notes

- `photocraft-cli` on `PATH`.
- The solution is the reference for Exercises 2–6.
