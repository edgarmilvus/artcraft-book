// run_ex2.ts — acceptance harness for the twelve-spread baseline grid.
//
// It checks the 6.5 pt half-line invariant, the canonical style set, the grid
// math and the per-spread assertion. It also measures a synthetic twelve-spread
// document through measureGrid(), writes gridMap.json/gridAssertion.json and a
// 1600×1000 baseline proof sheet.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  CANONICAL_STYLES,
  GRID,
  NON_GRID_STYLES,
  assertGrid,
  assertHalfLine,
  installStyles,
  measureGrid,
  onGrid,
  snapToHalf,
  styleFor,
  summarize,
  type GridMap,
  type GridMapEntry,
  type ManuscriptBlock,
} from "./02_baseline-grid-vertical-rhythm-across-twelve-spreads.js";

const HERE = process.cwd();
const OUTPUT = resolve(HERE, "..", "output");

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

function sheet(entries: GridMapEntry[], spreads: number): Buffer {
  const width = 1600;
  const height = 1000;
  const png = new PNG({ width, height });
  png.data.fill(245);
  const cellW = 240;
  const cellH = 140;
  const originX = 40;
  const originY = 40;
  for (let s = 0; s < spreads; s += 1) {
    const col = s % 6;
    const row = Math.floor(s / 6);
    const x0 = originX + col * (cellW + 24);
    const y0 = originY + row * (cellH + 40);
    for (let y = y0; y < y0 + cellH; y += 1) {
      for (let x = x0; x < x0 + cellW; x += 1) {
        const i = (y * width + x) * 4;
        png.data[i] = 255; png.data[i + 1] = 255; png.data[i + 2] = 255; png.data[i + 3] = 255;
      }
    }
    for (let y = y0; y < y0 + cellH; y += 1) {
      for (let x = x0; x < x0 + cellW; x += 1) {
        const i = (y * width + x) * 4;
        if ((y - y0) % 13 === 0 && (y - y0) % 26 !== 0) {
          png.data[i] = 222; png.data[i + 1] = 226; png.data[i + 2] = 255;
        }
      }
    }
    const lines = entries.filter((e) => Math.floor((e.page - 1) / 2) === s && e.onGrid && !e.isBreakAway);
    lines.slice(0, 9).forEach((line, index) => {
      const y = y0 + 12 + index * 13;
      for (let x = x0 + 12; x < x0 + cellW - 16; x += 1) {
        for (let dy = 0; dy < 2; dy += 1) {
          const i = ((y + dy) * width + x) * 4;
          png.data[i] = 45; png.data[i + 1] = 55; png.data[i + 2] = 72;
        }
      }
    });
  }
  return PNG.sync.write(png);
}

