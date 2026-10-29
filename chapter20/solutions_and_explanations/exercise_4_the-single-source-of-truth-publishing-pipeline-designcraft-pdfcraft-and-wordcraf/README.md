# 20. Exercise 4: Single-Source-of-Truth Publishing — solution

The worked publish pipeline. One `framework.json` drives DesignCraft, PdfCraft
and WordCraft, and every artifact is checked against the same canonical
manifest.

## What it does

1. Validates the framework manifest: chapter set, release tag, resolvable
   figures and existing Markdown sources.
2. Publishes a tagged PDF/A-2b brochure with chapter titles, footnotes, body
   text and a figure whose alt text comes from the caption.
3. Publishes a DOCX review with `Heading 1`, `Body`, `Figure Caption` and a
   real table-of-contents field.
4. Publishes an HTML executive summary that lists the chapters but omits the
   body and scope sections, and points at the hero image.
5. Writes a divergence report and a hero at 1920×1080.
6. Fails closed on an unresolvable figure, a release mismatch or a missing
   Markdown file; no artifact is written on validation failure.
7. A second run produces a deterministic divergence report and HTML summary.

## Run it

```bash
cd chapter20/solutions_and_explanations/exercise_4_the-single-source-of-truth-publishing-pipeline-designcraft-pdfcraft-and-wordcraf/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex4.ts
```

```
53 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/framework_brochure.pdf` | the tagged PDF/A-2b brochure |
| `output/framework_review.docx` | the WordCraft review with TOC |
| `output/summary.html` | the executive summary |
| `output/divergence_report.json` | page counts, figure map and release |
| `output/hero.png` | the 1920×1080 hero |
| `output/work/fixtures/` | the manifest, Markdown and broken variants |
| `output/work/out-second/` | the deterministic second run |
| `output/run_ex4.log` | shell-captured harness log |

## The listings

| file | what it is |
| --- | --- |
| `files/04_the-single-source-of-truth-publishing-pipeline-designcraft-pdfcraft-and-wordcraft-acting-as-one.ts` | manifest validation, three channels, divergence report |
| `files/run_ex4.ts` | the real-engine acceptance harness |
| `files/01_framework.json` | the canonical manifest contract |

## Notes

- The PDF is checked for the PDF/A-2b output intent, the tagged figure and the
  caption-derived alt text.
- The DOCX must carry a real TOC field, not a static list.
- The HTML summary must omit body text and scope while still listing chapters.
- Type-check it with `npm run check`.
