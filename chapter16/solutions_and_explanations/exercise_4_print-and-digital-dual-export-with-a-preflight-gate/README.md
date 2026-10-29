# 16. Exercise 4: Print-and-Digital Dual Export — solution

The worked transactional export. A print PDF (PDF/X-4, 300 PPI, bleed and
marks) and a reflowable EPUB (150 PPI) are produced from one source; either
both survive preflight or both are deleted.

## What it does

1. `pinDocumentPreferences()` pins points, a 12 pt keyboard increment and the
   grid.
2. `normalisePdfDates()` rewrites `/CreationDate`, `/ModDate`, the XMP dates
   and the document id so two runs hash the same. It now tolerates whitespace
   between the key and `(D:...)`.
3. `altTextPass()` sets alt text on page graphics while skipping master-page
   items and already-labelled figures.
4. `generateAndVerifyToc()` rebuilds the expected heading set from
   `inspect_document` and compares it with the generated TOC.
5. `runPreflight()` / `errorsOnly()` gate each channel; warnings and info do
   not block.
6. `canonicalize()` / `signManifest()` produce a recursive canonical JSON HMAC
   over the unsigned manifest.
7. `runDualExport()` rolls both files back on a print error, a digital
   preflight error or an EPUB export failure.

## Run it

```bash
cd chapter16/solutions_and_explanations/exercise_4_print-and-digital-dual-export-with-a-preflight-gate/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex4.ts
```

```
47 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/book-print.pdf` | a real twelve-page, date-normalized print PDF |
| `output/book.epub` | a real EPUB 3 zip (mimetype, container, OPF, XHTML) |
| `output/qa-manifest.json` | signed manifest with both hashes and preflights |
| `output/rejected-print.json` | the print-preflight rejection |
| `output/rejected-digital.json` | the digital-preflight rejection (both files removed) |
| `output/sample.pdf` | the timestamp-normalizer fixture |
| `output/report.json` | assertion count and artifact list |
| `output/run_ex4.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/04_print-and-digital-dual-export-with-a-preflight-gate.ts` | preferences, PDF normalizer, alt text, TOC, preflight, HMAC and orchestration |
| `files/run_ex4.ts` | the acceptance harness with scripted engine responses |
| `files/package.json` | npm scripts and dependencies |

## Notes

- The print and digital preflight failures are tested separately, and an EPUB
  export exception is tested as a third rollback path.
- The manifest is only persisted on success; rejected manifests are returned
  and written by the caller, which is why the harness saves them explicitly.
- The EPUB is a genuine zip with the required `mimetype` entry stored
  uncompressed.
- Type-check it with `npm run check`.
