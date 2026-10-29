# 13. Exercise 5: End-to-End Delivery Pipeline — solution

The worked delivery normalizer. Three incompatible client briefs are reduced
to one `DeliverySpec`; the same grade, duck and loudness stages then apply to
every client without branch-specific timeline code.

## What it does

1. `normalizeSpec()` maps each brief to a common spec:
   - **StreamingA** always resolves to the streaming standard (−14 LUFS,
     ±1 LU, −1 dBTP), preserving tone and codec.
   - **StreamingB** maps free-form adjectives to the canonical tone and maps
     the codec profile (`4444` or `hq`).
   - **BroadcastX** maps the style guide to a tone, keeps the delivery
     standard's target/tolerance and the brief's true-peak ceiling, and sums
     `hours:minutes:seconds`.
2. `STANDARD_LOOKUP` supplies the target, tolerance, true-peak ceiling and
   duck depth for EBU R128, ATSC A85 and streaming.
3. The engine pipeline preflights media and duration, grades every clip,
   ducks the music, verifies loudness and exports with a media probe.
4. The manifest records spec normalization, grade evidence, audio evidence,
   export evidence and an idempotency hash over content revision + spec hash
   + pipeline version.

## Run it

```bash
cd chapter13/solutions_and_explanations/exercise_5_end-to-end-delivery-pipeline-integrating-three-way-grade-ducking-and-lufs-govern/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex5.ts
```

```
31 assertions passed
```

The harness checks the pure normalizer and writes the normalized specs and a
representative manifest; `runPipeline()` is the engine path.

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/normalized-specs.json` | the three normalized client specs |
| `output/delivery_manifest.json` | spec, grade/audio/export evidence and the idempotency hash |
| `output/report.json` | assertion count, clients and artifact list |
| `output/run_ex5.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/05_end-to-end-delivery-pipeline-integrating-three-way-grade-ducking-and-lufs-governance.ts` | lookup tables, normalizer, preflight, grade, duck, export and manifest |
| `files/run_ex5.ts` | the acceptance harness: one brief per client, lookup table and manifest checks |
| `files/01_typescript.ts` | the raw-spec and delivery-manifest contract |

## Notes

- The true-peak ceiling comes from the client brief where the brief supplies
  one, and from the standard table otherwise.
- The idempotency hash is content-addressed; the timestamp does not affect it.
- Type-check it with `npm run check`.
