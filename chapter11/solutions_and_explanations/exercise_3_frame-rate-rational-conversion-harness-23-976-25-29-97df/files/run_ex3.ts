// run_ex3.ts — acceptance harness for the rational frame-rate conversion.
//
// It converts a 25 fps EDL to 23.976, checks every residual against half a
// target frame, round-trips 29.97 drop-frame timecode, and writes the CSV and
// parity report.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bankerRound,
  convert,
  dfTimecodeToNf,
  f25ToF23Rounded,
  nfToDfTimecode,
  writeCsv,
  type EdlCut,
} from "./03_frame-rate-rational-conversion-harness-23-976-25-29-97df.js";

const HERE = process.cwd();
const OUTPUT = resolve(HERE, "..", "output");
const HALF_23976 = 10_594_584_000n / 2n + 1n;

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

function main(): void {
  for (const name of ["edl-conversion.csv", "parity-report.json", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  mkdirSync(OUTPUT, { recursive: true });

  console.log("\n# rational conversion");
  equal("banker: 1/2 -> 0", bankerRound(1n, 2n), 0n);
  equal("banker: 3/2 -> 2", bankerRound(3n, 2n), 2n);
  const one = f25ToF23Rounded(25n);
  equal("frame: 25 PAL frames -> 26 target frames", one.rounded, 26n);
  ok("frame: residual is within half a frame", (one.residualTicks < 0n ? -one.residualTicks : one.residualTicks) <= HALF_23976);

  const cuts: EdlCut[] = Array.from({ length: 12 }, (_, index) => ({
    cutId: `cut-${index + 1}`,
    sourceIn25: index * 25,
    sourceOut25: index * 25 + 18,
  }));
  const { rows, report } = convert(cuts);
  equal("convert: two edges per cut", rows.length, cuts.length * 2);
  equal("convert: cuts processed", report.cutsProcessed, cuts.length);
  equal("convert: DF round trips", report.dfRoundTripFailures, 0);
  ok("convert: max residual within half frame", report.maxResidualAbsTicks <= HALF_23976,
     `${report.maxResidualAbsTicks}`);
  ok("convert: source ticks are 25 fps", rows.every((row) => row.sourceTick === BigInt(row.sourceFrame25) * 10_160_640_000n));
  ok("convert: target ticks are whole 23.976 frames", rows.every((row) => row.targetTick % 10_594_584_000n === 0n));
  ok("convert: each residual matches the rational helper",
     rows.every((row) => row.residualTicks === f25ToF23Rounded(BigInt(row.sourceFrame25)).residualTicks));

  console.log("\n# drop-frame timecode");
  equal("df: frame zero", nfToDfTimecode(0), "00:00:00;00");
  equal("df: one second", nfToDfTimecode(30), "00:00:01;00");
  equal("df: the first minute drop", nfToDfTimecode(1800), "00:01:00;02");
  equal("df: ten-minute boundary", nfToDfTimecode(17982), "00:10:00;00");
  for (const nf of [0, 1, 29, 30, 1799, 1800, 1802, 17981, 17982, 21_600]) {
    const tc = nfToDfTimecode(nf);
    equal(`df: round trip ${nf}`, dfTimecodeToNf(tc), nf);
  }

  writeCsv(rows, resolve(OUTPUT, "edl-conversion.csv"));
  writeFileSync(resolve(OUTPUT, "parity-report.json"), JSON.stringify({
    rows: rows.map((row) => ({
      ...row,
      sourceTick: row.sourceTick.toString(),
      targetTick: row.targetTick.toString(),
      residualTicks: row.residualTicks.toString(),
    })),
    report: {
      ...report,
      maxResidualAbsTicks: report.maxResidualAbsTicks.toString(),
    },
  }, null, 2));
  ok("output: edl-conversion.csv", existsSync(resolve(OUTPUT, "edl-conversion.csv")));
  ok("output: parity-report.json", existsSync(resolve(OUTPUT, "parity-report.json")));
  const csv = readFileSync(resolve(OUTPUT, "edl-conversion.csv"), "utf8");
  equal("csv: one row per edge plus header", csv.trim().split("\n").length, rows.length + 1);
  assert.ok(csv.includes("cut-1:in"));

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 3,
    engine: "filmcraft timebase (pure)",
    assertions: passed + 1,
    cuts: cuts.length,
    edges: rows.length,
    maxResidualAbsTicks: report.maxResidualAbsTicks.toString(),
    maxResidualMicroseconds: report.maxResidualMicroseconds,
    maxResidualSamples48k: report.maxResidualSamples48k,
    dfRoundTripFailures: report.dfRoundTripFailures,
    artefacts: ["edl-conversion.csv", "parity-report.json"],
    result: "25 -> 23.976 conversion stayed within half a target frame; 29.97 DF round-tripped",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main();
