# 17. Exercise 3: Multimodal Financial Report Assembly — solution

The worked Q3 Sector Pulse. WordCraft authors the five-section report from the
studio template, PdfCraft renders the revenue page, a scripted vision auditor
fails the first pass and passes the second, and the seal is the last write.

## What it does

1. `compose()` builds the DOCX: five sections, one chart each, captions,
   alt-text, APA citations, a bibliography and a live page-number field.
2. `correctionLoop()` renders the revenue page at 2× and calls the
   `VisionAuditor`; the harness supplies a deterministic auditor that reports
   an inaccessible chart on pass 1 and a clean page on pass 2.
3. A rejected pass applies the chart fix, updates the TOC and records the
   transcript entry; the second pass must be clean.
4. `run()` exports the PDF, checks the PDF/A gate, creates the studio signing
   identity and seals the final PDF. `sign_list` must show exactly one
   signature.
5. The manifest records the DOCX, the PDF, the sealed PDF, the chart PNG,
   every section, the bibliography and the two audit passes.

## Run it

```bash
cd chapter17/solutions_and_explanations/exercise_3_multimodal-financial-report-assembly-with-live-chart-ingestion/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex3.ts
```

```
19 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/sector-pulse.docx` | the authored five-section report |
| `output/sector-pulse.pdf` | the exported PDF before sealing |
| `output/sector-pulse.sealed.pdf` | the PDF/A-clean, signed deliverable |
| `output/sector-pulse.manifest.json` | sections, citations, loop transcript, signature and PDF/A verdict |
| `output/work/reports/`, `output/work/submission/` | template, chart PNG and all engine files |
| `output/run_ex3.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/03_multimodal-financial-report-assembly-with-live-chart-ingestion.ts` | styles, composition, chart audit loop, PDF export and seal |
| `files/run_ex3.ts` | the real-engine acceptance harness with a scripted auditor |

## Notes

- The harness replaces only the vision model; WordCraft, PdfCraft, the PDF/A
  conversion and the signature are real.
- The loop must run exactly twice: one rejected audit, one clean audit, two
  TOC updates and two transcript entries.
- `sign_list` is read back from the sealed document, so a missing signature
  fails the run.
- Type-check it with `npm run check`.
