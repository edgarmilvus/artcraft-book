# 7. Exercise 4: LightCraft RAW Batch Grading — Reference-Anchored Iterative Matching Loop — solution

The worked solution for Exercise 4. It imports a source photo and a
reference look into LightCraft, measures the proxy and reference per
luminance zone in CIELAB, and converts the vision model's directional
critique into real develop-control deltas.

## What it does

1. Imports the source image through `lightcraft-cli mcp` over stdio and
   renders the reference look once.
2. Grades the photo from an intentionally wrong starting preset.
3. For each iteration: renders a proxy, compares shadow/midtone/highlight
   ΔE 2000 against the reference, and asks the vision model which way each
   zone should move.
4. Maps directions and magnitudes to LightCraft controls (`light.exposure`,
   `light.shadows`, `light.highlights`, `wb.temp`, and others), applies the
   delta, and records the per-control convergence history.
5. Stops on a flat ΔE history, a trusted quadratic vertex, a maximum
   iteration count, or two consecutive low-confidence reads. Low confidence
   rolls the development back.
6. Runs a short batch, a budget-interrupted batch with resume state, and the
   optional TCP control channel against a stub server.

The harness also unit-tests the CIEDE2000 conversion, per-zone comparison,
quadratic fit trust rules and the convergence predicates.

## Run it

```bash
cd chapter7/solutions_and_explanations/exercise_4_lightcraft-raw-batch-grading-reference-anchored-iterative-matching-loop/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex4.ts
```

The engine CLI must be on `PATH`:

```bash
export PATH="/path/to/repo/tools/craft-cli/bin:$PATH"
```

```
52 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/source.png` | the synthetic source photo imported into LightCraft |
| `output/reference.png` | the reference look rendered once from the target grade |
| `output/proxy-final.png` | the converged proxy after the iterative grade |
| `output/proxy-rollback.png` | the proxy from the low-confidence rollback run |
| `output/grading_report.json` | initial/final zone ΔE, applied deltas, iterations, convergence reason |
| `output/report-rollback.json` | the escalated, rolled-back report |
| `output/report.json` | scenario index, assertion count and artifact list |
| `output/run_ex4.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/04_lightcraft-raw-batch-grading-reference-anchored-iterative-matching-loop.ts` | color math, session wrapper, quadratic fit, convergence and batch runner |
| `files/run_ex4.ts` | the acceptance harness: live grading, rollback, TCP stub and units |
| `files/package.json` | npm scripts and dependencies |
| `files/tsconfig.json` | TypeScript config |

## Notes

- `lightcraft-cli` must be on `PATH`. LightCraft has no automation roots, so
  the harness keeps its inputs under `files/input/` and its evidence under
  `../output/`.
- The vision critique is scripted, so no API key is needed. The script reads
  the actual proxy and reference pixels to decide each direction.
- The TCP check uses a local stub server, not LightCraft's production
  control surface; it verifies the client's auth frame, command routing and
  proxy rendering.
- `npm run check` type-checks the solution module and the harness.
