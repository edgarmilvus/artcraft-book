// run_ex3.ts — acceptance harness for the Knuth-Plass typographic QA loop.
//
// It tests the cascade-protected surgical edits, the vision-metric convergence
// rules and the snapshot restore, then runs the real qaSpread() loop against a
// scripted vision model. The loop renders actual PNGs, writes the three-pass
// report, the chapter summary and the style snapshot.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  VISION_PROMPT,
  applySurgicalFix,
  charsFrom,
  isClean,
  isConvergedWithWarnings,
  paraFrom,
  qaSpread,
  restoreSnapshot,
  runChapterQA,
  visionPass,
  type QAPass,
  type StyleSnapshot,
} from "./03_knuth-plass-typographic-qa-with-a-vision-model-feedback-loop.js";

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

function pagePng(page: number, pass: number): Buffer {
  const png = new PNG({ width: 800, height: 600 });
  for (let y = 0; y < 600; y += 1) {
    for (let x = 0; x < 800; x += 1) {
      const i = (y * 800 + x) * 4;
      const line = y % 26 < 2 && y > 40 && y < 560;
      png.data[i] = line ? 45 : 250 - pass * 6;
      png.data[i + 1] = line ? 55 : 248 - pass * 6;
      png.data[i + 2] = line ? 72 : 242 - pass * 4;
      png.data[i + 3] = 255;
    }
  }
  const marker = (page % 8) * 30;
  for (let y = 20; y < 40; y += 1) for (let x = 20; x < 20 + marker; x += 1) {
    const i = (y * 800 + x) * 4;
    png.data[i] = 15; png.data[i + 1] = 98; png.data[i + 2] = 254;
  }
  return PNG.sync.write(png);
}

const cleanMetrics: QAPass["metrics"] = {
  hyphenatedLineEnds: 4, maxConsecutiveHyphens: 2, riverRows: 0,
  riverRowsHighSeverity: 0, widows: 0, orphans: 0, looseLines: 0,
};

function visionResponse(metrics: any, suggestions: any[] = []): string {
  return JSON.stringify({
    hyphenatedLineEnds: Array.from({ length: metrics.hyphenatedLineEnds }, (_, i) => i + 1),
    maxConsecutiveHyphens: metrics.maxConsecutiveHyphens,
    riverRows: Array.from({ length: metrics.riverRowsHighSeverity }, () => ({ y: 200, spans: [[10, 20]], severity: "high" }))
      .concat(Array.from({ length: Math.max(0, metrics.riverRows - metrics.riverRowsHighSeverity) }, () => ({ y: 300, spans: [[5, 12]], severity: "low" }))),
    widows: metrics.widows,
    orphans: metrics.orphans,
    looseLines: metrics.looseLines,
    suggestions,
  });
}

function fakeOpenAI(responses: string[]): any {
  let index = 0;
  return {
    chat: { completions: { create: async () => ({
      choices: [{ message: { content: responses[Math.min(index++, responses.length - 1)] } }],
    }) } },
  };
}

function fakeDC(options: {
  calls?: string[];
  batches?: any[][];
  renderTo?: string;
  styles?: any[];
  paragraphStyles?: string[];
} = {}): any {
  const calls = options.calls ?? [];
  const batches = options.batches ?? [];
  const styles = options.styles ?? [
    { name: "BODY-CANONICAL", para: {}, chars: {}, system: false },
    { name: "HEAD-H1-GRID", para: {}, chars: {}, system: false },
  ];
  return {
    call: async (name: string, args: any = {}) => {
      calls.push(name);
      if (name === "render_page") {
        mkdirSync(resolve(args.path, ".."), { recursive: true });
        writeFileSync(args.path, pagePng(args.page, 1));
        return { path: args.path };
      }
      if (name === "inspect_document") {
        return { spreads: [{ items: [{ id: 10, kind: "text" }] }] };
      }
      if (name === "get_story") {
        return { paragraphStyles: options.paragraphStyles ?? ["BODY-CANONICAL", "BODY-CANONICAL"] };
      }
      return {};
    },
    execute: async (name: string, args: any = {}) => {
      calls.push(name);
      if (name === "style.list") return { paragraph: styles, character: [] };
      return {};
    },
    batch: async (steps: any[]) => { batches.push(steps); return {}; },
    calls,
    batches,
  };
}

