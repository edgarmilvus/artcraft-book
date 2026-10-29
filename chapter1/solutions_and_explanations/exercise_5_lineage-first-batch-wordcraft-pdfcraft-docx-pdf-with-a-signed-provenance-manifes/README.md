# 1. Exercise 5: Lineage-First Batch — WordCraft/PDFCraft DOCX→PDF with a Signed Provenance Manifest -- solution

A two-pass, per-file-isolating pipeline: generate a DOCX, restyle it with named
styles, export a PDF, stamp a provenance card, sign it, and record every stage in
a manifest. A second pass must skip all three stages; a corrupt DOCX in the same
batch must fail only its own row.

## What it does

1. Generates `input/doc-alpha.docx` with WordCraft and writes a deliberately
   corrupt `input/doc-broken.docx`.
2. **Pass 1**, for the valid file:
   - hashes the input (`source_sha256`);
   - classifies the inspected paragraphs into `Heading 1` / `Heading 2` and
     applies them as named styles (never direct bold/size formatting);
   - adds a `CONFIDENTIAL` banner to the header using a named `Classification`
     style, then repairs the body style the engine also changed;
   - appends live `DOCPROPERTY RunId` / `ModelId` fields to a dedicated
     provenance paragraph;
   - writes `title`, `author` and `model_id=…;run_id=…;source_sha256=…` to the
     document properties, saves the corrected master, and exports a PDF;
   - renders the provenance record to a PNG card, stamps it on page 1 as
     `Provenance`, sets the PDF metadata, and signs the PDF with a generated
     self-signed `.p12`.
3. The corrupt file fails at `open_document`; its row is marked
   `restyle:"failed"`, `export:"skipped"`, `sign:"skipped"`, and the batch
   continues.
4. **Pass 2** reads `docProps/core.xml` from the corrected DOCX. When it carries
   `source_sha256=<hash of the input>` and the signed PDF exists, all three
   stages report `skipped` and no byte of the artifacts changes.

## Run it

```bash
cd chapter1/solutions_and_explanations/exercise_5_lineage-first-batch-wordcraft-pdfcraft-docx-pdf-with-a-signed-provenance-manifes/files
npx tsx run_ex5.ts
```

The harness starts its own WordCraft, PdfCraft and VectorCraft MCP servers, runs
both passes, asserts on the real artifacts, and exits non-zero on the first
failed check.

## What it produces

| artifact | what it is |
| --- | --- |
| `output/input/doc-alpha.docx` | generated source document |
| `output/input/doc-broken.docx` | corrupt input used for failure isolation |
| `output/corrected/doc-alpha.docx` | corrected master: named heading styles, header banner, fields, lineage keywords |
| `output/pdf/doc-alpha.pdf` | pre-sign export (intermediate) |
| `output/signed/doc-alpha.pdf` | published PDF: metadata, `Provenance` stamp, signature |
| `output/provenance/doc-alpha.json` | canonical lineage record (run, model, input, digest, paths) |
| `output/provenance/doc-alpha.png` | provenance card rendered by VectorCraft |
| `output/provenance/doc-alpha-corrected-page1.png` | WordCraft render of the corrected page |
| `output/provenance/doc-alpha-signed-page1.png` | PdfCraft render of the signed page |
| `output/certs/pipeline.p12` | signing identity (created once per harness run) |
| `output/manifest.json` | last pass: one row per input with stage results |
| `output/manifest-pass1.json`, `output/manifest-pass2.json` | per-pass snapshots |
| `output/run-log.json` | checks, failures, engine notes, evidence from both passes |
| `output/run_ex5.log` | full harness transcript |

## What is verified

57 checks, 0 failing. The important ones:

- Pass 1 rows: good file `ok/ok/ok` with no errors; broken file
  `failed/skipped/skipped` with the `EOCD` zip error recorded, and the good row
  still completes.
- Corrected DOCX XML: `Heading1` + three `Heading2` paragraphs, no extra
  `w:pStyle`; header carries `CONFIDENTIAL` and
  `<w:pStyle w:val="Classification"/>`; `docProps/core.xml` has the title and
  `source_sha256=<input hash>`; both field codes and their result text are
  present; the provenance paragraph starts with the lineage sentence and ends
  with the run and model IDs.
- Signed PDF: at least one RSA/SHA-256 signature, title/author/keywords survive
  signing, the `Provenance` stamp annotation exists, and extracted text contains
  the banner and body words.
- Pass 2: all three stages skipped, both artifacts byte-identical to pass 1, the
  input hash still unchanged, and no `tmp-*` files left anywhere.
- The provenance sidecar matches the input digest, run ID, model ID and signed
  path; the stamped PNG is a valid PNG.

## Engine notes

- WordCraft has no character-style creation primitive: `styles.create` always
  produces a paragraph style. The banner therefore uses the named paragraph
  style `Classification`, and the harness verifies it in `word/header1.xml`
  rather than claiming a character style the engine cannot create.
- Applying a paragraph style while the cursor is in the header also restyles the
  body paragraph at the cursor. The restyle plan is re-applied after
  `insert.closeHeader` so the body keeps its heading styles.
- `select.collapse` collapses to the selection start, so the fields are appended
  with `caret.end`; otherwise the run/model text lands before the provenance
  sentence.
- `file.properties` has no custom-property field. The digest rides in
  `keywords` and is read back from `docProps/core.xml` for idempotency.
- `stamp_custom` scales a stamp to at most 200 pt and centers it on `at`, so the
  card is placed at `[480, 90]` to stay inside the page.
- `sign_id_create` produces a self-signed identity; `sign_list.all_valid` is
  therefore `false` even for a valid signature. The harness checks the signature
  count and algorithm, not CA validity.
- PdfCraft's text extractor maps the `r` glyph to U+FFFC, so assertions use
  words without `r` (`Specification`, `Deployment`, `validation`).
