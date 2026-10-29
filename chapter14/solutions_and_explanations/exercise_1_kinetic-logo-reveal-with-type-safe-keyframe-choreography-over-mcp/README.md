# 14. Exercise 1: Kinetic Logo Reveal / Franchise Rig Batch — solution

The worked franchise rig. It builds one atomic five-step rig plan for a logo
reveal, gates the wordmark font against TOFU risk, and keeps every write
inside the configured root.

## What it does

1. `buildRigSteps()` declares the rig as data: a null controller, a renamed
   `Null – Rig`, an accent bar, the wordmark and the tagline.
2. The wordmark/tagline positions are derived from the composition center,
   so the plan is deterministic for a fixed canvas.
3. `tofuRisk()` warns when a combining mark is requested from a bundled font
   that has no locale-specific coverage.
4. `underRoot()` fails closed on any path that escapes the write root.
5. The engine path activates the composition, verifies its frame rate and
   duration, submits the rig as one atomic batch and discovers the created
   layer ids from `get_comp`.

## Run it

```bash
cd chapter14/solutions_and_explanations/exercise_1_kinetic-logo-reveal-with-type-safe-keyframe-choreography-over-mcp/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex1.ts
```

```
18 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/rig-steps.json` | the five primitive commands and their parameters |
| `output/preview.png` | a 1920×1080 logo-layout preview |
| `output/report.json` | assertion count, step list and artifact list |
| `output/run_ex1.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/01_franchise-batch.ts` | rig plan, font guard, path guard, guard registry and franchise batch |
| `files/run_ex1.ts` | the acceptance harness: plan order, TOFU gate and path escape |
| `files/package.json` | npm scripts and dependencies |
| `files/tsconfig.json` | TypeScript config |

## Notes

- The harness proves the pure plan; `runFranchise()` is the live EffectCraft
  path.
- The null controller is created first so the later layers can be parented
  to it without a second pass.
- Type-check it with `npm run check`.
