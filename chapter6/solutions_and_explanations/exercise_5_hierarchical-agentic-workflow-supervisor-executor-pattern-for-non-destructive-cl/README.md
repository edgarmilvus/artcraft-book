# 6. Exercise 5: Hierarchical Agentic Workflow — Supervisor/Executor Pattern for Non-Destructive Clipping Trees -- solution

The worked answer to Exercise 5: a two-tier workflow where a Supervisor turns a
campaign brief into a validated, dependency-ordered `WorkOrder`, and an Executor
dispatches every step against one PhotoCraft MCP session, verifies the resulting
tree, and saves only when the whole order passed.

## What it does

`planBanner` is the concrete Supervisor. It emits symbolic ids and a step list in
back-to-front order: a ribbon, a product group whose cutout is clipped to its
gradient, a sale badge between ribbon and price, a typography stack with a
rounded scrim and a drop shadow, and a hue/saturation grade clipped to the type
stack alone. It never talks to the engine.

`validatePlan` proves the order before a command runs. A duplicate id, a
reference to an id that has not been defined yet, an unknown step kind, a bad
label color or a rounded rectangle without a radius makes the order
`impossible` and costs zero undo steps.

The Executor maps each step kind to registry commands, resolves symbolic ids to
engine ids, and keeps the exact command list for the audit trail. `create-clip`
checks the positional rule first: the clip base must be the sibling directly
below the layer, because `layer.createClippingMask` takes only `layer`. After the
last step, four visual requirements are read back from `doc_inspect`, including
the shadow effect and the grade's clip base.

Any engine refusal, missing layer id, substituted font or failed assertion
unwinds the document to the history depth it opened at. A successful order is
saved exactly once, and the SHA-256 of the saved bytes is the determinism claim.

## The listings

| file | what it is |
| --- | --- |
| `05_hierarchical-agentic-workflow-supervisor-executor-pattern-for-non-destructive-clipping-trees.ts` | the contracts, Supervisor planner, plan validation, Executor, rollback and save |
| `run_ex5.ts` | the acceptance harness — two byte-identical runs and five failure paths |
| `package.json` | manifest — `npm run harness` runs the acceptance harness |
| `tsconfig.json` | the strict TypeScript configuration |

`src/work-order.ts` is a symlink to the worked file so the harness imports it as
the book's listing does.

## Run it

```bash
cd chapter6/solutions_and_explanations/exercise_5_hierarchical-agentic-workflow-supervisor-executor-pattern-for-non-destructive-cl/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex5.ts
```

```
PASS the planned order passes validation
PASS the plan asserts every structural invariant
PASS the work order completes
PASS every assertion passed
PASS all four requirements are satisfied
PASS the run saved exactly one document
PASS the save landed on composites/run-a/composite.psd
PASS the PSD exists and hashes
PASS the successful report carries the applied command log
PASS the saved tree keeps the contract names
PASS the re-run also completes
PASS two runs are byte-identical
...
PASS missing font: only the applied steps were undone

35/35 checks passed
```

The middle of the log covers the five failure paths: unresolved reference,
unknown step kind, misplaced clip, failed assertion and missing font.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/composites/run-a/composite.psd` | the first successful 1920×1080 composite |
| `output/composites/run-a/inspect.json` | its full layer tree, including effects and clip state |
| `output/composites/run-a/report.json` | assertions, four requirements, applied command log and output hash |
| `output/composites/run-b/composite.psd` | the independent re-run; byte-identical to run A |
| `output/composites/run-b/report.json` | the second run's report and hash |
| `output/failures/unresolved-reference.json` | the plan that names a ghost id — impossible, no commands |
| `output/failures/unknown-step.json` | the plan with an unsupported step kind |
| `output/failures/misplaced-clip.json` | the refused clip and its rollback count |
| `output/failures/failed-assertion.json` | the mismatch the Executor reported |
| `output/failures/missing-font.json` | the substituted font detected from `type.create` |
| `output/report.json` | checks, plan summary, both run hashes, tree names and asset hashes |
| `output/run_ex5.log` | the harness log — thirty-five checks and their tally |

Both composites hash to the same value and carry the expected tree:
`Product::Stack`, `Product::Cutout`, `Gradient::Product`, `Sale`,
`Type::Stack`, `Type::Headline`, `Type::Price`, `Type::Scrim` and `Type::Grade`.
The five failure reports all have `status` other than `ok` and no `outputPath`.

## Notes

- **`photocraft-cli` must be on `PATH`.** The harness opens one MCP session per
  simulated tier process and pins both automation roots to the solution's
  `output/` tree.
- **Validation precedes execution.** An impossible order issues no command and
  reports `rolledBack: 0`; a failure after the first command reports the number
  of history states it actually undid.
- **Clipping is positional.** The Executor refuses a plan whose clip base is not
  the sibling directly below the layer instead of silently clipping to the
  wrong layer.
- Node.js 22.5+ and `npx tsx`.
