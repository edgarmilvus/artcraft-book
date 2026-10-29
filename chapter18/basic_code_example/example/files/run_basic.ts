// run_basic.ts — deterministic harness for the finance-report listing.
//
// The listing runs for real: GridCraft builds the three-sheet model, the
// audit pass probes it, the workbook is written, and the envelope is
// persisted. The harness then reads the artefacts back and checks them.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { generateFinancialReport } from "./01_route.js";

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

const REQUEST = {
  tenant: "northwind",
  growthRate: 0.08,
  grossMargin: 0.72,
  monthlyOpex: 250_000,
  seedRevenue: 1_200_000,
};

async function main(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });

  // The pipeline writes into `<cwd>/var/finance/<tenant>/<day>`; the
  // harness runs it with the project's output directory as its cwd.
  const previous = process.cwd();
  process.chdir(OUTPUT);
  let envelope;
  try {
    envelope = await generateFinancialReport(REQUEST);
  } finally {
    process.chdir(previous);
  }

  // --- the envelope --------------------------------------------------------
  ok("the workbook was written", existsSync(envelope.workbookPath), envelope.workbookPath);
  ok("the envelope was written", existsSync(resolve(envelope.workbookPath, "../audit.json")));
  equal("the workbook has three sheets", envelope.sheets.length, 3);
  ok(
    "the sheets are the ones the model declares",
    ["Assumptions", "Revenue", "P&L"].every((s) => envelope.sheets.includes(s)),
    envelope.sheets.join(", "),
  );
  equal("the audit found no circular reference", envelope.circularReferences.length, 0);
  ok("the audit counted the dependency edges", envelope.dependencyEdges > 0, String(envelope.dependencyEdges));
  equal("the revision hash is a sha256", envelope.revisionHash.length, 64);

  // --- the named ranges ----------------------------------------------------
  for (const name of ["GrowthRate", "GrossMargin", "MonthlyOpex", "SeedRevenue"]) {
    ok(`the named range ${name} exists`, name in envelope.namedRanges, JSON.stringify(Object.keys(envelope.namedRanges)));
  }
  ok(
    "the named ranges point at the assumptions sheet",
    Object.values(envelope.namedRanges).every((r) => r.includes("Assumptions")),
    JSON.stringify(envelope.namedRanges),
  );

  // --- the workbook --------------------------------------------------------
  const workbook = readFileSync(envelope.workbookPath);
  ok("the workbook is a ZIP package", workbook.subarray(0, 2).toString("latin1") === "PK");
  ok("the workbook carries the sheet part", workbook.toString("latin1").includes("xl/workbook.xml"));

  // --- the numbers ---------------------------------------------------------
  // The workbook is read back through the engine's own reader, so the
  // assertions are about the model's arithmetic and not about its bytes.
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const exec = promisify(execFile);
  const { stdout: revenueCsv } = await exec("gridcraft-cli", [
    "cat", envelope.workbookPath, "--sheet", "Revenue", "--range", "A2:C2",
  ]);
  ok("the seed is the assumption, not a constant", revenueCsv.includes("1200000"), revenueCsv);
  ok("the first compounding month is right", revenueCsv.includes("1208000"), revenueCsv);

  const { stdout: pnlCsv } = await exec("gridcraft-cli", [
    "cat", envelope.workbookPath, "--sheet", "P&L", "--range", "A2:C2",
  ]);
  // M0: 1_200_000 * 0.72 - 250_000 = 614_000.
  ok("the operating profit is right", pnlCsv.includes("614000"), pnlCsv);
  // M1: 1_208_000 * 0.72 - 250_000 = 619_760.
  ok("the profit compounds", pnlCsv.includes("619760"), pnlCsv);

  console.log(`\n${passed} assertions passed`);
}

await main();
