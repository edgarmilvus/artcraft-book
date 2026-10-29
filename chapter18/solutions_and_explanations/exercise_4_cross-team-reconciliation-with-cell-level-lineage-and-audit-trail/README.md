# 18. Exercise 4: Cross-Team Reconciliation — solution

The worked close. FP&A, Accounting and Treasury workbooks are opened together,
consolidation accounts are reconciled, and the lineage behind every verdict is
published as a cell-level audit trail.

## What it does

1. Opens the forecast, actuals and cash workbooks in one GridCraft session
   and reads the reconciliation fixture.
2. Walks the dependency graph backwards from each reconciliation cell and
   scores ancestors. At most `LINEAGE_LIMIT` provenance rows are emitted;
   ranges become one block row and the direct precedents are always kept.
3. Recomputes each account verdict from the values the engine reports.
4. Writes three artifacts: a reconciliation workbook (`Lineage`, `Verdicts`,
   `Remediation`), a PDF audit package exported by GridCraft and a JSON
   report.
5. Proposes and applies bounded remediation: rounding artifacts adjust the
   outlier cell, structural differences become reconciling items with a prior
   precedent, and every attempt explains itself.
6. Verifies the source workbooks are byte-identical after the run and the
   engine's own audit is still clean.
7. Reruns cleanly and produces the same audit digest and report.

## Run it

```bash
cd chapter18/solutions_and_explanations/exercise_4_cross-team-reconciliation-with-cell-level-lineage-and-audit-trail/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex4.py
```

```
64 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/close-reconciliation.xlsx` | lineage, verdicts and remediation sheets |
| `output/close-reconciliation.pdf` | the exported audit package |
| `output/reconciliation-report.json` | verdicts, lineage, remediation and source digests |
| `output/work/fixtures/` | the three source workbooks and prior snapshot |
| `output/work/out/close-reconciliation-scratch.xlsx` | the simulated remediation |
| `output/run_ex4.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/04_cross-team-reconciliation-with-cell-level-lineage-and-audit-trail.py` | graph walk, lineage scoring, verdicts, remediation and export |
| `files/run_ex4.py` | the real-engine acceptance harness |
| `files/01_typescript.ts`, `files/02_typescript.ts` | the report contracts |

## Notes

- Lineage is bounded, not exhaustive: the fan-in would otherwise swamp an
  auditor. The budget is spent on the highest-salience ancestors.
- A cell that both moved and was flagged carries both reasons in one row.
- The source workbooks are hashed before and after; a write to a source fails
  the run.
- Type-check equivalent: `python3 -m py_compile` on the module and harness.
