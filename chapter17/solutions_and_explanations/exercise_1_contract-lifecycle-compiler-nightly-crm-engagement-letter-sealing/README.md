# 17. Solutions and Explanations

The worked solution to Exercise 1: a nightly job reads the CRM export and
compiles one sealed engagement letter per row — a DOCX from WordCraft, a
PDF/A-3b, watermarked, password-protected PDF from PdfCraft, and an audit
JSON that carries the hash of the bytes that were written.

## What it does

The CSV is parsed by a twenty-line RFC 4180 reader (the export is flat, and a
quoted description may contain a comma), typed into `CRMRow`, and processed
row by row:

1. **Idempotency first.** The row is hashed. If an audit file and a PDF
   already exist and the previous `row_hash` matches, the row is a pure
   no-op — nothing is reopened, nothing is rewritten. A changed row gets a
   `-rev2` suffix and is treated as a revision.
2. **Composition.** WordCraft gets exactly one `batch` per engagement letter:
   margins, page size, a per-entity character style, the retainer table, the
   scope paragraph, a Standard Terms footnote, then the header. The order is
   the whole point — `insert.spreadsheet` leaves the caret inside the table
   and `references.footnote` moves it into the footnote story, so
   `caret.docEnd` and `text.newParagraph` sit between them. The DOCX is saved
   and exported with `file.exportPdf`.
3. **Governance.** PdfCraft opens the seed PDF and applies the chain in a
   fixed order: `doc_set_info` (including the CRM id as `Identifier`),
   `pdfa_convert` to `3b`, `doc_watermark`, `doc_protect` with an owner
   password and `fill-sign` changes, then a full `doc_save`. `doc_revisions`
   supplies the revision count the audit reports.
4. **Proof, for revisions only.** The previous PDF is opened alongside the
   new one, `doc_compare` and `doc_compare_report` write a `.diff.pdf`, and
   `doc_open_revision` materializes the first saved revision so the audit can
   quote its byte length.
5. **Audit.** `pdf_sha256` is computed from the file on disk, never from a
   value the engine returned.

A failure inside the governance chain is caught and recorded as a structured
`failure: { tool, params, error_message }` on the row; the DOCX stays on
disk, because a partner must still be able to read it.

## The listings

| file | what it is |
| --- | --- |
| `01_solutions_and_explanations.ts` | the compiler: CSV reader, `sealRow()`, the WordCraft batch, the PdfCraft chain, the audit record, and the `main()` driver |

## Run it

```bash
cd chapter17/solutions_and_explanations/exercise_1_contract-lifecycle-compiler-nightly-crm-engagement-letter-sealing/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex1.ts
```

The harness writes a two-row CRM export, runs the compiler, then reruns it
unchanged and once more with an edited row to exercise the revision path.

```
PASS the retainer was formatted deterministically
PASS the audit records the revision index
PASS the second run is a no-op
PASS the sealed PDF was not rewritten
PASS the revision carries a diff report
PASS the summary counts the sealed rows

29 assertions passed
```

## What it produces

Everything lands under `output/work/out/`; the headline files are also copied
to `output/`:

| artifact | what it is |
| --- | --- |
| `output/SFDC-0042571.pdf`, `output/SFDC-0042571-rev2.pdf` | the sealed letter and its revision |
| `output/SFDC-0042571-rev2.audit.json` | the revision audit record |
| `SFDC-0042571.docx` / `.pdf` / `.audit.json` | the sealed engagement letter and its audit record |
| `SFDC-0042572.docx` / `.pdf` / `.audit.json` | the second row |
| `SFDC-0042571-rev2.docx` / `.pdf` / `.audit.json` | the revision produced by the changed-row pass |
| `SFDC-0042571-rev2.diff.pdf` | the visual comparison against the first sealed edition |
| `_run_summary.json` | totals: processed, sealed, failed (also copied to `output/`) |

## Notes

- **Environment**: `CRM_CSV` (input path), `CRM_OUT` (output directory),
  `CRM_PERMS_PWD` (the PDF permissions password). Defaults are the
  container paths `/work/crm-in/salesforce.csv` and `/work/crm-out`.
- **`pdfcraft-cli` and `wordcraft-cli` on `PATH`.** PdfCraft is spawned with
  `--root` pointed at the output directory and enforces it; WordCraft is
  spawned with no directory flag and resolves against its working directory.
- **Money is formatted by hand**, `1 250 000.00`, not with `toLocaleString`,
  so the PDF is identical whatever the host locale is.
- **No signing identity is needed.** The seal here is PDF/A-3b plus the
  permissions password and the audit hash; `01_solutions_and_explanations.ts`
  never calls `sign_document`.
- Type-check it with `npm run check`.
