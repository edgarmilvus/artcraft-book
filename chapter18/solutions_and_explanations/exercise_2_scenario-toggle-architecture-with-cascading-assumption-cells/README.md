# 18. Exercise 2: Scenario Toggle Architecture — solution

The worked five-year Helios model. One `Scenario.Active` switch selects a
column of Bear/Base/Bull/Doom assumptions; four calculation sheets read only
the resolved `Effective.*` names.

## What it does

1. Builds the workbook over GridCraft MCP: an assumptions sheet, controller
   overrides and four calculation sheets.
2. Derives the dependency map from the engine state and cross-checks it with
   `formulas.tracePrecedents`; refuses to continue if the graph is not a DAG.
3. Toggles the same scenario twice and proves every named output and the saved
   workbook are byte-identical.
4. Runs a real two-process race over a loopback JSON control channel: a
   scheduler toggles every 50 ms while a reader hammers a named output. The
   reader may see only the two legal values, never a half-updated tree.
5. Rejects an illegal scenario index with a structured error; the previous
   scenario stays in effect and no write is persisted.
6. Reopens the saved workbook in a fresh session and checks every name,
   scenario and top-line value.

## Run it

```bash
cd chapter18/solutions_and_explanations/exercise_2_scenario-toggle-architecture-with-cascading-assumption-cells/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex2.py
```

```
63 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/helios-scenario-model.xlsx` | the scenario-driven model |
| `output/scenario-race-report.json` | scheduler/reader counts, legal values and latency |
| `output/dependency-map.json` | the audited graph, names and edges |
| `output/work/out/toggle-once.xlsx`, `toggle-twice.xlsx` | the idempotency pair |
| `output/work/out/before-rejection.json`, `after-rejection.json` | the fail-closed proof |
| `output/run_ex2.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/02_scenario-toggle-architecture-with-cascading-assumption-cells.py` | model, dependency audit, control channel, race, rejection and reopen |
| `files/run_ex2.py` | the real-engine acceptance harness |
| `files/01_json.json`, `files/02_json.json` | the protocol contracts |

## Notes

- The race is a real two-process test, not a simulated interleaving.
- The DAG check fails closed before the model is saved, so a malformed graph
  cannot be published.
- The `Effective.*` indirection is what makes an illegal index safe: the
  switch is rejected before any calculation reads it.
- Type-check equivalent: `python3 -m py_compile` on the module and harness.
