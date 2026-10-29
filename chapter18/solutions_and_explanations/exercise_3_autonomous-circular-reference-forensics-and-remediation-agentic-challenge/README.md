# 18. Exercise 3: Circular-Reference Forensics — solution

The worked remediation agent. It discovers cycles in an inherited planning
workbook, scores three break strategies, applies each break atomically and
proves the result with the engine's own auditor.

## What it does

1. Reads the live command catalog before using any command id.
2. Detects cycles with `formulas.errorChecking`, extracts their formulas and
   classifies each one (roll-forward, self-reference, aggregate/name cycle).
3. Scores every candidate break on three published axes and writes a
   human-readable rationale plus ranked alternatives.
4. Applies one break per cycle with an in-worker atomicity contract: capture
   the cells a step touches, apply, restore in reverse order on failure.
5. Re-detects cycles after each break, then reopens the saved workbook and
   confirms only the intentionally iterative block is still circular.
6. Renders one PNG preview per corrected sheet and writes a Markdown report
   with formulas before/after and proposals separated from applied changes.
7. Reruns cleanly: the second pass finds the same cycles and leaves the same
   remediated workbook.

## Run it

```bash
cd chapter18/solutions_and_explanations/exercise_3_autonomous-circular-reference-forensics-and-remediation-agentic-challenge/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex3.py
```

```
71 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/legacy-plan-grid-remediated.xlsx` | the corrected workbook |
| `output/remediation-report.md` | the human-readable forensic report |
| `output/remediation-report.json` | cycles, scores, alternatives and applied breaks |
| `output/dependency-graph.json` | the parsed graph |
| `output/sheet-Interest.png` | one rendered sheet preview (all previews are under `output/work/out/previews/`) |
| `output/work/fixtures/legacy-plan-grid.xlsx` | the inherited broken workbook |
| `output/run_ex3.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/03_autonomous-circular-reference-forensics-and-remediation-agentic-challenge.py` | discovery, scoring, atomic break, verification and reporting |
| `files/run_ex3.py` | the real-engine acceptance harness |
| `files/01_typescript.ts`, `files/02_json.json` | the report and protocol contracts |

## Notes

- The inherited file is never written to; only the remediated copy is saved.
- The agent tags every broken cell with the cycle it broke, so the audit tag
  survives the save and is visible on reopen.
- The intentionally iterative interest block is reported as a warning, not
  silently “fixed” with a wrong closed-form.
- Type-check equivalent: `python3 -m py_compile` on the module and harness.
