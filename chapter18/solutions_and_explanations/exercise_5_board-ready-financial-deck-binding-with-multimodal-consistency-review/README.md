# 18. Exercise 5: Board-Ready Deck Binding — solution

The worked board deck. Audited GridCraft figures are bound into named DeckCraft
frames, every slide is rendered and reviewed, and bounded corrections are
applied without ever rewriting a figure.

## What it does

1. Reads the audited figures from the consolidated and close workbooks.
2. Authors the board deck through DeckCraft and binds every figure into a
   named frame; the binding map is persisted.
3. Renders every slide to PNG, runs the vision reviewer and applies bounded
   corrections: move, resize, restyle, re-flow.
4. Enforces the cardinal rule in code: a correction may **not** write text.
   A finding that needs a changed number goes to the human review queue.
5. Records the screenshot and hash of every slide, before and after each
   correction, so the forensic chain joins both iterations.
6. Handles a malformed reviewer answer by refusing it and asking again, and a
   reviewer that never answers by stopping the run while still writing an
   audit report.
7. Re-runs the binding pass after a synthetic workbook adjustment, and the
   deck follows the workbook while the hand-typed figure stays untouched.

## Run it

```bash
cd chapter18/solutions_and_explanations/exercise_5_board-ready-financial-deck-binding-with-multimodal-consistency-review/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex5.py
```

```
69 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/helios-board-2026-09.deck` | the bound board deck |
| `output/helios-board-2026-09.pdf` | the exported deck |
| `output/bindings.json` | every figure-to-frame binding |
| `output/deck-audit-report.json` | iterations, screenshots, corrections, queue |
| `output/work/out/audit-screenshots/` | all before/after slide PNGs |
| `output/work/out-broken/` | the failed-run report and screenshots |
| `output/run_ex5.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/05_board-ready-financial-deck-binding-with-multimodal-consistency-review.py` | figure binding, render loop, bounded corrections, review queue and audit |
| `files/run_ex5.py` | the real-engine acceptance harness |

## Notes

- The hand-typed figure is the control: the loop must never touch it.
- A correction that would change a number is escalated, not applied.
- The report keeps the reviewer's raw answer, including the malformed one,
  so a human can audit the refusal.
- Type-check equivalent: `python3 -m py_compile` on the module and harness.
