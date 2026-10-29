# 3. Exercise 3: The Publishing House Nightly Pipeline — WordCraft → DesignCraft → PdfCraft with Preflight Gates -- solution

The worked solution for Exercise 3: a nightly pipeline that normalizes a
tracked-changes DOCX, places it into a DesignCraft master, exports a PDF/A
and refuses to publish when any preflight gate fails. The acceptance harness
runs the whole chain against the real WordCraft, DesignCraft and PdfCraft MCP
servers.

## What it does

`03_pipeline.ts` reads `manifest.json`, then:

1. **WordCraft normalization** — opens the manuscript, resolves tracked
   changes through `review.changes` plus `review.nextChange` / the current
   selection, accepts editor insertions, rejects editor deletions, and leaves
   the author's revision tracked. Comments are removed and the normalized
   DOCX is saved.
2. **DesignCraft placement** — opens the house master, places the normalized
   DOCX into the body story, applies the house styles, and checks for overset
   text. A missing master is fatal and names the failing stage.
3. **PDF/A export** — exports the print PDF, converts the in-memory document
   with `pdfa_convert`, then saves it. `pdfa_convert` alone only edits memory;
   the `doc_save` is what makes the file on disk PDF/A.
4. **Preflight** — runs `pdfa_verify` and an accessibility check, writes
   `preflight.json`, and refuses to publish if an error-severity issue exists.
5. **Idempotency** — records the output digest in a sidecar. A second run with
   the same manifest short-circuits without rewriting the PDF; deleting the
   sidecar forces a real rebuild.

The normalized DOCX is written before the PDF, so a failed preflight leaves
the source that produced it but no published PDF.

## The listings

| file | what it is |
| --- | --- |
| `03_pipeline.ts` | the pipeline: WordCraft normalization, DesignCraft placement, PDF/A export and preflight |
| `build-manuscript.mjs` | builds `in/JAMS-2026-0089.docx` with three tracked changes and comments |
| `make-template.mjs` | builds `templates/house-master.designcraft` |
| `inspect-norm.mjs` | small diagnostic used while developing the revision policy |
| `run_ex3.ts` | acceptance harness: runs the pipeline, reopens the DOCX and PDF, checks idempotency and the fatal template path |

## Run it

```bash
cd chapter3/solutions_and_explanations/exercise_3_the-publishing-house-nightly-pipeline-wordcraft-designcraft-pdfcraft-with-prefli/files
npx tsx run_ex3.ts
```

The harness builds both fixtures, runs the pipeline twice, and opens a fresh
WordCraft and PdfCraft session to verify the results. It exits non-zero on a
failed assertion.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/in/JAMS-2026-0089.docx` | the tracked-changes manuscript |
| `output/templates/house-master.designcraft` | the two-page master |
| `output/normalized/JAMS-2026-0089.docx` | the normalized manuscript |
| `output/JAMS-2026-0089.designcraft` | the placed DesignCraft document |
| `output/JAMS-2026-0089.pdf` | the exported, saved PDF/A |
| `output/preflight.json` | PDF/A and accessibility report, output digest and page count |
| `output/a11y.html` | written by PdfCraft only when preflight fails; a passing run leaves none |
| `output/pipeline-1.log`, `pipeline-2.log` | first and idempotent runs |
| `output/failing/` | the missing-template run, which must leave no PDF |
| `output/run_ex3.log` | every acceptance check |
| `output/run-log.json` | check count, failures, PDF hash and page count |

## What the harness asserts

- the normalized DOCX exists and only the author's revision remains tracked;
- the editor insertion was accepted and the editor deletion was rejected, so
  the deleted text is back in the story;
- the PDF has two pages, a generated Contents page, the title, the accepted
  insertion, the restored deletion and the author's tracked text;
- the PDF is larger than zero, starts with `%PDF-`, PdfCraft reports it as
  PDF/A-2b compliant, and the byte count the pipeline reports equals the file
  on disk after the conversion is saved;
- the preflight report has no error-severity issues and records the exact
  digest of the PDF on disk;
- the second run short-circuits with the same digest and does not rewrite the
  PDF; removing the sidecar forces a rebuild that still passes preflight, and
  the harness then restores the first run's PDF and sidecar so the directory
  matches `pipeline-1.log`;
- a missing master exits 1, names the stage, and writes no PDF;
- the pipeline reads `review.changes` and never a non-existent `revisions`
  field, resolves style conflicts with `redefine`, treats overset text as a
  hard failure, converts to PDF/A before verifying, checks accessibility and
  writes blockers as `blocker.json`;
- the helpers use the official MCP SDK, not hand-rolled JSON-RPC frames.

The current run is 56 checks, 0 failing: a two-page signature, `changes: 2`,
`comments: 0`, `tocEntries: 2`, a 22,035-byte PDF with SHA-256
`743e38b0efb45e6996956d39ac32d6eb664646cd6d5375f0e57456edd37d71fa`.

## Notes

- WordCraft exposes tracked changes through `review.changes`; `inspect_document`
  does not return a `revisions` array. `review.accept` and `review.reject`
  act on the current selection, so the pipeline advances with
  `review.nextChange` and matches the selection to the change it wants.
- `pdfa_convert` mutates the open PdfCraft document. The saved file only
  becomes PDF/A after `doc_save`.
- `doc_save` does not create missing parent directories; the pipeline creates
  `normalized/` first.
- The first run exports the PDF twice — once from DesignCraft, once after the
  PdfCraft conversion — and the preflight digest is taken from the second
  file. DesignCraft's export reports 17,856 bytes; the saved PDF/A is 22,035,
  so the summary reads the size back with `stat` instead of echoing the export.
- Paths in the manifest resolve against `outputRoot`, which is also the read
  root: `in/` and `templates/` live inside it.
