# 13. Exercise 3: LUFS / True-Peak Loudness Governance — solution

The worked loudness governor. A 42-minute program is measured, hot windows
are localized, and a four-rung ladder tries gain, noise repair, a master
limiter and finally escalation — each rung chosen for a different cause.

## What it does

1. Measures integrated loudness from Essential Sound: measured LUFS plus the
   applied clip gain, averaged over the measured clips.
2. Sweeps 10-second windows for true peak and 3-second short-term loudness,
   recording any window over −2 dBTP or −20 LUFS.
3. Flags silence gaps over 200 ms.
4. `decide()` builds the ladder:
   - **iteration 1** — clip gain equal to the negative integrated error;
   - **iteration 2** — noise repair (35) for dense windows that are loud but
     not peak-driven;
   - **iteration 3** — a −2 dBTP master limiter as the last non-destructive
     option;
   - **iteration 4** — escalate with the residual LU and dBTP.
5. Stops early when the measurement is within ±2 LU of −24 and at or below
   −2 dBTP.

## Run it

```bash
cd chapter13/solutions_and_explanations/exercise_3_lufs-true-peak-loudness-governance-with-autonomous-remediation/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex3.ts
```

```
22 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/governance_report.json` | spec, measurements, decisions, final status and residuals |
| `output/report.json` | ladder summary, target and artifact list |
| `output/run_ex3.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/03_lufs-true-peak-loudness-governance-with-autonomous-remediation.ts` | measurement, decision ladder, apply, loop and report |
| `files/run_ex3.ts` | the acceptance harness: all four decisions and the compliant final report |
| `files/01_typescript.ts` | the loudness spec and report contract |

## Notes

- The integrated value is the average of measured loudness plus clip gain, not
  a scope reading; FilmCraft has no loudness scope.
- The limiter is a last resort because short-lookahead limiting is not
  transparent.
- Type-check it with `npm run check`.
