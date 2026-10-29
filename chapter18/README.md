# Chapter 18 — Financial Engineering at Scale - Managing Multi-Sheet Formulas and Audits in GridCraft and DeckCraft

The chapter drives GridCraft and DeckCraft over MCP: it builds a multi-sheet
financial model, audits its dependency graph, and publishes a board-ready
deck that is bound to the audited numbers.

## The projects

Each project has its own README with the command to run it and the
artifacts it writes.

| project | what it is |
| --- | --- |
| [Advanced Application Implementation](advanced_application_implementation/example/) | A treasury platform's monthly job: rebuild a multi-sheet financial model, prove it is sound, and publish a board-ready deck whose numbers are read… |
| [Basic Code Example](basic_code_example/example/) | One request handler that owns a GridCraft workbook from new_workbook to save_workbook: it builds an assumptions sheet with named ranges, a… |
| [Solution — Exercise 1](solutions_and_explanations/exercise_1_multi-entity-consolidation-with-named-ranges-and-cross-sheet-references/) | The worked multi-entity consolidation: named ranges, FX, eliminations and fail-closed drift detection. |
| [Solution — Exercise 2](solutions_and_explanations/exercise_2_scenario-toggle-architecture-with-cascading-assumption-cells/) | The worked scenario toggle: DAG audit, two-process race and fail-closed rejection. |
| [Solution — Exercise 3](solutions_and_explanations/exercise_3_autonomous-circular-reference-forensics-and-remediation-agentic-challenge/) | The worked circular-reference forensics: scored breaks, atomic patches and re-verification. |
| [Solution — Exercise 4](solutions_and_explanations/exercise_4_cross-team-reconciliation-with-cell-level-lineage-and-audit-trail/) | The worked cross-team close: bounded lineage, verdicts and an exported audit package. |
| [Solution — Exercise 5](solutions_and_explanations/exercise_5_board-ready-financial-deck-binding-with-multimodal-consistency-review/) | The worked board deck: named bindings, screenshot audit loop and human review queue. |

## What you need

Node.js 22.5+, Python 3.10+ and the engine binaries — or just Docker. The
root README sets out both paths and the one-time setup:
[what you need](../README.md#what-you-need) and
[install](../README.md#install).

## Run everything

```bash
./chapter18/run_all.sh
```

The script runs every harness in the chapter, prints one line per
harness, and exits non-zero if any of them fails. Each harness leaves
its log in the `output/` directory of the project it exercises.

To run a single project, open its README: it gives the exact command
and the environment that command needs.

## Notes on the engines

The details that will bite you first:

- **GridCraft's meta-tools are `execute_command`, `list_commands`,
  `inspect_workbook`** — not `command_run` / `command_list` /
  `doc_inspect`.
- **GridCraft has no batch tool** — every write is its own round trip and
  the earlier writes stay applied, so atomicity has to be implemented in
  the worker.
- **GridCraft's MCP takes no directory flag** — `--automation-read-root`
  is an *error* there, not a no-op. Its boundary is the working
  directory. DeckCraft's MCP does take the flags, and enforces them.
- **There is no `.grid` container** — `file.save` writes `.xlsx`, `.csv`,
  `.tsv`, `.json` or `.html`, and refuses anything else.
- **A circular reference evaluates to `#CIRC!`** — `formulas.errorChecking`
  names the cells in the cycle, and the tracer works on the active sheet
  only.
- **A named range may contain dots but not hyphens**, and its reference
  must be fully absolute.
