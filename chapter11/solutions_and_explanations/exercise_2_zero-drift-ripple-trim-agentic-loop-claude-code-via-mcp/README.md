# 11. Exercise 2: Zero-Drift Ripple Trim Agentic Loop — solution

The worked ripple pass. Transcript milliseconds are snapped to whole 23.976
frame boundaries with round-half-to-even on BigInt rationals, and the
post-batch sequence duration must equal the pre-batch duration minus the
trimmed ticks exactly.

## What it does

1. `bankerRound()` performs round-half-to-even on `(n, d)`.
2. `snapToFrameTick()` lifts integer milliseconds with
   `ms × 254_016_000` and snaps to the nearest whole `10_594_584_000`-tick
   frame — never `Math.round(ms × fps)`.
3. `totalDurationTicks()` sums every clip duration on every track.
4. `buildRippleAudit()` applies the zero-tolerance invariant: the new total
   must equal the old total minus the trimmed span; a one-tick mismatch marks
   every row in the batch as failed.
5. The engine-backed path sends trims in batches of eight with
   `stop_on_error`, reads `sequence_inspect` back after each batch, and rolls
   the whole batch back on a violation.

## Run it

```bash
cd chapter11/solutions_and_explanations/exercise_2_zero-drift-ripple-trim-agentic-loop-claude-code-via-mcp/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex2.ts
```

```
30 assertions passed
```

The harness checks the pure rational and invariant layer; `runRipplePass()`
is the MCP production path.

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/ripple_audit.json` | two trim rows with zero drift |
| `output/ripple_audit_drift.json` | the same plan with a one-tick drift counter-example |
| `output/report.json` | constants, assertion count and artifact list |
| `output/run_ex2.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/02_zero-drift-ripple-trim-agentic-loop-claude-code-via-mcp.ts` | banker's rounding, frame snapping, sequence totals, audit builder and MCP loop |
| `files/run_ex2.ts` | the acceptance harness: rationals, snapping, totals and zero-drift invariant |
| `files/01_typescript.ts` | the trim and audit contract |
| `files/package.json` | npm scripts and dependencies |
| `files/tsconfig.json` | TypeScript config |

## Notes

- The frame constant is `254_016_000_000 × 1001 / 24000 = 10_594_584_000`
  ticks.
- The drift counter-example is stored beside the passing audit so the
  failure mode is inspectable.
- Type-check it with `npm run check`.
