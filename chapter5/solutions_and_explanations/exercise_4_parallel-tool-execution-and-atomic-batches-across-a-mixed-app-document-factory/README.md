# 5. Exercise 4: Parallel Tool Execution and Atomic Batches Across a Mixed-App Document Factory — solution

The worked answer to Exercise 4: a manifest-driven DAG across DesignCraft,
WordCraft and PdfCraft, with the rollback plan that compensates only what can
be compensated. The scheduler itself remains an interface, because the
exercise asks for the graph and the atomicity strategy rather than a live
document factory.

## What it does

`ManifestDagBuilder` turns an `IssueManifest` into immutable `PipelineNode`
values. Each node names its app, registry command, parameters, dependencies,
optional compensation and whether the app is natively atomic. DesignCraft has
no `type.create`, so the title is a `frame.create` with `content: "text"`
styled by `type.char`; the print PDF, web PDF and HTML export fan out from the
same master; the WordCraft branch starts independently; PdfCraft consumes the
print PDF, which is the one edge between the two halves.

`ReverseTopologicalPlanner` depth-sorts the graph, skips nodes that never ran,
skips the failed node, skips natively atomic nodes, and groups the remaining
compensations into deepest-first waves. Exports and file opens with no
compensation are reported as `irreversible` instead of being silently dropped.

The harness also computes execution waves by graph depth. Both roots
(`dc_open`, `wc_open`) start in wave 0, the three exports fan out together once
the master is styled, and the PdfCraft chain advances only after `print_pdf`.

## The listings

| file | what it is |
| --- | --- |
| `04_parallel-tool-execution-and-atomic-batches-across-a-mixed-app-document-factory.ts` | the manifest schema, DAG builder, planner and scheduler interfaces |
| `run_ex4.ts` | the acceptance harness — live registry probes, eleven checks and the saved plan |

## Run it

```bash
cd chapter5/solutions_and_explanations/exercise_4_parallel-tool-execution-and-atomic-batches-across-a-mixed-app-document-factory/files
npx tsx run_ex4.ts
```

```
pipeline

PASS manifest produces the four artifacts plus the HTML extra
PASS every node names a command its engine actually exposes
PASS dependencies exist and form an acyclic graph
PASS the three branches only meet where the manifest says they do
PASS build is deterministic
PASS execution waves preserve dependencies and start both roots together

compensation

PASS compensation runs deepest-first in sequential waves
PASS exports are reported as irreversible, not silently compensated
PASS reversible edits are compensated, failed node and never-run nodes are not
PASS native-atomic nodes are skipped: the app already rolled back
PASS graph, waves and compensation plan were written as inspectable artifacts

11/11 checks passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/manifest.json` | the input issue manifest and house style |
| `output/pipeline.json` | the full DAG: nodes, commands, params, dependencies and compensations |
| `output/execution-waves.json` | depth-ordered waves of independent nodes |
| `output/compensation-plan.json` | deepest-first rollback waves plus the irreversible node list |
| `output/registry-proof.json` | every command and compensation checked against its live engine registry |
| `output/pipeline.dot` | Graphviz source for the dependency graph |
| `output/report.json` | check results, counts, waves and artifact list |
| `output/run_ex4.log` | the harness log — eleven checks and their tally |

The simulated failure is `pc_a11y_check`: every node that completed before it
is either compensated or declared irreversible; `pc_save` never ran and is not
compensated. The plan is written, not executed, so no document is produced.

## Notes

- **`designcraft-cli`, `pdfcraft-cli` and `wordcraft-cli` must be on `PATH`.**
  They are queried only for their command registries, not driven.
- The build is a pure function of the manifest plus the pipeline and
  correlation ids; two builds are compared in the harness.
- `nativeAtomic` is the one flag that changes the planner's behavior: an
  EffectCraft node is excluded because the app already rolled its batch back.
- The `pipeline.dot` artifact can be rendered with
  `dot -Tsvg output/pipeline.dot -o output/pipeline.svg` if Graphviz is
  installed; the harness does not require it.
- Node.js 22.5+ and `npx tsx`.
