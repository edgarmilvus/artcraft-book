# 18. Solutions and Explanations

The worked solution to Exercise 1. Helios Systems files a P&L in four
jurisdictions, each entity with its own chart of accounts and its own
reporting currency, and the parent has to consolidate them into one statement
whose every number can be traced back to a named source. The solution builds
that statement headlessly through GridCraft and ends with a machine-readable
proof that `Σ(entity totals in USD) − eliminations = consolidated total`.

## What it does

The model is declarative before it is arithmetic. `CANONICAL_ACCOUNTS` is the
parent's chart — seven lines, each with a canonical key, the local account code
and description the entity files, and the entities that report it. A
controller who renames a line, renumbers an account or invents one does not get
a silently wrong consolidation: the run stops.

```
list_commands                     the engine's own catalogue, checked before the first write
new_workbook → sheet.rename(Sheet1 → Consolidated)
data.fromTextCsv ×6               four entity sheets, the FX table, the eliminations block
file.properties
formulas.defineName ×n            <Entity>.<Account> anchors, FX.<CCY>.<CCY>, and the elimination block
write_range                       the consolidated column: formulas that read names only
format_range                      #,##0.00;[Red]-#,##0.00 for money, 0.0000 for rates
formulas.calculateNow
```

Every consolidated cell is a formula over defined names — no raw `A1`
reference crosses a sheet boundary, which is what the tracer check asserts.
Names are sanitized on the way in: a defined name may contain dots but not
hyphens, so `Helios-US` becomes `Helios_US` and the anchor reads
`Helios_US.Amount.Rev_Net`. Sheet references that must keep the hyphen are
quoted (`'Helios-US'!$C$2`).

The proof is then re-verified from the saved file, not from the in-memory
model: a **fresh engine session** opens `helios-consolidated.xlsx`, recalculates
it, re-reads `formulas.nameManager`, re-runs `formulas.errorChecking` and the
precedent tracer, and compares the numbers to the fixture arithmetic. Finally
the whole build runs a second time and the two workbooks are compared byte for
byte.

When the run fails closed it writes `consolidation-error.json` with the entity,
the account and the defined name that could not be anchored — never a stack
trace.

## The listings

| file | what it is |
| --- | --- |
| `01_helios_consolidation.py` | the solution: the canonical chart, the MCP stdio client, the `Consolidation` class, the verifier and the `run()` driver |
| `run_ex1.py` | the harness — fixtures, the clean run, the idempotent rerun, and three corrupted-fixture runs |

## Run it

```bash
cd chapter18/solutions_and_explanations/exercise_1_multi-entity-consolidation-with-named-ranges-and-cross-sheet-references/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex1.py
```

The harness writes four entity fixtures plus the FX and intercompany files,
runs the solution, reopens the workbook in a second engine session, reruns the
build, then corrupts a fixture three ways — a renamed line, a renumbered
account, an unknown account.

```
PASS the engine's oracle recalculates every formula cell
PASS the consolidated total is the entity sum less the eliminations
PASS the saved workbook is byte-identical
PASS a renamed line fails the run closed
PASS the failure names the defined name that could not be anchored

74 assertions passed
```

## What it produces

Everything lands under `output/work/`; the headline files are also copied to
`output/`:

| artifact | what it is |
| --- | --- |
| `output/helios-consolidated.xlsx` | the consolidated workbook (also under `work/out/`) |
| `output/consolidation-proof.json` | the proof (also under `work/out/`) |
| `output/consolidation-error.json` | a fail-closed proof from the renamed-line fixture |
| `out/helios-consolidated.xlsx` | the consolidated workbook — seven sheets: `Consolidated`, four entities, `FX`, `Eliminations` |
| `out/consolidation-proof.json` | the proof: workbook digest and size, names, the engine's command catalog, per-entity totals, the invariant, the re-opened workbook's numbers |
| `work/out-code/consolidation-error.json` | written only on a fail-closed run, naming the entity, account and missing anchor |
| `fixtures/` · `fixtures-code/` · `fixtures-label/` · `fixtures-unknown/` | the CSV fixtures each run consumes |
| `out-two/` | the second run's workbook and proof, for the byte comparison |

## Notes

- **`gridcraft-cli` on `PATH`.** The harness adds `tools/craft-cli/bin` when it
  is there; nothing else is needed — no API key, no service.
- **Period `2026-09`** is fixed in the fixtures and in the FX table, so the
  numbers do not depend on the day the run happens.
- **Money is compared at `1e-6`.** The consolidation is floating point;
  the tolerance is the model's, not the test's.
- **`data.fromTextCsv` creates a sheet per file**, which is why the build
  starts by renaming `Sheet1` and then lets the imports land the rest.
