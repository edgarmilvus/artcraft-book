# Circular-Reference Remediation Report

| | |
| --- | --- |
| Inherited workbook | `chapter18/solutions_and_explanations/exercise_3_autonomous-circular-reference-forensics-and-remediation-agentic-challenge/output/work/fixtures/legacy-plan-grid.xlsx` |
| sha256 before | `fe383dfb028407dbb18d55d4490d5d7ebcf88d1cada82a154adc03a0f379e08f` |
| Remediated workbook | `chapter18/solutions_and_explanations/exercise_3_autonomous-circular-reference-forensics-and-remediation-agentic-challenge/output/work/out/legacy-plan-grid-remediated.xlsx` |
| sha256 after | `6a363cd31be593c0fb29f7ff81c62703d71e0e2f0ab7696e0dc14b395e2af11e` |
| Cycles found | 5 |
| Breaks applied | 4 |
| Residual cycles | 0 |
| Deferred (iterative) cycles | 1 |
| Dependency graph | `chapter18/solutions_and_explanations/exercise_3_autonomous-circular-reference-forensics-and-remediation-agentic-challenge/output/work/out/dependency-graph.json` (33 nodes, 39 edges, acyclic outside the deferred cycles: True) |

## How the model was read

- **dependency graph** - sheet.read with formulas, parsed into nodes and edges
- **detector** - formulas.errorChecking, the engine's own auditor
- **tracer** - formulas.tracePrecedents, cross-checked on the cycle members
- **atomicity** - cell.set plus review.newNote applied as one break and rolled back together if a step fails
- **publish** - one file.save to a new path; the inherited file is never written to
- **previews** - the sheet region is rasterized by the agent from the values the engine computed; GridCraft cannot rasterize in headless mode, where its screenshot tool needs a UI session, so the engine's own HTML render of the sheet is used when no image library is available
- **scoring weights** - semantic_plausibility 0.45, formula_complexity 0.30, blast_radius 0.25

## Cycles found

| id | classification | members | disposition |
| --- | --- | --- | --- |
| cycle-001 | true | `Cash Flow!B12`, `Debt Schedule!B12`, `Debt Schedule!B13`, `Debt Schedule!B14`, `Interest!B12`, `Interest!B13` | broken |
| cycle-002 | true | `Cash Flow!C12`, `Debt Schedule!C12`, `Debt Schedule!C13`, `Debt Schedule!C14`, `Interest!C12`, `Interest!C13` | broken |
| cycle-003 | named-mutual | `Interest.Charge`, `Interest.Expense` | broken |
| cycle-004 | iterative | `Iterative Block!B11`, `Iterative Block!B12` | reported, not remediated (iterative by design) |
| cycle-005 | self | `Rollforward!C13` | broken |

## Breaks applied

### cycle-001

- Chosen break edge: `Interest!B12` -> `Debt Schedule!B14`
- Rewrite: `lag-opening-balance`
- Semantic plausibility: 5/5
- Blast radius: 6 cells outside the cycle
- Formula complexity: 2/5
- Total score: 4.3875
- Elementary cycles in the cluster: 2; cycles this edge closes: 2
- Verified acyclic after the break: True

```
before: =('Debt Schedule'!B11+'Debt Schedule'!B14)/2
after:  =('Debt Schedule'!B11+'Debt Schedule'!B11)/2
```

**Justification.** The cycle runs because Interest!B12 depends on the closing balance, the closing balance depends on the interest charge, and the interest charge depends on the closing balance. The break site selected here is the reference to the closing balance itself: rewriting it to the opening balance is the convention finance models already use when they accrue interest on the opening position, so the roll-forward keeps its economics and only the averaging is dropped (the closing reference 'Debt Schedule'!B14 is replaced by its opening counterpart 'Debt Schedule'!B11). The alternative break points score 0 on semantic plausibility against 5 here, so they are recorded but not applied.

Alternatives considered and ranked:

| break edge | semantic | blast | complexity | score | applicable | why not |
| --- | --- | --- | --- | --- | --- | --- |
| `Cash Flow!B12` -> `Interest!B13` | 0 | 6 | 2 | 2.1375 | no | the sheet offers neither an opening balance nor a previous period for this reference, so no rewrite of the edge keeps the accounting meaning |
| `Debt Schedule!B12` -> `Interest!B13` | 0 | 6 | 2 | 2.1375 | no | the sheet offers neither an opening balance nor a previous period for this reference, so no rewrite of the edge keeps the accounting meaning |
| `Debt Schedule!B13` -> `Cash Flow!B12` | 0 | 6 | 2 | 2.1375 | no | the sheet offers neither an opening balance nor a previous period for this reference, so no rewrite of the edge keeps the accounting meaning |
| `Debt Schedule!B14` -> `Debt Schedule!B12` | 0 | 6 | 2 | 2.1375 | no | the sheet offers neither an opening balance nor a previous period for this reference, so no rewrite of the edge keeps the accounting meaning |

### cycle-002

