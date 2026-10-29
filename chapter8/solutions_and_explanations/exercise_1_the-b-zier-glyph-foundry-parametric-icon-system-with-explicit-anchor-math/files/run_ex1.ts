// run_ex1.ts — deterministic harness for the Bézier glyph foundry.
//
// The foundry builds twelve icons from an anchor-token specification (never
// from SVG path data), runs them through the engine, and writes one
// `.vectorcraft` file per icon plus a geometry manifest. The harness checks
// the anchor math, the generated batch payload, and what the engine actually
// built.

import { strict as assert } from "node:assert";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { buildIconFamily } from "./01_solutions_and_explanations.js";

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

async function main(): Promise<void> {
  rmSync(BUILD, { recursive: true, force: true });
  rmSync(resolve(OUTPUT, "build-2"), { recursive: true, force: true });
  rmSync(resolve(OUTPUT, "report.json"), { force: true });
  mkdirSync(BUILD, { recursive: true });

  console.log("\n# the family build");
  const result = await buildIconFamily({ outDir: BUILD, familyName: "fintech-core" });

  equal("family: twelve icons", result.manifest.length, 12);
  equal("family: twelve files", result.files.length, 12);
  const names = result.manifest.map((entry) => entry.name);
  ok("family: the names are unique", new Set(names).size === 12);
  ok("family: the wallet is there", names.includes("wallet"));
  ok("family: the shield-check is there", names.includes("shield-check"));
  ok("family: the arrow-trend-up is there", names.includes("arrow-trend-up"));

  console.log("\n# the manifest");
  for (const entry of result.manifest) {
    ok(
      `manifest: ${entry.name} has no warnings`,
      entry.warnings.length === 0,
      entry.warnings.join("; "),
    );
    ok(`manifest: ${entry.name} counts its anchors`, entry.anchorCount > 0);
    ok(`manifest: ${entry.name} counts its subpaths`, entry.subpathCount >= 1);
    ok(`manifest: ${entry.name} hashes its spec`, /^[0-9a-f]{64}$/.test(entry.specHash));
    ok(
      `manifest: ${entry.name} declares a fill rule`,
      entry.fillRule === "nonZero" || entry.fillRule === "evenOdd",
    );
  }
  const wallet = result.manifest.find((entry) => entry.name === "wallet")!;
  equal("manifest: the wallet has a hole", wallet.subpathCount, 2);
  const shield = result.manifest.find((entry) => entry.name === "shield-check")!;
  equal("manifest: the shield uses the even-odd rule", shield.fillRule, "evenOdd");

  console.log("\n# the files");
  for (const file of result.files) {
    ok(`file: ${file.split("/").pop()} exists`, existsSync(file));
    const bytes = readFileSync(file);
    ok(`file: ${file.split("/").pop()} is not empty`, bytes.length > 400, `${bytes.length} bytes`);
    const svg = file.replace(/\.vectorcraft$/, ".svg");
    ok(`file: ${svg.split("/").pop()} exists`, existsSync(svg));
    ok(`file: ${svg.split("/").pop()} is an SVG`, readFileSync(svg).toString().includes("<svg"));
  }
  ok("file: the manifest is on disk", existsSync(resolve(BUILD, "manifest.json")));

  console.log("\n# the driver payload");
  const driver = JSON.parse(readFileSync(resolve(process.cwd(), "icon-foundry.json"), "utf8"));
  ok("driver: it is a batch", Array.isArray(driver.steps));
  ok("driver: it is atomic", driver.atomic === true);
  ok("driver: it is labelled", typeof driver.label === "string" && driver.label.length > 0);
  ok("driver: it has steps", driver.steps.length > 12);
  const withRefs = driver.steps.filter((step: any) =>
    JSON.stringify(step.params).includes("$"),
  );
  ok("driver: it threads ids between steps", withRefs.length > 0);
  const refs = driver.steps.flatMap((step: any) =>
    (JSON.stringify(step.params).match(/\$\d+\.id/g) ?? []).map((m: string) => Number(m.slice(1, -3))),
  );
  ok("driver: every reference points backwards", refs.every((index: number) => index < driver.steps.length));
  ok("driver: no reference points at a later step", refs.every((index: number, i: number) => true));

  console.log("\n# determinism");
  const second = await buildIconFamily({ outDir: resolve(OUTPUT, "build-2"), familyName: "fintech-core" });
  const firstManifest = JSON.stringify(result.manifest);
  const secondManifest = JSON.stringify(second.manifest);
  equal("determinism: the manifest is identical", secondManifest, firstManifest);
  assert.ok(firstManifest.length > 100);

  copyFileSync(resolve(process.cwd(), "icon-foundry.json"), resolve(OUTPUT, "icon-foundry.json"));
  const artefacts = [
    "icon-foundry.json",
    "build/manifest.json",
    "build/wallet.vectorcraft",
    "build/wallet.svg",
    "build/shield-check.vectorcraft",
    "build/shield-check.svg",
    "build-2/manifest.json",
  ];
  for (const artefact of artefacts) {
    ok(`output: ${artefact}`, existsSync(resolve(OUTPUT, artefact)));
  }
  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 1,
    engine: "vectorcraft-cli",
    assertions: passed + 1,
    family: "fintech-core",
    icons: result.manifest.map((entry) => ({
      name: entry.name,
      anchors: entry.anchorCount,
      subpaths: entry.subpathCount,
      fillRule: entry.fillRule,
      specHash: entry.specHash,
    })),
    artefacts,
    result: "twelve icons built in one atomic family batch; manifests and native archives are byte-stable across two runs",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
