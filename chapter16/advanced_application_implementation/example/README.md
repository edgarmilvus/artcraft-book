# 16. Advanced Application Implementation

A publish-job pipeline for an editorial SaaS. A manuscript bundle arrives as
JSON — structured copy, style directives, an artwork manifest and typographic
targets — and the platform has to answer with a print-ready PDF, a reflowable
EPUB, a self-contained HTML proof and the native document, within a bounded
wall clock and with nobody sitting in front of InDesign.

The pipeline is written to be dropped into a queue worker behind an HTTP
endpoint. It is the chapter's reference architecture: a typed façade over the
engine, a pure geometry module, a typography binder and an orchestrator that
fixes the stage order.

## What it does

`publish()` opens one MCP stdio session against `designcraft-cli` and then
runs nine stages in an order that is load-bearing: `new_document` for the
page geometry, the layout preferences (the baseline grid) before any style
exists, the style sheet before any text is placed, the parent pages before
any page-level override, the artwork frames before the story flows around
them, the text threading, the generated matter (TOC, variables, footnotes,
index), the QA pass, and the export.

The stage implementations live in three modules. `layout-planner.ts` is pure
geometry — page slots, text bands, artwork rectangles and thread rectangles —
and makes no MCP calls at all. `typography.ts` turns the manuscript's style
specs into `style.paragraph.create` / `style.character.create` commands and
refuses any style whose leading does not divide the grid increment.
`designcraft-session.ts` owns the transport, the timeout policy and the
retry rules: an engine that rejects a command is never retried, a transport
failure is.

The QA stage runs the engine's own checks — `font.list` for the fonts in
use, `story.links` for the thread chain — and then exports. The PDF comes
from `file.exportPdf` (tagged, with bleed and marks), the EPUB from
`file.exportEpub`, the HTML from `file.exportHtml` and the native document
from `save_document`. The result carries the page, spread, story and overset
counts plus a typography report.

## The listings

| file | what it is |
| --- | --- |
| `contracts.ts` | the wire format: the Zod schemas for a manuscript, its grid, its styles, its sections and its artwork, plus the export options |
| `designcraft-session.ts` | the MCP transport façade — the stdio lifecycle, the typed `call`, the `CommandError` / `TransportError` split and the retry policy |
| `layout-planner.ts` | pure geometry: page slots, text bands, artwork placement and the thread rectangles, with no engine calls |
| `typography.ts` | the binder — style specs become `style.paragraph.create` commands, and the baseline-grid assertion that stops a drifting leading |
| `publish-pipeline.ts` | the orchestrator: the nine stages, the QA pass, the exports and the result report |

## Run it

```bash
cd chapter16/advanced_application_implementation/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_forge.ts
```

The pipeline runs for real: DesignCraft builds the document, the planner
folds the spreads, the binder installs the styles, the story is threaded
across the frames, and the document is exported as a tagged PDF, an EPUB and
a self-contained HTML page.

```
PASS the native document was written
PASS the native document is not empty
PASS the PDF was exported
PASS the PDF is not empty
PASS the EPUB was exported
PASS the HTML was exported
PASS the job id is the one we asked for
PASS the document has pages
PASS the document has spreads
PASS the document has stories
PASS no frame is overset
PASS the typography report lists the styles
PASS every font in use is present
PASS the grid increment is the one we asked for
PASS the composer is the paragraph composer

15 assertions passed
```

## What it produces

Everything lands under `files/output/work/`:

| artifact | what it is |
| --- | --- |
| `the-frame-and-the-story.designcraft` | the native document, saved by `save_document` |
| `the-frame-and-the-story.pdf` | the tagged print PDF, exported with `file.exportPdf` (in the `outputs-v1` release bundle, not committed) |
| `the-frame-and-the-story.epub` | the reflowable EPUB, exported with `file.exportEpub` |
| `the-frame-and-the-story.html` | the self-contained HTML proof, exported with `file.exportHtml` |

## Notes

- **`designcraft-cli` must be on `PATH`.** The session launches it as a
  child process; the headless server takes no sandbox roots of its own, so
  the session's `readRoot` / `writeRoot` are the policy.
- **A batch stops at the first failure** and keeps whatever already ran.
  There is no rollback, which is why the stage order puts the cheap
  validation stages first.
- **The exported PDF is stamped with the wall clock** — `/ModDate`,
  `/CreationDate`, the XMP dates and the document id all change between
  runs, so a byte-reproducible export has to rewrite them.
- **No provider key is required.** The vision review in the pipeline is
  advisory: with no endpoint configured the job publishes anyway.
- **`npx tsx`, not `node`.** The listings are TypeScript with `.js`
  specifiers; `tsx` resolves them.
- Type-check it with `npm run check` (which is `tsc --noEmit`).