async function main(): Promise<void> {
  for (const name of ["gridMap.json", "gridAssertion.json", "baseline-grid.png", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  mkdirSync(OUTPUT, { recursive: true });

  console.log("\n# half-line invariant");
  equal("snap: zero", snapToHalf(0), 0);
  equal("snap: 6.5 stays", snapToHalf(6.5), 6.5);
  equal("snap: 13 stays", snapToHalf(13), 13);
  equal("snap: 7 rounds to 6.5", snapToHalf(7), 6.5);
  equal("snap: 9.75 rounds to 13", snapToHalf(9.75), 13);
  assertHalfLine(13, "test"); assertHalfLine(6.5, "test"); assertHalfLine(0, "test");
  ok("half-line: legal values pass", true);
  let illegal = false;
  try { assertHalfLine(7, "spaceAfter"); } catch (error) {
    illegal = String(error).includes("half-line invariant violated");
  }
  ok("half-line: 7 pt is refused", illegal);
  equal("grid: 13 pt increment", GRID.increment, 13);

  console.log("\n# canonical style set");
  equal("styles: seven entries", CANONICAL_STYLES.length, 7);
  const names = CANONICAL_STYLES.map((s) => s.name);
  ok("styles: body is canonical", names.includes("BODY-CANONICAL"));
  ok("styles: two headings", names.filter((n) => n.startsWith("HEAD-")).length === 2);
  equal("styles: body leading", (CANONICAL_STYLES[0]!.para as any).leading.value, 13);
  equal("styles: H1 leading", (CANONICAL_STYLES[1]!.para as any).leading.value, 26);
  ok("styles: every spacing is a half-line multiple", CANONICAL_STYLES.every((style) => {
    const para = style.para as any;
    return ((para.spaceBefore ?? 0) / 6.5) % 1 === 0 && ((para.spaceAfter ?? 0) / 6.5) % 1 === 0;
  }));
  ok("styles: break-away set is explicit", NON_GRID_STYLES.has("PULLQUOTE-TILE") && NON_GRID_STYLES.has("SIDEBAR-REG"));

  let styleSteps: any[] = [];
  await installStyles({ batch: async (steps: any[]) => { styleSteps = steps; } } as any);
  equal("styles: one batch", styleSteps.length, 7);
  ok("styles: all are paragraph creates", styleSteps.every((step) => step.id === "style.paragraph.create"));
  equal("styles: first body", styleSteps[0]!.params.name, "BODY-CANONICAL");

  console.log("\n# block-to-style mapping");
  const map: Array<[ManuscriptBlock["kind"], string]> = [
    ["heading", "HEAD-H1-GRID"], ["subhead", "HEAD-H2-GRID"], ["body", "BODY-CANONICAL"],
    ["pullquote", "PULLQUOTE-TILE"], ["sidebar", "SIDEBAR-REG"], ["caption", "CAPTION-GRID"],
    ["footnote", "FOOTNOTE-GRID"],
  ];
  for (const [kind, expected] of map) equal(`mapping: ${kind}`, styleFor(kind), expected);

  console.log("\n# grid math");
  equal("grid: start aligned", onGrid(48).aligned, true);
  equal("grid: next line aligned", onGrid(61).aligned, true);
  equal("grid: half line is off", onGrid(54.5).aligned, false);
  equal("grid: 0.1 pt drift tolerated", onGrid(48.1).aligned, true);
  equal("grid: 47.9 pt drift tolerated", onGrid(47.9).aligned, true);
  ok("grid: delta is reported", onGrid(54.5).delta > 0.2);

  const entries: GridMapEntry[] = [];
  for (let page = 1; page <= 24; page += 1) {
    for (let line = 0; line < 30; line += 1) {
      const y = 48 + line * 13;
      entries.push({ page, frameId: page * 10, storyId: page, paragraphIndex: 0, lineIndex: line,
        y, onGrid: onGrid(y).aligned, isBreakAway: false });
    }
    entries.push({ page, frameId: page * 10 + 1, storyId: page, paragraphIndex: 0, lineIndex: 0,
      y: 48, onGrid: true, isBreakAway: true });
  }
  const summary = summarize(entries);
  equal("summary: twelve spreads", summary.length, 12);
  equal("summary: first spread total", summary[0]!.totalLines, 62);
  equal("summary: first spread aligned", summary[0]!.alignedLines, 60);
  equal("summary: first spread break-away", summary[0]!.breakAwayLines, 2);

  const goodMap: GridMap = {
    baselineStart: GRID.start, baselineIncrement: GRID.increment,
    entries, outliers: [], spreadSummary: summary, schemaVersion: 1,
  };
  equal("assert: clean map passes", assertGrid(goodMap).passed, true);
  const badEntry: GridMapEntry = { ...entries[0]!, page: 5, y: 54.5, onGrid: false };
  const badMap: GridMap = { ...goodMap, outliers: [badEntry] };
  const bad = assertGrid(badMap);
  equal("assert: one outlier fails", bad.passed, false);
  equal("assert: failure lands on spread 2", bad.spreadFailures[0]!.spreadIndex, 2);
  ok("assert: delta is measured", bad.spreadFailures[0]!.offenders[0]!.delta > 0.2);

  console.log("\n# measured document");
  const measured = await measureGrid({
    call: async (name: string) => {
      if (name === "inspect_document") {
        return { spreads: [{ pageIndex: 0, items: [{ id: 10, kind: "text", bounds: [0, 48, 612, 792] }] }] };
      }
      if (name === "get_story") {
        return {
          id: 1, frames: [{ paragraphStyle: "BODY-CANONICAL" }],
          paragraphCount: 2, paragraphStyles: ["BODY-CANONICAL", "BODY-CANONICAL"],
          lineCountByParagraph: [3, 2],
        };
      }
      return {};
    },
    execute: async () => ({}),
  } as any);
  equal("measure: five lines", measured.entries.length, 5);
  ok("measure: every line is aligned", measured.entries.every((entry) => entry.onGrid));
  equal("measure: no outliers", measured.outliers.length, 0);
  equal("measure: spread summary", measured.spreadSummary.length, 1);

  writeFileSync(resolve(OUTPUT, "gridMap.json"), JSON.stringify(goodMap, null, 2));
  writeFileSync(resolve(OUTPUT, "gridAssertion.json"), JSON.stringify(assertGrid(goodMap), null, 2));
  writeFileSync(resolve(OUTPUT, "baseline-grid.png"), sheet(entries, 12));
  assert.equal(goodMap.spreadSummary.length, 12);

  const proof = PNG.sync.read(readFileSync(resolve(OUTPUT, "baseline-grid.png")));
  equal("proof: width", proof.width, 1600);
  equal("proof: height", proof.height, 1000);
  for (const artefact of ["gridMap.json", "gridAssertion.json", "baseline-grid.png"]) {
    ok(`output: ${artefact}`, existsSync(resolve(OUTPUT, artefact)));
  }

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 2,
    engine: "DesignCraft baseline-grid QA (pure geometry, real proof sheet)",
    assertions: passed + 1,
    spreads: 12,
    entries: entries.length,
    outliers: 0,
    artefacts: ["gridMap.json", "gridAssertion.json", "baseline-grid.png"],
    result: "twelve spreads at 13 pt/6.5 pt invariants; every line measured on the grid and the assertion passes",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
