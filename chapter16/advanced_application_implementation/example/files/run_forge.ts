// run_forge.ts — deterministic harness for the editorial publishing pipeline.
//
// The pipeline runs for real: DesignCraft builds the document, the layout
// planner folds the spreads, the typography binder installs the styles,
// the stories are threaded across the frames, and the document is exported
// as a tagged PDF, an EPUB and a self-contained HTML page.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { publish } from "./publish-pipeline.js";
import { ManuscriptSchema } from "./contracts.js";

const FILES = resolve(process.cwd());
const OUTPUT = resolve(FILES, "output");
const WORK = resolve(OUTPUT, "work");

let passed = 0;
function ok(label: string, condition: boolean, detail = ""): void {
  if (!condition) {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`PASS ${label}`);
}

function equal<T>(label: string, actual: T, expected: T): void {
  ok(label, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

/**
 * A minimal manuscript: one page of body copy in one section, one
 * paragraph style, and the grid the planner folds it into.
 */
const MANUSCRIPT = {
  jobId: "cap16-harness",
  title: "The Frame and the Story",
  author: "The Harness",
  grid: {
    pageWidthPt: 612,
    pageHeightPt: 792,
    margins: { top: 72, bottom: 72, inside: 72, outside: 54 },
    columns: 1,
    gutterPt: 18,
    baselinePt: 12,
    bleedPt: 9,
    slugPt: 9,
    facingPages: false,
  },
  styles: [
    {
      name: "Body",
      chars: { fontFamily: "Source Serif 4", fontStyle: "Regular", size: 10.5, leading: 12 },
      para: { align: "leftJustified", composer: "paragraph" },
    },
    {
      name: "Headline 1",
      chars: { fontFamily: "Source Sans 3", fontStyle: "Semibold", size: 18, leading: 24 },
      para: { align: "left", keepWithNext: true },
    },
  ],
  sections: [
    {
      id: "opening",
      title: "The frame and the story",
      headStyle: "Headline 1",
      blocks: [
        {
          styleRef: "Body",
          text:
            "A story is a single stream of runs; a frame is a window onto it. " +
            "When the window fills, the remaining runs spill into the next frame " +
            "in the thread, and reflow is a re-run of the line breaker against " +
            "new column widths.",
        },
      ],
    },
  ],
};

async function main(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  // The schema fills in the defaults, so the manuscript is the one the
  // pipeline would parse from a CMS payload.
  const manuscript = ManuscriptSchema.parse(MANUSCRIPT);

  const result = await publish(manuscript, {
    readRoot: WORK,
    writeRoot: WORK,
    renderProofs: false,
  });

  // --- the document ----------------------------------------------------
  ok("the native document was written", existsSync(result.documentPath), result.documentPath);
  ok("the native document is not empty", statSync(result.documentPath).size > 1_000);

  // --- the exports -----------------------------------------------------
  ok("the PDF was exported", existsSync(result.pdfPath), result.pdfPath);
  ok("the PDF is not empty", statSync(result.pdfPath).size > 1_000);
  ok("the EPUB was exported", typeof result.epubPath === "string" && existsSync(result.epubPath), String(result.epubPath));
  ok("the HTML was exported", typeof result.htmlPath === "string" && existsSync(result.htmlPath), String(result.htmlPath));

  // --- the report ------------------------------------------------------
  equal("the job id is the one we asked for", result.jobId, manuscript.jobId);
  ok("the document has pages", result.pages >= 1, `${result.pages} pages`);
  ok("the document has spreads", result.spreads >= 1, `${result.spreads} spreads`);
  ok("the document has stories", result.stories >= 1, `${result.stories} stories`);
  equal("no frame is overset", result.oversetFrames, 0);

  // --- the typography report -------------------------------------------
  const typography = result.typography;
  ok("the typography report lists the styles", typography.boundStyles.length >= 2, `${typography.boundStyles.length} styles`);
  ok(
    "every font in use is present",
    typography.fontsInUse.every((f) => !f.missing),
    typography.fontsInUse.map((f) => `${f.family} ${f.style}${f.missing ? " (missing)" : ""}`).join(", "),
  );
  equal("the grid increment is the one we asked for", typography.gridIncrementPt, 12);
  equal("the composer is the paragraph composer", typography.composerDefault, "paragraph");

  console.log(`\n${passed} assertions passed`);
}

await main();
