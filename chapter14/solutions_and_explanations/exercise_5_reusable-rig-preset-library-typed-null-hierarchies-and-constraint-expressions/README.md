# 14. Exercise 5: Reusable Rig Preset Library — solution

The worked preset library. Five named rigs share one typed entry point; the
library validates the descriptor, merges defaults, rejects unknown parameters,
and guards the script result before returning.

## What it does

1. `PresetName` and the discriminated `ApplyArgs` make a wrong preset/param
   pairing a compile error.
2. `validatePresetParams()`:
   - rejects a preset whose version is newer than the runtime;
   - merges declared defaults;
   - refuses a value of the wrong type or outside `min`/`max`;
   - drops undeclared parameters with a warning.
3. `isAppliedPresetDetail()` validates the script's returned layers,
   expressions, essential-property controls and `reused` flag.
4. `describeApplied()` renders a human-readable one-line result per preset.
5. `applyPreset()` is atomic and idempotent: a second call reuses the same
   null hierarchy, and `dryRun` returns the plan without touching history.

## Run it

```bash
cd chapter14/solutions_and_explanations/exercise_5_reusable-rig-preset-library-typed-null-hierarchies-and-constraint-expressions/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex5.ts
```

```
23 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/preset-validation.json` | five descriptors, default merges and the rejected cases |
| `output/report.json` | assertion count, preset list and artifact list |
| `output/run_ex5.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/05_reusable-rig-preset-library-typed-null-hierarchies-and-constraint-expressions.ts` | descriptors, validation, result guard, apply/dry-run and describe |
| `files/run_ex5.ts` | the acceptance harness: five presets, range/type/version failures and the guard |
| `files/01_typescript.ts` | the public library surface |
| `files/02_typescript.ts` | the preset file schema |

## Notes

- Unknown parameters are dropped with a warning rather than silently changing
  the script.
- A preset newer than the runtime is refused instead of best-effort executed.
- Type-check it with `npm run check`.
