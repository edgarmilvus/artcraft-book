# 18. Basic Code Example

One request handler that owns a GridCraft workbook from `new_workbook` to
`save_workbook`: it builds an assumptions sheet with named ranges, a twelve-month
revenue sheet that compounds off those names, and a P&L sheet that pulls
revenue across sheets — then audits the result and persists a signed-in-spirit
snapshot of it. The arithmetic is trivial; the pipeline is the point.

## What it does

`generateFinancialReport(request)` validates the payload with Zod, allocates a
workspace under `var/finance/<tenant>/<day>/`, spawns one `gridcraft-cli mcp`
subprocess bound to it, and then works in a fixed order:

```
new_workbook → home.insertSheet ×2 → sheet.rename(Sheet1 → Assumptions)
  → write_range  Assumptions!A1:B4        the four inputs
  → format_range percent / thousands      presentation only, never the value
  → formulas.defineName ×4                GrowthRate, GrossMargin, MonthlyOpex, SeedRevenue
  → write_range  Revenue!A2:L2            =SeedRevenue, then =A2*(1+GrowthRate/12) …
  → write_range  P&L!A2:L2                =Revenue!X2-(Revenue!X2*(1-GrossMargin))-MonthlyOpex
  → formulas.calculateNow
audit: formulas.errorChecking → sheet.activate + sheet.read + formulas.tracePrecedents
  → save_workbook → inspect_workbook → sha256 of the bytes on disk
```

Three constraints shape the code. GridCraft **has no batch tool**, so every
write is its own round trip — the blocks are landed with `write_range` rather
than cell by cell, and the model is only audited once it is complete. The
trace commands **work on the active sheet**, so `auditWorkbook` activates each
sheet and addresses cells without a qualifier. And `gridcraft-cli mcp` takes
**no directory flag**, so the working directory is the sandbox; the module
keeps its own path policy on top of it.

A circular reference is a hard failure, not a warning: `formulas.errorChecking`
names the cells in the cycle and the handler throws before the file is saved.
The revision hash in the envelope is the SHA-256 of the saved bytes, taken
after the save — GridCraft's `inspect_workbook` has no revision field, so the
honest answer is computed by the caller.

## The listings

| file | what it is |
| --- | --- |
| `01_route.ts` | the whole example: `ReportRequestSchema`, the MCP client factory, `buildWorkbook`, `auditWorkbook`, `generateFinancialReport` |

## Run it

```bash
cd chapter18/basic_code_example/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_basic.ts
```

The harness runs the handler with the project's `output/` directory as its
working directory, then reads the workbook back through `gridcraft-cli cat` so
the assertions are about the model's arithmetic and not about its bytes.

```
PASS the sheets are the ones the model declares
PASS the audit counted the dependency edges
PASS the named ranges point at the assumptions sheet
PASS the seed is the assumption, not a constant
PASS the first compounding month is right
PASS the operating profit is right

18 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `files/output/var/finance/northwind/2026-10-22/pnl.xlsx` | the three-sheet workbook — Assumptions, Revenue, P&L |
| `files/output/var/finance/northwind/2026-10-22/audit.json` | the `AuditEnvelope`: sheets, named ranges, dependency-edge count, circular references, revision hash, timestamp |

The directory name carries the day the run happened, so a later run writes a
new bucket rather than overwriting this one.

## Notes

- **`gridcraft-cli` on `PATH`.** There is no directory flag and no
  `.gridcraft` container: the working directory is the boundary, and
  `save_workbook` accepts `.xlsx`, `.csv`, `.tsv`, `.json` and `.html`.
- **The MCP reply lives in the first text block.** The server does not
  populate `structuredContent`; `callTool` checks `isError` before parsing,
  or an engine error would surface as a JSON syntax error.
- **No DeckCraft call here.** The envelope is the handoff: the chapter's
  advanced project binds a deck to the audited numbers.
- Type-check it with `npm run check`.
