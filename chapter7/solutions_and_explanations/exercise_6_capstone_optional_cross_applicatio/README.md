# 7. Exercise 6: Capstone — Cross-Application Brochure Pipeline — solution

The worked capstone solution. It runs a complete product-brochure pipeline
across PhotoCraft, DesignCraft and PdfCraft, with a scripted multimodal audit
in the middle and explicit rollback boundaries around every engine.

## What it does

1. **Local audit.** PhotoCraft imports each source image, treats it, and
   renders a preview. A local vision client measures the preview and decides
   whether the exposure is usable. Results are cached by image SHA-256, so a
   repeated SKU is audited once.
2. **DesignCraft layout.** A template is created with `new_document`, then
   the pipeline places images and captions in a grid, threads caption
   stories, and refreshes the layout.
3. **Preflight.** The pipeline reads the link table and computes effective
   PPI from the placed frame geometry. A frame below the 300 PPI gate is
   shrunk and retried; the corrected pass must clear the gate.
4. **PdfCraft export.** The DesignCraft export is opened, rendered page by
   page, and saved as the final print PDF.
5. **Global audit.** A page-level vision client checks gutter spill,
   typography hierarchy and brand compliance. A traceable finding routes the
   pipeline to human review; nothing is silently accepted.
6. **Rollback.** Every job starts with a pristine copy under `_pristine/`.
   Any escalated run restores the working photos from that copy and the
   harness verifies the restored bytes.

The harness exercises four paths: a clean two-page run with a cache hit,
a run that fails the global audit and rolls back, a run that fails the local
confidence gate and asks for human review, and a one-column run where the
preflight PPI gate must shrink the image before the PDF is accepted.

## Run it

```bash
cd chapter7/solutions_and_explanations/exercise_6_capstone_optional_cross_applicatio/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex6.ts
```

The three engine CLIs must be on `PATH`:

```bash
export PATH="/path/to/repo/tools/craft-cli/bin:$PATH"
```

```
76 assertions passed
```

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/pipeline_report.json` | the clean run: stage results, cache counters, preflight issues, global audits |
| `output/report-rollback.json` | the escalated run whose global audit found a traceable photo defect |
| `output/report-human-review.json` | the low-confidence run that stopped before writing a PDF |
| `output/work/brochure.pdf` | the clean two-page print PDF |
| `output/work/template.designcraft` | the DesignCraft template used by the clean run |
| `output/work/design/brochure-1.designcraft` | the saved layout |
| `output/work/design/brochure-2.designcraft` | the layout after the rollback scenario |
| `output/work/export/brochure-1.pdf` | DesignCraft's print export |
| `output/work/export/brochure-2.pdf` | the second export |
| `output/work/photos/` | working copies owned by PhotoCraft |
| `output/work/treated/` | treated photos written by PhotoCraft |
| `output/wide/brochure.pdf` | final PDF after the PPI preflight correction |
| `output/wide/design/brochure-wide.designcraft` | one-column layout after the frame shrink |
| `output/wide/export/brochure-wide.pdf` | the exported corrected PDF |
| `output/wide/_pristine/` | pristine copy for the one-column job |
| `output/report.json` | scenario index, assertion count and artifact list |
| `output/run_ex6.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/01_typescript.ts` | the pipeline contract: stage results, job, snapshot and report types |
| `files/02_pipeline.ts` | the orchestrator: stage wrapper, cache, pristine copy, layout, preflight and rollback |
| `files/run_ex6.ts` | the acceptance harness: clean run, rollback, human review, PPI correction and asset checks |
| `files/package.json` | npm scripts and dependencies |
| `files/tsconfig.json` | TypeScript config |

## Notes

- `photocraft-cli`, `designcraft-cli` and `pdfcraft-cli` must all be on
  `PATH`. The vision clients are scripted and need no API key.
- The harness clears only the evidence it regenerates; `run_ex6.log` stays in
  place when the chapter runner is writing it.
- PDF assertions check the `%PDF-` header, file size and page rendering, not
  just the existence of a path.
- `npm run check` type-checks the contract, pipeline and harness.
