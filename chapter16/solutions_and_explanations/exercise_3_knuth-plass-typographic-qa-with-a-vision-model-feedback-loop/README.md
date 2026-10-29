# 16. Exercise 3: Knuth-Plass Typographic QA — solution

The worked multimodal correction loop. Each spread is rendered at 2×, a vision
model scores rivers, widows, orphans and loose lines, and only cascade-safe
style edits are applied.

## What it does

1. `captureStyles()` snapshots paragraph and character styles before the first
   pass, so an aborted chapter can be restored rather than flagged.
2. `applySurgicalFix()` edits the base style in place only when nothing is
   based on it. If a derived style exists, it creates
   `<style>.spread-NN` and reassigns just that spread's paragraphs.
3. `paraFrom()` / `charsFrom()` translate the vision model's attribute names
   into the engine's paragraph/character schema.
4. `visionPass()` counts hyphenated line ends and only treats `severity: high`
   rivers as hard defects.
5. `isClean()` requires no high river, widow or orphan and at most two
   consecutive hyphens.
6. `isConvergedWithWarnings()` accepts low-severity rivers or loose lines once
   every hard defect is gone. The previous predicate required `isClean()`,
   making the branch unreachable.
7. `qaSpread()` runs at most three passes, rejects word-spacing suggestions
   below 85%, and restores the snapshot when a spread aborts.
8. `runChapterQA()` writes the style snapshot and the chapter summary.

## Run it

```bash
cd chapter16/solutions_and_explanations/exercise_3_knuth-plass-typographic-qa-with-a-vision-model-feedback-loop/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex3.ts
```

```
51 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/build/qa/spread-0/pass-1-page-1.png` … `pass-2-page-2.png` | four real 800×600 renders |
| `output/build/styles-snapshot.json` | the pre-pass style snapshot |
| `output/build/chapter-qa-summary.json` | clean/aborted counts and the blocked flag |
| `output/build/spread-0-report.json` | both passes, metrics, suggestions and outcome |
| `output/report.json` | assertion count and artifact list |
| `output/run_ex3.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/03_knuth-plass-typographic-qa-with-a-vision-model-feedback-loop.ts` | snapshot, surgical fixes, render, vision, convergence and restore |
| `files/run_ex3.ts` | the acceptance harness with a scripted vision model |
| `files/package.json` | npm scripts and dependencies |

## Notes

- The scripted model returns a widow plus one hyphenation suggestion on pass 1
  and a clean spread on pass 2, so the loop exercises both branches.
- The abort test runs three dirty passes and asserts that exactly one restore
  batch is issued from the saved snapshot.
- Type-check it with `npm run check`.
