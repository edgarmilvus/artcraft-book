# 18. Advanced Application Implementation

A treasury platform's monthly job: rebuild a multi-sheet financial model,
prove it is sound, and publish a board-ready deck whose numbers are read from
the *audited* workbook — never recomputed. GridCraft builds and audits the
model, DeckCraft binds the presentation, and a vision reviewer attests that the
KPI tiles match what the model says. It runs headless over two MCP stdio
sessions, with no spreadsheet and no slide editor anywhere in the loop.

## What it does

The supervisor owns both subprocesses and one ambient `auditId` (an
`AsyncLocalStorage` context), which travels with every write as an
idempotency key. Then, in order:

```
ModelArchitect      new_workbook → home.insertSheet ×2 → sheet.rename(Sheet1 → Drivers)
                    → write_range(drivers) → formulas.defineName ×4
FormulaEngineer     set_cell per formula — GridCraft has no batch tool
AuditOrchestrator   detectCycles() + formulas.errorChecking + lineage gaps → runFullAudit()
DeckBinder          read named values → new_presentation → add_slide → add_text_box
                    → save_presentation → export(format: pdf)
VisionReviewer      render_slide(0) → injected reviewer → verdict
```

`CraftTransport` is the only place the two dialects meet. GridCraft's
meta-tool is `execute_command` and DeckCraft's is `run_command`; DeckCraft has
a real `batch` and GridCraft does not, so the grid flavour loops sequentially
and the callers that need all-or-nothing build in a scratch workbook. Every
call retries three times with exponential backoff from 120 ms, which is safe
only because the writes carry the audit id.

The audit's verdict is deliberately asymmetric: one `block` incident halts
publication, two or more `notify` incidents degrade it, everything else passes.
That encodes a cost matrix — a `#REF!` in a KPI tile is a reputational
catastrophe, a numerically correct deck with a lineage warning is not. Cycles
are found twice over: `formulas.errorChecking` names the cells, and a
hand-walked recursive DFS over the formula graph — with defined names resolved
to the cells they point at — is what lets the incident report the *path*
(`REVENUE_Q1 → DRIVER_UNITS → REVENUE_Q1`) instead of a bag of nodes.

The `VisionReviewer` is an injected closure, so the production build can call a
multimodal model while the harness supplies a deterministic stand-in. A failing
review never throws: it becomes a `deck_visual_mismatch` incident and the
result status becomes `degraded`.

## The listings

| file | what it is |
| --- | --- |
| `financial-pipeline.ts` | the whole pipeline: schemas, `CraftTransport`, the four roles, the supervisor, and the two declarative blueprints |
| `run_forge.ts` | the harness — it runs the pipeline once and then reruns it against a circular model to prove the block |

## Run it

```bash
cd chapter18/advanced_application_implementation/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_forge.ts
```

The harness runs the real engines twice: once for the publication path, once
with a model whose formulas form a cycle.

```
PASS the reviewer received a PNG
PASS the pipeline published
PASS no incidents were raised
PASS the deck was written
PASS the board PDF was written
PASS the monthly revenue is right
PASS the headline revenue is right
PASS a circular model is blocked
PASS the incident names the path

15 assertions passed
```

## What it produces

Everything lands under `files/output/work/`:

| artifact | what it is |
| --- | --- |
| `files/output/work/board.deckcraft` | the presentation, saved by DeckCraft |
| `files/output/work/board.pdf` | the exported board PDF — the deliverable |

The workbook is built in memory for the run; the two files above are what a
reader can open afterwards.

## Notes

- **`gridcraft-cli` and `deckcraft-cli` on `PATH`.** Both are spawned as
  `mcp` with the workspace as their working directory, and neither is given a
  directory flag here.
- **Numbers are formatted for the deck by hand** (`1 234 500.00`), so the
  slides do not change with the host locale.
- **Deck content is a projection.** `readNamedValues` calls `get_cell` for
  every named range the deck binds to; nothing on a slide is calculated from a
  formula.
- **A lane, not a retry loop, keeps the run safe.** The audit id is what makes
  the retries idempotent; without it a retried `set_cell` would look like a
  second write.
- Type-check it with `npm run check`.
