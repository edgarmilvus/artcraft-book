// run_forge.ts — deterministic harness for the financial-pipeline listing.
//
// The pipeline runs for real: GridCraft builds the model, the audit pass
// probes it, DeckCraft is bound to the audited numbers, the deck is
// exported, and a vision reviewer attests to the slide.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import {
  FinancialPipelineSupervisor,
  buildBlueprint,
  buildDeckBlueprint,
  type ReviewVerdict,
} from "./financial-pipeline.js";

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

/** The scripted reviewer: it sees a render and says it is fine. */
let reviewerCalls = 0;
const reviewer = async (pngBase64: string): Promise<ReviewVerdict> => {
  reviewerCalls += 1;
  ok("the reviewer received a PNG", pngBase64.startsWith("iVBORw0KGgo"), pngBase64.slice(0, 24));
  return { ok: true, issues: [], slide: 0 };
};

async function main(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  const supervisor = new FinancialPipelineSupervisor({
    workspace: WORK,
    reviewer,
    log: () => {},
  });

  const result = await supervisor.run(buildBlueprint(), buildDeckBlueprint());

  // --- the pipeline -------------------------------------------------------
  equal("the pipeline published", result.status, "published");
  equal("no incidents were raised", result.incidents.length, 0);
  equal("the reviewer was consulted once", reviewerCalls, 1);

  // --- the deck ------------------------------------------------------------
  ok("the deck was written", existsSync(result.deckPath), result.deckPath);
  ok("the board PDF was written", existsSync(result.pdfPath), result.pdfPath);
  ok("the deck is not empty", statSync(result.deckPath).size > 1_000);
  ok("the PDF is not empty", statSync(result.pdfPath).size > 1_000);
  ok(
    "the PDF has the PDF magic",
    (await import("node:fs")).readFileSync(result.pdfPath).subarray(0, 5).toString("latin1") === "%PDF-",
  );

  // --- the numbers ---------------------------------------------------------
  // 1_200_000 * 1.08/12 + 1_200_000 = 1_208_000.
  equal("the monthly revenue is right", result.values.MonthlyRevenue, 1_208_000);
  equal("the growth rate is right", result.values.GrowthRate, 0.08);
  equal("the headline revenue is right", result.values.HeadlineRevenue, 1_208_000);

  // --- a circular model is blocked, not published --------------------------
  const cyclicWorkspace = resolve(WORK, "cyclic");
  mkdirSync(cyclicWorkspace, { recursive: true });
  const cyclic = new FinancialPipelineSupervisor({
    workspace: cyclicWorkspace,
    reviewer,
    log: () => {},
  });
  const cyclicBlueprint = buildBlueprint();
  // A sheet whose only cell refers to itself through a named range: the
  // engine evaluates it to `#CIRC!` and the audit has to block on it.
  cyclicBlueprint.sheets.push({ name: "Loop", template: "drivers" });
  cyclicBlueprint.namedRanges.push({
    name: "LoopCell",
    sheet: "Loop",
    a1: "A1",
    scope: "Workbook",
  });
  cyclicBlueprint.extraFormulas = { Loop: { A1: "=LoopCell+1" } };
  const cyclicResult = await cyclic.run(cyclicBlueprint, buildDeckBlueprint());
  equal("a circular model is blocked", cyclicResult.status, "blocked");
  ok(
    "the cycle is reported as an incident",
    cyclicResult.incidents.some((i) => i.category === "circular_reference"),
    JSON.stringify(cyclicResult.incidents.map((i) => i.category)),
  );
  ok(
    "the incident names the path",
    cyclicResult.incidents.some((i) => i.message.includes("→")),
    JSON.stringify(cyclicResult.incidents.map((i) => i.message)),
  );

  console.log(`\n${passed} assertions passed`);
}

await main();