async function main(): Promise<void> {
  for (const dir of ["build", "abort"]) rmSync(resolve(OUTPUT, dir), { recursive: true, force: true });
  rmSync(resolve(OUTPUT, "report.json"), { force: true });
  mkdirSync(OUTPUT, { recursive: true });
  const build = resolve(OUTPUT, "build");
  mkdirSync(build, { recursive: true });

  console.log("\n# attribute mapping");
  assert.deepEqual(paraFrom("hyphenation", true), { hyphenate: true, composer: "everyLine" });
  assert.deepEqual(paraFrom("justification", true), { align: "justify", composer: "everyLine" });
  assert.deepEqual(paraFrom("wordSpacing", { min: 90, max: 110 }), { wordSpacing: { min: 90, max: 110 } });
  assert.deepEqual(paraFrom("tracking", 12), {});
  assert.deepEqual(charsFrom("tracking", 12), { tracking: 12 });
  assert.deepEqual(charsFrom("letterSpacing", -5), { tracking: -5 });
  assert.deepEqual(charsFrom("wordSpacing", 5), {});
  ok("attrs: paragraph and character maps are separated", true);

  console.log("\n# convergence rules");
  ok("clean: no defects", isClean(cleanMetrics));
  ok("clean: a high river is not clean", !isClean({ ...cleanMetrics, riverRows: 1, riverRowsHighSeverity: 1 }));
  ok("clean: a widow is not clean", !isClean({ ...cleanMetrics, widows: 1 }));
  ok("warnings: low river converges", isConvergedWithWarnings({ ...cleanMetrics, riverRows: 2 }));
  ok("warnings: loose lines converge", isConvergedWithWarnings({ ...cleanMetrics, looseLines: 3 }));
  ok("warnings: a high river does not converge", !isConvergedWithWarnings({ ...cleanMetrics, riverRows: 1, riverRowsHighSeverity: 1 }));
  ok("warnings: an orphan does not converge", !isConvergedWithWarnings({ ...cleanMetrics, orphans: 1 }));

  console.log("\n# surgical fixes");
  const calls: string[] = [];
  const plainDC = fakeDC({ calls });
  const plain = await applySurgicalFix(plainDC, "BODY-CANONICAL", "hyphenation", true, 0, [
    { name: "BODY-CANONICAL", basedOn: null },
  ]);
  equal("fix: applied", plain.applied, true);
  equal("fix: edits the base style", calls[0], "style.paragraph.edit");

  const cascadeCalls: string[] = [];
  const cascadeDC = fakeDC({ calls: cascadeCalls, paragraphStyles: ["BODY-CANONICAL", "OTHER", "BODY-CANONICAL"] });
  const cascade = await applySurgicalFix(cascadeDC, "BODY-CANONICAL", "tracking", 15, 0, [
    { name: "BODY-CANONICAL", basedOn: null },
    { name: "BODY-DERIVED", basedOn: "BODY-CANONICAL" },
  ]);
  equal("cascade: applied", cascade.applied, true);
  equal("cascade: derived style created first", cascadeCalls[0], "style.paragraph.create");
  equal("cascade: derived style is per spread", cascadeDC.calls.includes("style.paragraph.apply"), true);
  equal("cascade: two target paragraphs reassigned", cascadeCalls.filter((n) => n === "style.paragraph.apply").length, 2);

  console.log("\n# vision parsing");
  const vision = await visionPass(fakeOpenAI([visionResponse({ ...cleanMetrics, riverRows: 3, riverRowsHighSeverity: 1, widows: 1 })]), [
    (() => { const p = resolve(build, "vision-page.png"); writeFileSync(p, pagePng(1, 1)); return p; })(),
  ]);
  equal("vision: hyphenated ends counted", vision.metrics.hyphenatedLineEnds, 4);
  equal("vision: high rivers counted", vision.metrics.riverRowsHighSeverity, 1);
  equal("vision: total rivers counted", vision.metrics.riverRows, 3);
  equal("vision: widows counted", vision.metrics.widows, 1);
  ok("vision: prompt names the JSON contract", VISION_PROMPT.includes("hyphenatedLineEnds"));
  ok("vision: raw response is retained", vision.raw.includes("suggestions"));

  console.log("\n# two-pass spread loop");
  const firstDirty = visionResponse({ ...cleanMetrics, widows: 1 }, [{
    style: "BODY-CANONICAL", attr: "hyphenation", from: false, to: true,
    rationale: "tighten the justified column",
  }]);
  const openai = fakeOpenAI([firstDirty, visionResponse(cleanMetrics)]);
  const consoleCalls: string[] = [];
  const dc = fakeDC({ calls: consoleCalls });
  const report = await runChapterQA(1, build, openai, dc);
  equal("loop: one spread", report.length, 1);
  equal("loop: two passes", report[0]!.passes.length, 2);
  equal("loop: first pass has a suggestion", report[0]!.passes[0]!.suggestions.length, 1);
  equal("loop: suggestion applied", report[0]!.passes[0]!.suggestions[0]!.applied, true);
  equal("loop: second pass is clean", report[0]!.passes[1]!.metrics.widows, 0);
  equal("loop: outcome clean", report[0]!.outcome, "clean");
  equal("loop: page range", report[0]!.pageRange.join("-"), "1-2");
  ok("loop: four rendered pages", report[0]!.passes.flatMap((p) => p.renderedFiles).length === 4);
  for (const file of report[0]!.passes.flatMap((p) => p.renderedFiles)) {
    ok(`loop: rendered ${file.replace(build + "/", "")}`, existsSync(file));
    equal(`loop: ${file.split("/").pop()} is 800x600`, `${PNG.sync.read(readFileSync(file)).width}x${PNG.sync.read(readFileSync(file)).height}`, "800x600");
  }
  writeFileSync(resolve(build, "spread-0-report.json"), JSON.stringify(report[0], null, 2));
  ok("loop: style snapshot exists", existsSync(resolve(build, "styles-snapshot.json")));
  ok("loop: chapter summary exists", existsSync(resolve(build, "chapter-qa-summary.json")));
  const summary = JSON.parse(readFileSync(resolve(build, "chapter-qa-summary.json"), "utf8"));
  equal("summary: one clean spread", summary.cleanSpreads, 1);
  equal("summary: not blocked", summary.blocked, false);

  console.log("\n# aborted loop restores the snapshot");
  const abortDir = resolve(OUTPUT, "abort");
  mkdirSync(abortDir, { recursive: true });
  const snapshot: StyleSnapshot = {
    capturedAt: "2026-10-24T02:00:00Z", documentRef: "chapter-04",
    styles: [{ name: "BODY-CANONICAL", para: { hyphenate: false }, chars: {}, system: false }],
  };
  writeFileSync(resolve(abortDir, "snapshot.json"), JSON.stringify(snapshot, null, 2));
  const dirty = visionResponse({ ...cleanMetrics, riverRowsHighSeverity: 2, widows: 2 });
  const abortBatches: any[][] = [];
  const abortDC = fakeDC({ batches: abortBatches });
  const aborted = await qaSpread(abortDC, 0, fakeOpenAI([dirty]), abortDir, "snapshot.json");
  equal("abort: three passes", aborted.passes.length, 3);
  equal("abort: outcome", aborted.outcome, "aborted");
  equal("abort: restore batch issued", abortBatches.length, 1);
  equal("abort: restore edits the snapshot style", abortBatches[0]![0].id, "style.paragraph.edit");
  const directBatches: any[][] = [];
  await restoreSnapshot(fakeDC({ batches: directBatches }), resolve(abortDir, "snapshot.json"));
  equal("restore: one batch step per style", directBatches[0]!.length, 1);

  for (const artefact of ["build/chapter-qa-summary.json", "build/styles-snapshot.json",
    "build/spread-0-report.json", "build/qa/spread-0/pass-1-page-1.png",
    "build/qa/spread-0/pass-2-page-2.png"]) {
    ok(`output: ${artefact}`, existsSync(resolve(OUTPUT, artefact)));
  }

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 3,
    engine: "DesignCraft typographic QA (scripted vision, real renders)",
    assertions: passed + 1,
    passes: report[0]!.passes.length,
    outcome: report[0]!.outcome,
    suggestions: report[0]!.passes.reduce((n, p) => n + p.suggestions.length, 0),
    artefacts: ["build/qa/", "build/styles-snapshot.json", "build/chapter-qa-summary.json", "build/spread-0-report.json"],
    result: "two-pass spread converged clean; cascade protection and snapshot restore exercised",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
