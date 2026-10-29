# 16. Exercise 5: Template Rebind from a Legacy IDML — solution

The worked 2022→2026 rebind. Three legacy styles are mapped to the canonical
set, eight stories are rethreaded through their new spread chains, orphan
frames are removed and the baseline grid is ported to the taller paper.

## What it does

1. `openTemplate()` opens the IDML and records the embedded Document Fonts.
2. `applyStyleMap()` creates any missing canonical style, reapplies it to
   every paragraph carrying the legacy name, then deletes the legacy style
   with `replaceWith`, all in one batch.
3. `rewireStory()` unlinks the frames in the target spreads, seeds a new
   story, links the continuation frames and checks `get_story().overset`.
4. `removeOrphans()` deletes unowned non-master text frames after all threads
   exist.
5. `resolveFonts()` preserves faces shipped in Document Fonts
   (`embedding-restricted`) and otherwise applies the supplied fallback with
   `redefineStyles: true`.
6. `portGrid()` scales start and increment by the paper-height ratio.
7. `assertPostConditions()` requires single-story frames, terminated threads,
   canonical style names and no missing fonts.

## Run it

```bash
cd chapter16/solutions_and_explanations/exercise_5_template-rebind-style-map-and-thread-rewiring-from-a-legacy-idml/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex5.ts
```

```
52 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/annual-report-2022.idml` | a real, engine-openable IDML package |
| `output/annual-report-2026.designcraft` | a real DesignCraft zip saved by the engine |
| `output/rebind-report.json` | style map, eight rewired stories, fonts, grid and post-conditions |
| `output/font-substitutions.json` | the substitution ledger |
| `output/grid-port.json` | 48→52 pt start and 13→14 pt increment at 792→850 pt |
| `output/report.json` | assertion count and artifact list |
| `output/run_ex5.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/05_template-rebind-style-map-and-thread-rewiring-from-a-legacy-idml.ts` | open, style map, rewire, orphans, fonts, grid port and post-conditions |
| `files/run_ex5.ts` | the acceptance harness with scripted engine responses |
| `files/package.json` | npm scripts and dependencies |

## Notes

- `runRebind()` accepts an optional DC override so the full eight-story
  pipeline can run without a desktop session; the default still connects to
  `designcraft-cli`. After the report is signed, the harness opens the IDML
  through the real engine and saves the `.designcraft` package.
- The unresolved-font case is tested to hard-fail **after** the document is
  saved, so a failed rebind still leaves a recoverable artifact.
- The grid port uses inclusive rounding: 850/792 × 48 = 51.5 → 52, and
  850/792 × 13 = 13.95 → 14.
- Type-check it with `npm run check`.
