// run_ex3.ts — deterministic harness for the Pathfinder composition pipeline.
//
// The pipeline walks a Boolean tree, applies the live operations as effects
// and the destructive ones as commands, builds one document per size tier and
// writes a diff report. The harness checks the tree walk, the report and the
// files that come out of it.

import { strict as assert } from "node:assert";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TIER_CANVAS,
  anchorsOf,
  composeLogo,
  countSelfIntersections,
  tierCanvas,
  tierName,
  type CompositionSpec,
} from "./03_non-destructive-pathfinder-composition-for-multi-resolution-logos.js";

const OUTPUT = resolve(process.cwd(), "..", "output");
const BUILD = resolve(OUTPUT, "build");

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

function unitGeometry(): void {
  console.log("\n# geometry");
  const square: [number, number][] = [[0, 0], [10, 0], [10, 10], [0, 10]];
  equal("geometry: a square does not cross itself", countSelfIntersections(square), 0);
  const bowtie: [number, number][] = [[0, 0], [10, 10], [10, 0], [0, 10]];
  equal("geometry: a bowtie crosses itself", countSelfIntersections(bowtie) > 0, true);
  equal("geometry: the tiers have their canvases", TIER_CANVAS.xl, 512);
  equal("geometry: a tier name resolves", tierName("md"), "md");
  equal("geometry: a tier canvas resolves", tierCanvas("sm"), 32);
  equal("geometry: an object tier resolves", tierCanvas({ tier: "md", canvasPt: 200 }), 200);
  equal("geometry: an empty node has no corners", anchorsOf({ kind: {} }).length, 0);
}

async function main(): Promise<void> {
  rmSync(BUILD, { recursive: true, force: true });
  rmSync(resolve(OUTPUT, "build-2"), { recursive: true, force: true });
  rmSync(resolve(OUTPUT, "report.json"), { force: true });
  mkdirSync(BUILD, { recursive: true });

  unitGeometry();

  const spec = JSON.parse(readFileSync(resolve(process.cwd(), "01_json.json"), "utf8")) as CompositionSpec;

  console.log("\n# the composition");
  const result = await composeLogo(spec, BUILD);
  equal("composition: three tiers", result.diffs.length, 3);
  equal("composition: three files", result.files.length, 3);

  console.log("\n# the diff report");
  const report = JSON.parse(readFileSync(resolve(BUILD, "diff.json"), "utf8"));
  equal("report: it names the logo", report.logo, "caduceus-h");
  ok("report: it has one entry per tier", report.tiers.length === 3);

  for (const tier of report.tiers) {
    for (const field of [
      "tier",
      "booleanOpsApplied",
      "liveOpsRetained",
      "finalPathCount",
      "fillRule",
      "selfIntersections",
      "warnings",
      "contentHash",
    ]) {
      ok(`report: ${tier.tier} has ${field}`, tier[field] !== undefined);
    }
    ok(`report: ${tier.tier} hashes its geometry`, /^[0-9a-f]{64}$/.test(tier.contentHash));
    ok(`report: ${tier.tier} has no self-intersections`, tier.selfIntersections === 0, `${tier.selfIntersections}`);
    ok(
      `report: ${tier.tier} declares a fill rule`,
      tier.fillRule === "nonZero" || tier.fillRule === "evenOdd",
    );
    ok(`report: ${tier.tier} has no warnings`, tier.warnings.length === 0, tier.warnings.join("; "));
  }

  const xl = report.tiers.find((t: any) => t.tier === "xl")!;
  const md = report.tiers.find((t: any) => t.tier === "md")!;
  const sm = report.tiers.find((t: any) => t.tier === "sm")!;

  equal("report: the large tier keeps both live effects", xl.liveOpsRetained, 2);
  equal("report: the large tier runs no destructive boolean", xl.booleanOpsApplied, 0);
  equal("report: the small tier flattens with one boolean", sm.booleanOpsApplied, 1);
  ok("report: the small tier has fewer paths", sm.finalPathCount < xl.finalPathCount);
  ok("report: the tiers differ", xl.contentHash !== md.contentHash && md.contentHash !== sm.contentHash);

  console.log("\n# the files");
  for (const file of result.files) {
    ok(`file: ${file.split("/").pop()} exists`, existsSync(file));
    ok(`file: ${file.split("/").pop()} is not empty`, readFileSync(file).length > 400);
    const svg = file.replace(/\.vectorcraft$/, ".svg");
    ok(`file: ${svg.split("/").pop()} exists`, existsSync(svg));
    ok(`file: ${svg.split("/").pop()} is an SVG`,
      readFileSync(svg).subarray(0, 5).toString().includes("<svg") || readFileSync(svg).toString().includes("<svg"));
  }

  console.log("\n# determinism");
  const second = await composeLogo(spec, resolve(OUTPUT, "build-2"));
  const firstHashes = report.tiers.map((t: any) => t.contentHash).join(",");
  const secondHashes = second.diffs.map((t: any) => t.contentHash).join(",");
  equal("determinism: the geometry hashes match", secondHashes, firstHashes);
  assert.ok(firstHashes.length > 60);

  copyFileSync(resolve(process.cwd(), "01_json.json"), resolve(OUTPUT, "composition-spec.json"));
  const artefacts = [
    "build/caduceus-h-xl.vectorcraft",
    "build/caduceus-h-xl.svg",
    "build/caduceus-h-md.vectorcraft",
    "build/caduceus-h-md.svg",
    "build/caduceus-h-sm.vectorcraft",
    "build/caduceus-h-sm.svg",
    "build/diff.json",
    "build-2/caduceus-h-xl.vectorcraft",
    "composition-spec.json",
  ];
  for (const artefact of artefacts) {
    ok(`output: ${artefact}`, existsSync(resolve(OUTPUT, artefact)));
  }
  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 3,
    engine: "vectorcraft-cli",
    assertions: passed + 1,
    logo: report.logo,
    tiers: report.tiers.map((tier: any) => ({
      tier: tier.tier,
      liveOpsRetained: tier.liveOpsRetained,
      booleanOpsApplied: tier.booleanOpsApplied,
      finalPathCount: tier.finalPathCount,
      contentHash: tier.contentHash,
    })),
    artefacts,
    result: "xl and md keep live Pathfinder effects; sm flattens one boolean and still matches the deterministic hash",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
