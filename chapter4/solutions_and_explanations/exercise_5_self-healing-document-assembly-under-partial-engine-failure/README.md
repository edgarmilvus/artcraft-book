# 4. Exercise 5: Self-Healing Document Assembly — solution

The worked solution for Exercise 5. Three real MCP engines — LightCraft,
WordCraft and PdfCraft — build a newsletter issue that deliberately cannot
get its two photos, and the run must degrade instead of aborting.

## What it does

`SelfHealingBuild.run(request)`:

1. Creates `quarantine/<runId>/`, `out/` and `log/` under
   `AUTOMATION_ROOT`, then opens one MCP session per engine.
2. Asks LightCraft for one `export` of the requested photo ids. It diffs the
   returned ids against the request and retries each missing photo on the same
   warm channel with the request's backoff ladder.
3. When a photo's ladder is exhausted, it asks `catalog.query` for the
   photo's metadata, chooses `hero` when the record carries that keyword and
   `body` otherwise, then writes a placeholder PNG into the quarantine
   directory and records `placeholder_substituted`.
4. Opens the WordCraft template, inspects for overflowing blocks, and gives
   each one at most three `select.paragraph` + `format.shrinkFont` rounds
   before settling at a 9 pt floor and recording `heading_shrunk`.
5. Opens the PdfCraft copy, runs `ocr_recognize`, fills the order-number form,
   marks and applies the credit-card and SSN redactions, and fills missing
   figure alt text in one `command_batch` with `stop_on_error: true`.
6. Places the visible placeholder blocks and their captions on the PDF pages,
   so a degraded issue still shows what is missing instead of shipping a blank
   document.
7. Verifies PDF/A at the requested level, converts once on failure, and
   records `pdfa_downgraded` / level `none` only if the second verification
   also fails.
8. Saves the healed document with `doc_save`, sets status `degraded` when a
   placeholder or PDF/A downgrade happened, appends the summary to
   `log/builds.jsonl`, and closes every document and MCP session in `finally`.

## Run it

```bash
export PATH="$PWD/tools/craft-cli/bin:$PATH"
cd chapter4/solutions_and_explanations/exercise_5_self-healing-document-assembly-under-partial-engine-failure/files
npx tsx run_ex5.ts
```

The harness builds its fixtures with the engines themselves:

- WordCraft creates `template.docx` (`new_document`, `type_text`,
  `save_document`).
- PdfCraft creates a populated two-page `out/issue-42.pdf`: newsletter text,
  a hero image, and an `OrderNumber` form field (`doc_create`,
  `page_add_text`, `page_add_image`, `form_add_field`, `doc_save`,
  `doc_close`).

It then asks for `sku-118` and `sku-204` with
`retryBackoffOverrideMs: [20, 20, 20]`, so the production ladder is collapsed
to milliseconds.

### What the output means

- `photosRequested: 2`, `photosDelivered: 0` — the catalog cannot deliver
  either id.
- Six `retry` entries — three per photo, matching the override ladder — then
  two `placeholder_substituted` entries.
- Both placeholders are `body` because the fixture catalog records carry no
  `hero` keyword.
- `status: "degraded"` and `pdfaLevel: "2b"` — the PDF/A path verifies at the
  requested level, so no downgrade entry is needed.
- `quarantine/<runId>/` contains `sku-118.placeholder.png` and
  `sku-204.placeholder.png`, both visible 320×200 PNGs.
- The shipped PDF keeps its title and body copy, adds the two placeholder
  blocks and captions, and grows from the fixture to the healed document;
  `text_extract` finds both SKUs and the “Supplementary images will follow”
  line.
- `log/builds.jsonl` has exactly one JSON line, and its `runId` and `status`
  match the in-memory summary.
- The three diagnostics name `lightcraft`, `wordcraft` and `pdfcraft`.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/build-run/template.docx` | the WordCraft fixture |
| `output/build-run/out/issue-42.pdf` | the assembled two-page newsletter after healing |
| `output/build-run/quarantine/<runId>/*.placeholder.png` | the two degraded-build placeholders |
| `output/build-run/log/builds.jsonl` | one summary line for the run |
| `output/run-log.json` | checks, summary, quarantine contents and channel diagnostics |
| `output/run_ex5.log` | harness log with all 24 assertions |

The run ends with `24/24 checks passed`.

## Notes

- **All three CLIs must be on `PATH`.** The harness starts
  `lightcraft-cli`, `wordcraft-cli` and `pdfcraft-cli` over stdio MCP.
- `AUTOMATION_ROOT` is read when the module is evaluated, so the harness sets
  it before the dynamic import. The run root is the solution's
  `output/build-run`, not `/tmp`.
- The alt-text generator is deliberately a fixed sentence; a production build
  sends the rendered figure to a vision model. The fixture is not a tagged PDF,
  so PdfCraft reports no figures and `altTextGenerated` stays 0 in this run;
  the batch path remains guarded and ready for a tagged source.
- The 320×200 placeholder PNG is visible evidence for the degraded build. The
  production swap to a styled hero/body asset changes only the bytes written
  into quarantine.
- Node.js 22.5+ and `tsx` are required.
