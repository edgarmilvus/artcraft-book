# 17. Basic Code Example

A complete headless office pipeline behind one HTTP handler: a SaaS billing
service turns a validated statement payload into a DOCX and a watermarked,
flattened, AES-256-encrypted PDF, and returns both to the browser as base64.
WordCraft authors the document; PdfCraft governs it. Neither needs a GUI, a
license server, or Word on the box.

## What it does

The request is parsed with a Zod schema before anything touches a subprocess,
so malformed JSON from an upstream agent never reaches a document. The
pipeline then allocates a per-job directory under the system temp folder and
runs two stages against it:

```
Stage A — wordcraft-cli mcp      new_document → properties → title block → table → footer → DOCX + PDF seed
Stage B — pdfcraft-cli mcp       doc_open → set_info → watermark → flatten → protect → save → close
Stage C — delivery               read both files back, base64, byte counts, timings
```

Each engine is spawned as an MCP stdio server, used, and torn down inside a
`try/finally`, so no child process outlives its stage. The two servers take
different arguments and the difference is load-bearing: `pdfcraft-cli mcp`
takes `--root DIR` and enforces it, while `wordcraft-cli mcp` takes no
directory flag at all — its boundary is the working directory it is given,
so the listing keeps its own path policy (`assertSafeRelativePath`) and
refuses anything that is not a bare file name.

The two artifacts are read back inside the same call and returned with
per-stage timings for observability.

## The listings

| file | what it is |
| --- | --- |
| `01_office-pipeline.ts` | the whole example: Zod payload contract, the two MCP stages, the `PipelineResult` the web layer returns, the Next.js `POST` handler, and the `toolInvocation` descriptor an agent runtime calls |
| `02_line_by_line_explanation.txt` | the single command the chapter walks through line by line — `execute { command: "file.exportPdf" … }`, the moment the DOCX becomes a PDF |

## Run it

```bash
cd chapter17/basic_code_example/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_basic.ts
```

The harness supplies the owner password, builds a statement, then reads both
artifacts back — the DOCX through `wordcraft-cli text`, the PDF through its
trailer — and checks them.

```
PASS the DOCX carries the CSV-built table
PASS the DOCX keeps the quoted description intact
PASS the DOCX carries a footer part for the page number
PASS the PDF is encrypted
PASS the working directory is per-job
PASS the PDF was kept in the output directory

21 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `files/output/work/kept/statement.docx` | the authored statement, copied out of the per-job temp directory |
| `files/output/work/kept/statement.pdf` | the governed edition: metadata, diagonal `ACME · CONFIDENTIAL` watermark, no comments or form fields, AES-256 encrypted |

The pipeline itself writes into `$TMPDIR/saas-office/<uuid>/`; the harness
copies the two deliverables into `output/work/kept/` so the run leaves
something to look at.

## Notes

- **Both engines must be on `PATH`**: `wordcraft-cli` and `pdfcraft-cli`.
- **`PDF_OWNER_PASSWORD` is an input of the pipeline**, not of the harness.
  The harness sets it to a fixed string before calling
  `buildGovernedStatement`.
- **The PDF is not byte-stable.** Encryption writes a new document ID, so two
  runs produce two different files; the assertions check structure and
  content, never a golden hash.
- **`npx tsx`, not `node`.** The listings are TypeScript with `.js`
  specifiers; `tsx` resolves them.
- Type-check it with `npm run check` (`tsc --noEmit`).
