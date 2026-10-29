# Chapter 7 — Multimodal Visual Feedback Loops - Driving Vision LLMs to Audit and Auto-Correct Photo Edits via ui.screenshot

The chapter drives six engines — PhotoCraft, DesignCraft, LightCraft,
FilmCraft, VectorCraft and PdfCraft — through their MCP servers, sends the
rendered pixels to a vision model, and turns the critique back into engine
commands.

## The projects

Each project has its own README with the command to run it and the
artifacts it writes.

| project | what it is |
| --- | --- |
| [Advanced Application Implementation](advanced_application_implementation/example/) | The Aperture loop: a multimodal visual feedback system that drives six engines (PhotoCraft, DesignCraft, LightCraft, FilmCraft, VectorCraft,… |
| [Basic Code Example](basic_code_example/example/) | A single-file hello world for the multimodal feedback pattern. |
| [Solution — Exercise 1](solutions_and_explanations/exercise_1_autonomous-e-commerce-hero-banner-correction-loop-with-vision-guided-curve-refin/) | The worked banner loop: snapshots, guarded batches and convergence against `photocraft-cli mcp`. |
| [Solution — Exercise 2](solutions_and_explanations/exercise_2_brand-compliance-vision-auditor-for-vectorcraft-packaging-die-lines/) | The worked VectorCraft brand auditor: ΔE color math, dry runs, escalation and a corrected artboard. |
| [Solution — Exercise 3](solutions_and_explanations/exercise_3_designcraft-editorial-spread-multimodal-widow-orphan-detection-and-rewrap-prophe/) | The worked DesignCraft spread auditor: measured line boxes, candidate crops, rewrap and a saved corrected document. |
| [Solution — Exercise 4](solutions_and_explanations/exercise_4_lightcraft-raw-batch-grading-reference-anchored-iterative-matching-loop/) | The worked LightCraft grading loop: per-zone ΔE, quadratic convergence, rollback and TCP client checks. |
| [Solution — Exercise 5](solutions_and_explanations/exercise_5_filmcraft-timeline-edit-point-qa-multimodal-continuity-audit-and-ripple-trim-aut/) | The worked FilmCraft edit-point QA: frame pairs, audio pops, guarded ripple trims and a full audit report. |
| [Solution — Exercise 6](solutions_and_explanations/exercise_6_capstone_optional_cross_applicatio/) | The worked capstone: PhotoCraft, DesignCraft and PdfCraft in one brochure pipeline with rollback and PPI preflight. |

## What you need

Node.js 22.5+, Python 3.10+ and the engine binaries — or just Docker. The
root README sets out both paths and the one-time setup:
[what you need](../README.md#what-you-need) and
[install](../README.md#install).

## Run everything

```bash
./chapter7/run_all.sh
```

The script runs every harness in the chapter, prints one line per
harness, and exits non-zero if any of them fails. Each harness leaves
its log in the `output/` directory of the project it exercises.

To run a single project, open its README: it gives the exact command
and the environment that command needs.

## Notes on the engines

The chapter is written against the shipping binaries, and the quirks that
The details that will bite you first:

- **DesignCraft has no line-box API.** Measure the line boxes from
  `render_page`; `inspect_document` gives you frames and stories, not lines.
- **LightCraft has no TCP control channel and no automation roots.** Use the
  MCP stdio server, and take the control ids from `develop.controls`.
- **PdfCraft opens PDFs, not `.designcraft` documents.** DesignCraft exports
  the PDF with `file.exportPdf`; the effective PPI comes from `page_images`
  (pixels plus the rectangle in points) and from DesignCraft's `links.list`.
