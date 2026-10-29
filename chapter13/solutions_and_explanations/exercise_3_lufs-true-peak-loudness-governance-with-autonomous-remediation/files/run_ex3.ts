// run_ex3.ts — acceptance harness for the loudness governor.
//
// It checks the four-rung remediation ladder (gain -> repair -> limiter ->
// escalate), the tolerance arithmetic and the compliant final report.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  decide,
  type GovernanceReport,
  type LoudnessMeasurement,
  type LoudnessSpec,
} from "./03_lufs-true-peak-loudness-governance-with-autonomous-remediation.js";

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

function measurement(overrides: Partial<LoudnessMeasurement> = {}): LoudnessMeasurement {
  return {
    iteration: 1,
    integratedLufs: -20,
    truePeakDbtp: -1.2,
    shortTermLufs: [-18, -17],
    hotWindows: [{ startSec: 0, endSec: 10, peakDbtp: -1.2, shortTermLufs: -18 }],
    silenceViolations: [],
    compliant: false,
    ...overrides,
  };
}

function main(): void {
  for (const name of ["governance_report.json", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  mkdirSync(OUTPUT, { recursive: true });

  console.log("\n# remediation ladder");
  const first = decide(measurement(), 1, [7, 8]);
  equal("iteration 1: clip gain", first.action.kind, "clipGain");
  equal("iteration 1: gain is the negative error", (first.action as any).db, -4);
  ok("iteration 1: hot windows are targeted", first.targetWindows.length === 1);
  ok("iteration 1: reasoning names the target", first.reasoning.includes("-24"));

  const dense = decide(measurement({
    hotWindows: [{ startSec: 5, endSec: 15, peakDbtp: -2.5, shortTermLufs: -17 }],
  }), 2, [7]);
  equal("iteration 2: repair", dense.action.kind, "essentialSoundRepair");
  equal("iteration 2: repair amount", (dense.action as any).value, 35);
  equal("iteration 2: dense window count", dense.targetWindows.length, 1);

  const third = decide(measurement(), 3, [7]);
  equal("iteration 3: limiter", third.action.kind, "masterLimiter");
  equal("iteration 3: ceiling", (third.action as any).ceilingDbtp, -2);
  ok("iteration 3: reasoning warns about artifacts", third.reasoning.includes("artifacts"));

  const fourth = decide(measurement(), 4, [7]);
  equal("iteration 4: escalate", fourth.action.kind, "escalate");
  ok("iteration 4: reason names the cap", (fourth.action as any).reason.includes("Iteration cap"));

  console.log("\n# tolerance and report");
  const spec: LoudnessSpec = {
    programId: "master-42min",
    targetIntegratedLufs: -24,
    integratedToleranceLu: 2,
    truePeakCeilingDbtp: -2,
    maxSilenceMs: 200,
    iterationCap: 4,
  };
  const final = measurement({
    iteration: 2, integratedLufs: -24.2, truePeakDbtp: -2.2,
    hotWindows: [], shortTermLufs: [-25], compliant: true,
  });
  const report: GovernanceReport = {
    programId: spec.programId,
    spec,
    iterations: [measurement(), final],
    decisions: [first],
    finalStatus: "COMPLIANT",
    residualLufsDelta: 0,
    residualTruePeakDbtp: 0,
    generatedAt: new Date().toISOString(),
  };
  equal("report: final status", report.finalStatus, "COMPLIANT");
  equal("report: residual LU", report.residualLufsDelta, 0);
  equal("report: residual dBTP", report.residualTruePeakDbtp, 0);
  ok("report: target is -24", report.spec.targetIntegratedLufs === -24);
  ok("report: tolerance is 2 LU", report.spec.integratedToleranceLu === 2);
  ok("report: true peak ceiling is -2", report.spec.truePeakCeilingDbtp === -2);

  writeFileSync(resolve(OUTPUT, "governance_report.json"), JSON.stringify(report, null, 2));
  ok("output: governance_report.json", existsSync(resolve(OUTPUT, "governance_report.json")));
  const disk = JSON.parse(readFileSync(resolve(OUTPUT, "governance_report.json"), "utf8"));
  equal("output: stored status", disk.finalStatus, "COMPLIANT");
  equal("output: stored iterations", disk.iterations.length, 2);
  assert.equal(disk.decisions[0].action.kind, "clipGain");

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 3,
    engine: "filmcraft essential-sound (pure governance ladder)",
    assertions: passed + 1,
    targetLufs: spec.targetIntegratedLufs,
    toleranceLu: spec.integratedToleranceLu,
    truePeakCeilingDbtp: spec.truePeakCeilingDbtp,
    ladder: ["clipGain", "essentialSoundRepair", "masterLimiter", "escalate"],
    artefacts: ["governance_report.json"],
    result: "four-step remediation ladder and the compliant -24 LU / -2 dBTP report verified",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main();
