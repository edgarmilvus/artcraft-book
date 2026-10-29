// run_ex5.ts — acceptance harness for the typed rig-preset library.
//
// It validates five descriptors through the real merge/range/version path,
// checks the script-result guard, describes one applied preset and writes the
// validation evidence.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  RUNTIME_VERSION,
  describeApplied,
  isAppliedPresetDetail,
  validatePresetParams,
  type AppliedPreset,
  type PresetDescriptor,
  type PresetName,
} from "./05_reusable-rig-preset-library-typed-null-hierarchies-and-constraint-expressions.js";

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

function descriptor(name: PresetName, params: PresetDescriptor["params"], version = 2): PresetDescriptor {
  return { name, version, params, preconditions: [] };
}

const DESCRIPTORS: Record<PresetName, PresetDescriptor> = {
  pushFollow: descriptor("pushFollow", {
    dampX: { type: "number", default: 0.8, since: 1, min: 0, max: 1 },
    dampY: { type: "number", default: 0.8, since: 1, min: 0, max: 1 },
    delayFrames: { type: "integer", default: 2, since: 1, min: 0, max: 12 },
  }),
  shakeNull: descriptor("shakeNull", {
    amplitude: { type: "number", default: 20, since: 1, min: 0, max: 100 },
    frequency: { type: "number", default: 3, since: 1, min: 0, max: 20 },
  }),
  wordmarkRig: descriptor("wordmarkRig", {
    breath: { type: "number", default: 0.02, since: 2, min: 0, max: 0.2 },
    settleFrames: { type: "integer", default: 4, since: 2, min: 0, max: 24 },
  }),
  trimWipe: descriptor("trimWipe", {
    wipeDuration: { type: "number", default: 1, since: 1, min: 0.1, max: 5 },
  }),
  counterRig: descriptor("counterRig", {
    multiplier: { type: "number", default: 1, since: 1, min: 0, max: 100 },
    padWidth: { type: "integer", default: 4, since: 1, min: 1, max: 8 },
  }),
};

function main(): void {
  for (const name of ["preset-validation.json", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  mkdirSync(OUTPUT, { recursive: true });

  console.log("\n# five presets");
  const names = Object.keys(DESCRIPTORS) as PresetName[];
  equal("library: five presets", names.length, 5);
  equal("runtime: version 2", RUNTIME_VERSION, 2);
  for (const name of names) {
    const result = validatePresetParams(DESCRIPTORS[name], {});
    ok(`preset ${name}: defaults validate`, result.ok);
  }

  console.log("\n# validation");
  const pushed = validatePresetParams(DESCRIPTORS.pushFollow, { dampX: 0.5, unknown: 7 });
  ok("validation: valid values pass", pushed.ok);
  if (pushed.ok) {
    equal("validation: default merged", (pushed.value.params as any).dampY, 0.8);
    equal("validation: supplied preserved", (pushed.value.params as any).dampX, 0.5);
    ok("validation: unknown param warned", pushed.value.warnings.some((w) => w.includes("unknown-param-dropped")));
  }
  const outOfRange = validatePresetParams(DESCRIPTORS.pushFollow, { dampX: 2 });
  ok("validation: out of range fails", !outOfRange.ok);
  ok("validation: range is named", !outOfRange.ok && outOfRange.error.code === "PresetParameterMismatch");
  const wrongType = validatePresetParams(DESCRIPTORS.pushFollow, { dampX: "high" });
  ok("validation: wrong type fails", !wrongType.ok);
  const tooNew = validatePresetParams(descriptor("trimWipe", DESCRIPTORS.trimWipe.params, 99), {});
  ok("validation: a newer preset is refused", !tooNew.ok && tooNew.error.code === "PresetVersionTooNew");
  const fresh = descriptor("trimWipe", DESCRIPTORS.trimWipe.params, 2);
  ok("validation: a v2 preset is accepted", validatePresetParams(fresh, { wipeDuration: 2 }).ok);

  console.log("\n# applied result guard");
  const detail = {
    createdLayers: [3, 4], expressions: { "position": [] },
    essentialProperties: [{ layer: 3, control: "Dampen" }], reused: false,
    nullLayer: 3,
  };
  ok("guard: a valid detail passes", isAppliedPresetDetail(detail));
  ok("guard: missing createdLayers fails", !isAppliedPresetDetail({ ...detail, createdLayers: undefined }));
  ok("guard: non-numeric layer fails", !isAppliedPresetDetail({ ...detail, createdLayers: [3, "x"] }));
  const applied = {
    preset: "pushFollow", version: 2, detail, undoLabel: "Rig Library: pushFollow", warnings: [],
  } as AppliedPreset;
  ok("describe: pushFollow names the null", describeApplied(applied).includes("null #3"));

  writeFileSync(resolve(OUTPUT, "preset-validation.json"), JSON.stringify({
    runtimeVersion: RUNTIME_VERSION,
    descriptors: DESCRIPTORS,
    results: Object.fromEntries(names.map((name) => [name, validatePresetParams(DESCRIPTORS[name], {})])),
    rejected: { outOfRange, wrongType, tooNew },
  }, null, 2));
  ok("output: preset-validation.json", existsSync(resolve(OUTPUT, "preset-validation.json")));
  const disk = JSON.parse(readFileSync(resolve(OUTPUT, "preset-validation.json"), "utf8"));
  equal("output: five descriptors", Object.keys(disk.descriptors).length, 5);
  assert.equal(disk.runtimeVersion, 2);

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 5,
    engine: "effectcraft rig preset library (pure validation)",
    assertions: passed + 1,
    presets: names,
    runtimeVersion: RUNTIME_VERSION,
    artefacts: ["preset-validation.json"],
    result: "five descriptors validated, unknown/range/type/version failures exercised and the result guard checked",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main();