- Chosen break edge: `Interest!C12` -> `Debt Schedule!C14`
- Rewrite: `lag-opening-balance`
- Semantic plausibility: 5/5
- Blast radius: 16 cells outside the cycle
- Formula complexity: 2/5
- Total score: 3.8667
- Elementary cycles in the cluster: 2; cycles this edge closes: 2
- Verified acyclic after the break: True

```
before: =('Debt Schedule'!C11+'Debt Schedule'!C14)/2
after:  =('Debt Schedule'!C11+'Debt Schedule'!C11)/2
```

**Justification.** The cycle runs because Interest!C12 depends on the closing balance, the closing balance depends on the interest charge, and the interest charge depends on the closing balance. The break site selected here is the reference to the closing balance itself: rewriting it to the opening balance is the convention finance models already use when they accrue interest on the opening position, so the roll-forward keeps its economics and only the averaging is dropped (the closing reference 'Debt Schedule'!C14 is replaced by its opening counterpart 'Debt Schedule'!C11). The alternative break points score 3 on semantic plausibility against 5 here, so they are recorded but not applied.

Alternatives considered and ranked:

| break edge | semantic | blast | complexity | score | applicable | why not |
| --- | --- | --- | --- | --- | --- | --- |
| `Interest!C12` -> `Debt Schedule!C14` | 3 | 16 | 2 | 2.9667 | yes | the reference 'Debt Schedule'!C14 is lagged one period to the previous period's 'Debt Schedule'!B14 |
| `Cash Flow!C12` -> `Interest!C13` | 0 | 16 | 2 | 1.6167 | no | the sheet offers neither an opening balance nor a previous period for this reference, so no rewrite of the edge keeps the accounting meaning |
| `Debt Schedule!C12` -> `Interest!C13` | 0 | 16 | 2 | 1.6167 | no | the sheet offers neither an opening balance nor a previous period for this reference, so no rewrite of the edge keeps the accounting meaning |
| `Debt Schedule!C13` -> `Cash Flow!C12` | 0 | 16 | 2 | 1.6167 | no | the sheet offers neither an opening balance nor a previous period for this reference, so no rewrite of the edge keeps the accounting meaning |

### cycle-003

- Chosen break edge: `Interest.Expense` -> `Interest.Charge`
- Rewrite: `repoint-defined-name`
- Semantic plausibility: 5/5
- Blast radius: 0 cells outside the cycle
- Formula complexity: 1/5
- Total score: 5.0
- Elementary cycles in the cluster: 1; cycles this edge closes: 1
- Verified acyclic after the break: True

```
before: =Interest.Charge
after:  =Interest!$B$13
```

**Justification.** Two defined names point at each other, so neither can be resolved and every cell that reads them fails. The model already carries the quantity on a labelled line of the Interest sheet, so the name is re-pointed at that cell and the other name resolves through it: the name Interest.Expense is re-pointed at Interest!B13, the cell it was aliasing. The names keep their spelling, their scope and their consumers; only the broken link is replaced.

Alternatives considered and ranked:

| break edge | semantic | blast | complexity | score | applicable | why not |
| --- | --- | --- | --- | --- | --- | --- |
| `Interest.Charge` -> `Interest.Expense` | 0 | 0 | 1 | 2.75 | no | the name Interest.Expense is the one that aliases a line of the model, so re-pointing Interest.Charge instead would leave the cycle open |

### cycle-005

- Chosen break edge: `Rollforward!C13` -> `Rollforward!C13`
- Rewrite: `trim-rolling-window`
- Semantic plausibility: 4/5
- Blast radius: 5 cells outside the cycle
- Formula complexity: 4/5
- Total score: 3.3896
- Elementary cycles in the cluster: 1; cycles this edge closes: 1
- Verified acyclic after the break: True

```
before: =SUM(C11:C13)
after:  =SUM(C11:C12)
```

**Justification.** The cell totals a window that contains the cell itself, so it reads its own result; this is the off-by-one a rolling schedule picks up when a row is inserted. Trimming the window to the rows before the cell keeps every other period untouched and removes the self-reference without touching any other formula: the rolling window C11:C13 contains the cell itself, so it is trimmed to C11:C12.

## Warnings

- 1 cycle(s) traverse cells the model marks as iterative calculation; they are reported and left untouched
- the workbook's calculation options have iterative calculation switched off, so the iterative block still evaluates to #CIRC!; enable it in Formulas > Calculation Options or have the model owner restate the block

## Previews

- `chapter18/solutions_and_explanations/exercise_3_autonomous-circular-reference-forensics-and-remediation-agentic-challenge/output/work/out/previews/sheet-Interest.png`
- `chapter18/solutions_and_explanations/exercise_3_autonomous-circular-reference-forensics-and-remediation-agentic-challenge/output/work/out/previews/sheet-Cash_Flow.png`
- `chapter18/solutions_and_explanations/exercise_3_autonomous-circular-reference-forensics-and-remediation-agentic-challenge/output/work/out/previews/sheet-Debt_Schedule.png`
- `chapter18/solutions_and_explanations/exercise_3_autonomous-circular-reference-forensics-and-remediation-agentic-challenge/output/work/out/previews/sheet-Rollforward.png`
