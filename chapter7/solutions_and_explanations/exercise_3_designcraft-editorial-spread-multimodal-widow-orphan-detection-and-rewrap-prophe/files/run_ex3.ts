// run_ex3.ts — deterministic harness for the DesignCraft spread auditor.
//
// Builds a real spread with a six-column text frame, then runs the audit with
// a scripted verifier. Asserts on the measured line boxes, the candidate
// heuristics, the crop budget, the applied command log and the manifest.

import { strict as assert } from "node:assert";
import { copyFileSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  AuditConfig,
  CandidateVerdict,
  DesignSession,
  LayoutCandidate,
  MeasuredLine,
  SpreadManifest,
  VisionInput,
  auditSpread,
  detectCandidates,
  fillRatioVariance,
  measureSpread,
  paragraphRanges,
  proposeWrap,
} from "./03_designcraft-editorial-spread-multimodal-widow-orphan-detection-and-rewrap-prophecy.js";

const ROOT = process.cwd();
const OUTPUT = resolve(ROOT, "..", "output");
const FILE = resolve(ROOT, "input/spread.designcraft");

let passed = 0;
function ok(label: string, condition: boolean, detail = ""): void {
  if (!condition) {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  passed++;
  console.log(`PASS ${label}`);
}

function equal<T>(label: string, actual: T, expected: T): void {
  ok(label, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

function near(label: string, actual: number, expected: number, eps: number): void {
  ok(label, Math.abs(actual - expected) <= eps, `expected ${expected} ± ${eps}, got ${actual}`);
}

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

const WORDS = (
  "the editor reads every line before the issue ships and the typesetter has " +
  "learned to distrust automatic pagination of a weekly literary magazine " +
  "whose columns must breathe without leaving a single stranded word"
).split(" ");

function paragraph(index: number, words: number): string {
  const body = Array.from({ length: words }, (_, k) => WORDS[(index * 7 + k) % WORDS.length]).join(" ");
  // Paragraph 7 ends on a single short word, which the line finder should
  // measure as a widow.
  return `Paragraph ${index + 1}. ${body}${index === 6 ? " I" : "."}`;
}

async function buildFixture(): Promise<void> {
  if (existsSync(FILE)) rmSync(FILE);
  const session = new DesignSession();
  await session.connect();
  try {
    await session.json("new_document", {
      width: 792,
      height: 612,
      pages: 1,
      facingPages: false,
      columns: 6,
      gutter: 12,
      margins: 36,
      title: "Spread audit fixture",
    });
    const text = Array.from({ length: 15 }, (_, i) => paragraph(i, 32 + (i % 4) * 4)).join("\n\n");
    const frame = await session.json<{ id: number; story: number }>("execute", {
      command: "frame.create",
      params: { rect: [36, 36, 756, 576], content: "text", text },
    });
    await session.execute("object.textFrameOptions", {
      ids: [frame.id],
      columns: 6,
      gutter: 12,
      inset: 0,
    });
    await session.execute("file.saveAs", { path: FILE });
  } finally {
    await session.close();
  }
}

function config(): AuditConfig {
  return {
    spread: 0,
    page: 0,
    scale: 1,
    columns: 6,
    gutterPt: 12,
    widowFillRatio: 0.25,
    raggedVariance: 0.12,
    minParagraphLines: 4,
    maxCrops: 6,
    maxPasses: 2,
    tokenBudget: 18_000,
  };
}

// ---------------------------------------------------------------------------
// Scripted verifier
// ---------------------------------------------------------------------------

interface ScriptResult {
  verdicts: CandidateVerdict[];
  payloads: VisionInput[];
}

function scriptedVerifier(mode: "fix" | "reject"): { fn: (input: VisionInput) => Promise<CandidateVerdict[]>; seen: ScriptResult } {
  const seen: ScriptResult = { verdicts: [], payloads: [] };
  const fn = async (input: VisionInput): Promise<CandidateVerdict[]> => {
    seen.payloads.push(input);
    equal("vision: at most six crops", input.crops.length <= 6 ? 1 : 0, 1);
    ok("vision: one crop per candidate", input.crops.length === input.candidates.length);
    for (const crop of input.crops) {
      const png = PNG.sync.read(Buffer.from(crop.pngBase64, "base64"));
      ok("vision: crop is 600 px wide", png.width === 600, `${png.width}`);
      ok("vision: crop is 160 px tall", png.height === 160, `${png.height}`);
    }
    const target = input.candidates.find((c) => c.kind === "widow") ?? input.candidates[0];
    const verdicts = input.candidates.map((candidate) => {
      if (mode === "reject") {
        return {
          candidateId: candidate.id,
          verdict: "rejected" as const,
          note: "Edge case that the editor accepts.",
          proposed_wrap_strategy: "none" as const,
          confidence: 0.4,
        };
      }
      if (candidate.id === target.id) {
        return {
          candidateId: candidate.id,
          verdict: "confirmed" as const,
          note: "The last line holds one word, so the paragraph needs a little more tracking.",
          proposed_wrap_strategy: "increase_tracking" as const,
          confidence: 0.86,
        };
      }
      return {
        candidateId: candidate.id,
        verdict: "rejected" as const,
        note: "The line is short because the next paragraph starts here.",
        proposed_wrap_strategy: "none" as const,
        confidence: 0.55,
      };
    });
    seen.verdicts = verdicts;
    return verdicts;
  };
  return { fn, seen };
}

// ---------------------------------------------------------------------------
// Scenarios
// ---------------------------------------------------------------------------

async function scenarioMeasure(): Promise<void> {
  console.log("\n# measurement");
  const session = new DesignSession();
  await session.connect();
  try {
    await session.json("open_document", { path: FILE });
    const { measurement, raster, lines } = await measureSpread(session, config());

    equal("measurement: spread index", measurement.spread, 0);
    equal("measurement: six columns", measurement.columns, 6);
    equal("measurement: six column ratios", measurement.perColumnFillRatio.length, 6);
    const filled = measurement.perColumnFillRatio.filter((v) => v > 0.2).length;
    ok("measurement: at least five columns carry text", filled >= 5, JSON.stringify(measurement.perColumnFillRatio));
    ok("measurement: line boxes found", lines.length > 100, `${lines.length}`);
    ok("measurement: every line has a fill ratio", lines.every((l) => l.fillRatio >= 0 && l.fillRatio <= 1));
    const columns = new Set(lines.map((l) => l.column));
    equal("measurement: lines span every column", columns.size, 6);
    ok("measurement: variance is a number", Number.isFinite(measurement.fillRatioVariance));
    equal("measurement: raster decodes", PNG.sync.read(Buffer.from(raster, "base64")).width, 792);

    const widows = measurement.candidates.filter((c) => c.kind === "widow");
    ok("measurement: widow found", widows.length >= 1, JSON.stringify(measurement.candidates.map((c) => c.kind)));
    ok("measurement: widow is a short line", widows[0].fillRatio < 0.25, `${widows[0].fillRatio}`);
    ok("measurement: widow crop is inside the page",
      widows[0].cropRect[0] >= 0 && widows[0].cropRect[1] >= 0 &&
      widows[0].cropRect[2] <= 792 && widows[0].cropRect[3] <= 612,
      JSON.stringify(widows[0].cropRect));
    ok("measurement: candidates have unique ids",
      new Set(measurement.candidates.map((c) => c.id)).size === measurement.candidates.length);

    writeFileSync(resolve(OUTPUT, "spread-before.png"), Buffer.from(raster, "base64"));
    writeFileSync(resolve(OUTPUT, "measurement.json"), JSON.stringify({ measurement, lines }, null, 2));
  } finally {
    await session.close();
  }
}

async function scenarioFix(): Promise<void> {
  console.log("\n# confirmed fix");
  const session = new DesignSession();
  await session.connect();
  const verifier = scriptedVerifier("fix");
  try {
    await session.json("open_document", { path: FILE });
    const { manifest, measurement } = await auditSpread(session, config(), verifier.fn, { jobId: "ex3-fix" });

    ok("manifest: candidates recorded", manifest.candidates.length >= 1, `${manifest.candidates.length}`);
    equal("manifest: spread", manifest.spread, 0);
    equal("manifest: undo budget equals applied commands", manifest.undoBudgetAvailable, manifest.appliedCommands.length);
    ok("manifest: at least one command applied", manifest.appliedCommands.length >= 1);
    equal("manifest: applied command is a text command", manifest.appliedCommands[0].id, "type.char");
    ok("manifest: pass ledger has the before pass", manifest.passes[0].pass === 0);
    ok("manifest: a second pass was measured", manifest.passes.length >= 2);
    ok("manifest: rollback is consistent",
      manifest.rollback === null || manifest.appliedCommands.length === 0,
      String(manifest.rollback));

    const record = manifest.candidates.find((c) => c.appliedCommands.length > 0);
    assert(record, "no candidate carries commands");
    equal("manifest: confirmed candidate applied", record.verdict.verdict, "confirmed");
    equal("manifest: note comes from the verifier", record.verdict.note.includes("tracking") ? 1 : 0, 1);

    const payload = verifier.seen.payloads[0];
    ok("vision: payload never contains the story", !JSON.stringify(payload).includes("Paragraph 1."));
    ok("vision: candidate payload is compact",
      Object.keys(payload.candidates[0]).sort().join(",") === "fillRatio,id,kind,paragraphLines");
    ok("vision: verdict count matches candidates", verifier.seen.verdicts.length === payload.candidates.length);

    equal("measurement: still six columns", measurement.columns, 6);
    writeFileSync(resolve(OUTPUT, "spread_manifest.json"), JSON.stringify(manifest, null, 2));
    const afterPng = await session.render(config().page, config().scale);
    writeFileSync(resolve(OUTPUT, "spread-after.png"), Buffer.from(afterPng, "base64"));
    await session.execute("file.saveAs", { path: "input/spread-corrected.designcraft" });
    const beforePng = PNG.sync.read(readFileSync(resolve(OUTPUT, "spread-before.png")));
    const afterDecoded = PNG.sync.read(Buffer.from(afterPng, "base64"));
    let changedPixels = 0;
    for (let i = 0; i < beforePng.data.length; i += 4) {
      if (beforePng.data[i] !== afterDecoded.data[i] ||
          beforePng.data[i + 1] !== afterDecoded.data[i + 1] ||
          beforePng.data[i + 2] !== afterDecoded.data[i + 2]) {
        changedPixels++;
      }
    }
    ok("manifest: written to output", existsSync(resolve(OUTPUT, "spread_manifest.json")));
    ok("render: correction changed pixels", changedPixels > 0, `${changedPixels} pixels changed`);
    ok("render: corrected spread written", existsSync(resolve(OUTPUT, "spread-after.png")));
    ok("document: corrected spread saved",
      existsSync(resolve(ROOT, "input/spread-corrected.designcraft")));
  } finally {
    await session.close();
  }
}

async function scenarioReject(): Promise<void> {
  console.log("\n# rejected candidates");
  const session = new DesignSession();
  await session.connect();
  try {
    await session.json("open_document", { path: FILE });
    const verifier = scriptedVerifier("reject");
    const { manifest } = await auditSpread(session, config(), verifier.fn, { jobId: "ex3-reject" });
    equal("reject: nothing applied", manifest.appliedCommands.length, 0);
    equal("reject: no extra pass", manifest.passes.length, 1);
    equal("reject: no rollback", manifest.rollback, null);
    equal("reject: undo budget is zero", manifest.undoBudgetAvailable, 0);
    ok("reject: every record rejected", manifest.candidates.every((c) => c.verdict.verdict === "rejected"));
    writeFileSync(resolve(OUTPUT, "reject-manifest.json"), JSON.stringify(manifest, null, 2));
    ok("reject: manifest written", existsSync(resolve(OUTPUT, "reject-manifest.json")));
  } finally {
    await session.close();
  }
}

// ---------------------------------------------------------------------------
// Pure units
// ---------------------------------------------------------------------------

function syntheticLine(partial: Partial<MeasuredLine>): MeasuredLine {
  return {
    column: 0,
    columnLineIndex: 0,
    paragraphIndex: 0,
    paragraphLineIndex: 0,
    paragraphLines: 1,
    boundsPt: [0, 0, 100, 10],
    fillRatio: 1,
    ...partial,
  };
}

function unitDetection(): void {
  console.log("\n# heuristics");

  // A five-line paragraph whose last line is one word.
  const widowLines: MeasuredLine[] = [
    syntheticLine({ columnLineIndex: 0, paragraphLineIndex: 0, paragraphLines: 5 }),
    syntheticLine({ columnLineIndex: 1, paragraphLineIndex: 1, paragraphLines: 5 }),
    syntheticLine({ columnLineIndex: 2, paragraphLineIndex: 2, paragraphLines: 5 }),
    syntheticLine({ columnLineIndex: 3, paragraphLineIndex: 3, paragraphLines: 5 }),
    syntheticLine({ columnLineIndex: 4, paragraphLineIndex: 4, paragraphLines: 5, fillRatio: 0.12, boundsPt: [0, 50, 100, 60] }),
  ];
  const widowOpts = {
    widowFillRatio: 0.25,
    raggedVariance: 0.12,
    minParagraphLines: 4,
    columnCount: 1,
    measurePt: 100,
    scale: 1,
    spread: 0,
    frameId: 7,
    storyId: 8,
    page: { width: 792, height: 612 },
  };
  const widows = detectCandidates(widowLines, widowOpts);
  ok("widow: detected", widows.some((c) => c.kind === "widow"));
  equal("widow: line index", widows.find((c) => c.kind === "widow")!.lineIndices[0], 4);

  // An orphan: the paragraph's first line is the last line of its column.
  const orphanLines: MeasuredLine[] = [
    syntheticLine({ columnLineIndex: 0, paragraphIndex: 0, paragraphLineIndex: 0, paragraphLines: 2 }),
    syntheticLine({ columnLineIndex: 1, paragraphIndex: 0, paragraphLineIndex: 1, paragraphLines: 2 }),
    syntheticLine({ column: 0, columnLineIndex: 2, paragraphIndex: 1, paragraphLineIndex: 0, paragraphLines: 3, boundsPt: [0, 100, 100, 110] }),
    syntheticLine({ column: 1, columnLineIndex: 0, paragraphIndex: 1, paragraphLineIndex: 1, paragraphLines: 3 }),
    syntheticLine({ column: 1, columnLineIndex: 1, paragraphIndex: 1, paragraphLineIndex: 2, paragraphLines: 3 }),
  ];
  const orphans = detectCandidates(orphanLines, { ...widowOpts, columnCount: 2 });
  ok("orphan: detected", orphans.some((c) => c.kind === "orphan"));
  equal("orphan: flagged on the paragraph's first line",
    orphans.find((c) => c.kind === "orphan")!.lineIndices[0], 2);

  // Three last lines with very different right edges.
  const raggedLines: MeasuredLine[] = [
    syntheticLine({ columnLineIndex: 0, paragraphIndex: 0, paragraphLineIndex: 0, paragraphLines: 3, fillRatio: 0.95 }),
    syntheticLine({ columnLineIndex: 1, paragraphIndex: 0, paragraphLineIndex: 1, paragraphLines: 3, fillRatio: 0.5 }),
    syntheticLine({ columnLineIndex: 2, paragraphIndex: 0, paragraphLineIndex: 2, paragraphLines: 3, fillRatio: 0.92 }),
  ];
  const ragged = detectCandidates(raggedLines, widowOpts);
  ok("ragged: detected", ragged.some((c) => c.kind === "ragged"));
  equal("ragged: three lines referenced",
    ragged.find((c) => c.kind === "ragged")!.lineIndices.length, 3);

  // Paragraph offsets count UTF-8 bytes, not characters.
  const ranges = paragraphRanges("Prima riga à\n\nSeconda riga — più lunga");
  equal("ranges: two non-empty paragraphs", ranges.length, 2);
  equal("ranges: first paragraph starts at zero", ranges[0][0], 0);
  equal("ranges: byte offset after the accented paragraph",
    ranges[1][0], Buffer.byteLength("Prima riga à") + 2);

  // Variance of equal ratios is zero.
  equal("variance: flat", fillRatioVariance([0.5, 0.5, 0.5]), 0);
  ok("variance: grows with spread", fillRatioVariance([0.2, 0.8]) > fillRatioVariance([0.45, 0.55]));
}

function unitTranslation(): void {
  console.log("\n# translation");
  const verdict: CandidateVerdict = {
    candidateId: "c1-w01",
    verdict: "confirmed",
    note: "x",
    proposed_wrap_strategy: "increase_tracking",
    confidence: 0.9,
  };
  const ctx = {
    frameId: 7,
    paragraphIndex: 1,
    currentTracking: 10,
    currentWordSpacing: 0,
    currentHyphenate: false,
    minTracking: -50,
    maxTracking: 200,
    minWordSpacing: -20,
    maxWordSpacing: 20,
  };
  const proposal = proposeWrap(verdict, ctx, 7);
  assert(proposal, "proposal missing");
  equal("tracking: one command", proposal.commands.length, 1);
  equal("tracking: next rung", (proposal.commands[0].params as any).attrs.tracking, 30);
  equal("tracking: undo depth", proposal.undoDepth, 1);

  const hyphen = proposeWrap({ ...verdict, proposed_wrap_strategy: "hyphenate_on" }, ctx, 7);
  assert(hyphen, "hyphenation proposal missing");
  equal("hyphenation: attribute", hyphen.attributeChanged, "hyphenate");
  equal("hyphenation: command", hyphen.commands[0].id, "type.para");

  const none = proposeWrap({ ...verdict, proposed_wrap_strategy: "none" }, ctx, 7);
  equal("none: no commands", none, null);

  const already = proposeWrap(
    { ...verdict, proposed_wrap_strategy: "hyphenate_on" },
    { ...ctx, currentHyphenate: true },
    7,
  );
  equal("hyphenation: already on returns null", already, null);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(OUTPUT, { recursive: true });
  mkdirSync(resolve(ROOT, "input"), { recursive: true });
  unitDetection();
  unitTranslation();
  await buildFixture();
  await scenarioMeasure();
  await scenarioReject();
  await scenarioFix();

  copyFileSync(resolve(ROOT, "input/spread-corrected.designcraft"),
    resolve(OUTPUT, "spread-corrected.designcraft"));
  const artefacts = [
    "spread-before.png",
    "spread-after.png",
    "spread-corrected.designcraft",
    "measurement.json",
    "spread_manifest.json",
    "reject-manifest.json",
  ];
  for (const artefact of artefacts) {
    ok(`output: ${artefact}`, existsSync(resolve(OUTPUT, artefact)));
  }
  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 3,
    engine: "designcraft-cli",
    jobIds: ["ex3-fix", "ex3-reject"],
    assertions: passed,
    artefacts,
    result: "widow confirmed and rewrapped; rejected candidate left untouched",
  }, null, 2));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
