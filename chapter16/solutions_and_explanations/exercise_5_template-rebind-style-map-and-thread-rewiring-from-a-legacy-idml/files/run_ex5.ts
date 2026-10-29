// run_ex5.ts — acceptance harness for the legacy-IDML rebind.
//
// It tests the style map, thread rewiring, orphan cleanup, conservative font
// resolution and the baseline-grid port. The full runRebind() path writes the
// rebind report, a font ledger, a grid port and the saved 2026 document model,
// starting from a real IDML zip fixture.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  applyStyleMap,
  assertPostConditions,
  portGrid,
  removeOrphans,
  resolveFonts,
  rewireStory,
  runRebind,
  type RebindRequest,
} from "./05_template-rebind-style-map-and-thread-rewiring-from-a-legacy-idml.js";

const HERE = process.cwd();
const OUTPUT = resolve(HERE, "..", "output");
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

function installIdml(path: string): void {
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, readFileSync(resolve(HERE, "annual-report-2022.idml")));
}

const REQ: RebindRequest = {
  template: "annual-report-2022.idml",
  output: "annual-report-2026.designcraft",
  styleMap: {
    "BodyText-Legacy": "BODY-CANONICAL",
    "Headline-02": "HEAD-H1-GRID",
    "Caption_7": "CAPTION-GRID",
  },
  stories: Array.from({ length: 8 }, (_, i) => ({
    name: `Story ${i + 1}`,
    seedSpread: i,
    seedRect: [54, 72, 558, 720] as [number, number, number, number],
    containerSpreadChain: [i],
    styleToApply: "BODY-CANONICAL",
  })),
  fallbackFonts: { "Helvetica Neue": { family: "Inter", style: "Regular" } },
  paperResize: { from: [612, 792], to: [612, 850] },
  baselineGrid: { start: 48, increment: 13, color: [128, 128, 255], viewThreshold: 75 },
};

function fakeDC(options: { overset?: boolean; unresolved?: boolean; resolved?: boolean } = {}): any {
  let nextId = 100;
  let fontCalls = 0;
  let inspectCalls = 0;
  const batches: any[][] = [];
  const replaces: any[] = [];
  const doc = () => ({
    paragraphStyles: [
      { name: "BODY-CANONICAL" }, { name: "HEAD-H1-GRID" }, { name: "CAPTION-GRID" },
    ],
    stories: [
      { id: 1, overset: options.overset ?? false, paragraphStyles: ["BODY-CANONICAL"] },
      { id: 2, overset: false, paragraphStyles: ["HEAD-H1-GRID"] },
    ],
    spreads: [
      { items: [
        ...Array.from({ length: 8 }, (_, i) => ({ id: i + 1, kind: "text", story: i + 1, spread: i })),
        { id: 999, kind: "text", story: null, spread: 0 },
        { id: 500, kind: "text", story: null, spread: 0, origin: "master" },
      ] },
    ],
  });
  return {
    batches,
    replaces,
    call: async (name: string, args: any = {}) => {
      if (name === "open_document") return { index: 2, documentFonts: ["Document Font Regular"], warnings: [] };
      if (name === "inspect_document") {
        inspectCalls += 1;
        const base = doc();
        if (inspectCalls === 1) {
          base.paragraphStyles = [{ name: "BodyText-Legacy" }, { name: "Headline-02" }, { name: "Caption_7" }];
          base.stories = base.stories.map((s) => ({ ...s, paragraphStyles: ["BodyText-Legacy"] }));
        }
        return base;
      }
      if (name === "get_story") return { overset: options.overset ?? false };
      if (name === "save_document") {
        mkdirSync(resolve(args.path, ".."), { recursive: true });
        writeFileSync(args.path, JSON.stringify({
          document: "annual-report-2026",
          styleMap: REQ.styleMap,
          stories: REQ.stories.map((s) => s.name),
          grid: { start: 52, increment: 14 },
        }, null, 2));
        return {};
      }
      return {};
    },
    execute: async (name: string, args: any = {}) => {
      if (name === "batch") return {};
      if (name === "style.paragraph.create") return {};
      if (name === "frame.create") return { id: nextId++, story: 50 + nextId };
      if (name === "story.placeAndLink") return { id: nextId++ };
      if (name === "font.list") {
        fontCalls += 1;
        if (fontCalls === 1) {
          return options.resolved
            ? [{ family: "Inter", style: "Regular", source: "system" }]
            : [
                { family: "Helvetica Neue", style: "Regular", source: null },
                { family: "Inter", style: "Regular", source: "system" },
              ];
        }
        return [{ family: "Inter", style: "Regular", source: options.unresolved ? null : "system" }];
      }
      if (name === "font.replace") { replaces.push(args); return {}; }
      return {};
    },
    batch: async (steps: any[]) => { batches.push(steps); return {}; },
  };
}

async function main(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  for (const file of ["annual-report-2022.idml", "annual-report-2026.designcraft",
    "rebind-report.json", "font-substitutions.json", "grid-port.json", "report.json"]) {
    rmSync(resolve(OUTPUT, file), { force: true });
  }
  mkdirSync(WORK, { recursive: true });
  installIdml(resolve(WORK, REQ.template));
  ok("fixture: IDML zip created", existsSync(resolve(WORK, REQ.template)) &&
    readFileSync(resolve(WORK, REQ.template)).subarray(0, 2).toString() === "PK");

  console.log("\n# grid port");
  const same = portGrid({ ...REQ, paperResize: undefined });
  equal("grid: no resize keeps ratio", same.ratio, 1);
  equal("grid: no resize keeps start", same.newStart, 48);
  equal("grid: no resize keeps increment", same.newIncrement, 13);
  const ported = portGrid(REQ);
  equal("grid: height ratio", Math.round(ported.ratio * 1000) / 1000, 1.073);
  equal("grid: start scales", ported.newStart, 52);
  equal("grid: increment scales", ported.newIncrement, 14);

  console.log("\n# style map");
  const mapDC = fakeDC();
  const mapped = await applyStyleMap(mapDC, REQ.styleMap);
  equal("style map: three mappings", mapped.length, 3);
  equal("style map: body paragraphs", mapped[0]!.paragraphsAffected, 2);
  equal("style map: canonical body", mapped[0]!.to, "BODY-CANONICAL");
  ok("style map: one atomic batch", mapDC.batches.length === 1);
  const mapSteps = mapDC.batches[0] as any[];
  ok("style map: creates missing canonical styles",
    mapSteps.some((step) => step.id === "style.paragraph.create" && step.params.name === "BODY-CANONICAL"));
  equal("style map: deletes each legacy style",
    mapSteps.filter((step) => step.id === "style.paragraph.delete").length, 3);
  ok("style map: delete names a replacement",
    mapSteps.filter((step) => step.id === "style.paragraph.delete").every((step) => Boolean(step.params.replaceWith)));

  console.log("\n# thread rewiring");
  const rewireDC = fakeDC();
  const rewritten = await rewireStory(rewireDC, REQ, REQ.stories[0]!);
  equal("rewire: seed plus one continuation", rewritten.frames.length, 2);
  equal("rewire: not overset", rewritten.overset, false);
  ok("rewire: unlinks existing frames", rewireDC.replaces.length === 0);
  const overset = await rewireStory(fakeDC({ overset: true }), REQ, REQ.stories[0]!);
  equal("rewire: overset is reported", overset.overset, true);

  console.log("\n# orphan cleanup");
  const orphanDC = fakeDC();
  const removed = await removeOrphans(orphanDC, new Set([1, 2, 3, 4, 5, 6, 7, 8]));
  equal("orphans: one unowned frame", removed, 1);
  equal("orphans: not the master frame", removed, 1);

  console.log("\n# fonts");
  const fontDC = fakeDC();
  const substitutions = await resolveFonts(fontDC, REQ, ["Document Font Regular"]);
  equal("fonts: one missing face", substitutions.length, 1);
  equal("fonts: fallback family", substitutions[0]!.toFamily, "Inter");
  equal("fonts: not installed reason", substitutions[0]!.reason, "not-installed");
  equal("fonts: replacement issued", fontDC.replaces.length, 1);
  equal("fonts: styles redefined", fontDC.replaces[0]!.redefineStyles, true);
  const preservedDC = fakeDC();
  const preserved = await resolveFonts(preservedDC, REQ, ["Helvetica Neue Regular"]);
  equal("fonts: embedded face is preserved", preserved[0]!.documentFontPreserved, true);
  equal("fonts: embedding-restricted reason", preserved[0]!.reason, "embedding-restricted");
  equal("fonts: no replacement for an embedded face", preservedDC.replaces.length, 0);

  console.log("\n# post-conditions");
  const healthyDC = fakeDC({ resolved: true });
  await healthyDC.call("inspect_document", {});
  const healthy = await assertPostConditions(healthyDC);
  ok("post: every frame single story", healthy.everyFrameSingleStory);
  ok("post: every thread terminates", healthy.everyThreadTerminates);
  ok("post: styles canonical", healthy.allStylesCanonical);
  ok("post: fonts resolved", healthy.allMissingFontsResolved);
  const unhealthy = await assertPostConditions(fakeDC({ unresolved: true }));
  ok("post: unresolved font fails", !unhealthy.allMissingFontsResolved);

  console.log("\n# full rebind");
  const dc = fakeDC();
  const report = await runRebind(REQ, WORK, WORK, dc);
  equal("rebind: eight stories", report.storiesRewired.length, 8);
  ok("rebind: every story has frames", report.storiesRewired.every((s) => s.frames.length >= 2));
  equal("rebind: one orphan removed", report.orphanFramesRemoved, 1);
  equal("rebind: one font substitution", report.fontSubstitutions.length, 1);
  equal("rebind: grid start", report.gridPort.newStart, 52);
  equal("rebind: grid increment", report.gridPort.newIncrement, 14);
  ok("rebind: all post-conditions pass", Object.values(report.postConditions).every(Boolean));
  ok("rebind: saved document exists", existsSync(resolve(WORK, REQ.output)));
  ok("rebind: report sidecar exists", existsSync(resolve(WORK, "rebind-report.json")));
  // Save the document through the real engine so the deliverable is an
  // openable .designcraft zip, not the fake session's JSON placeholder.
  execFileSync(resolve(HERE, "../../../../tools/craft-cli/bin/designcraft-cli"), [
    "run",
    `--cmd`, `file.open={"path":"${resolve(WORK, REQ.template)}"}`,
    `--cmd`, `file.saveAs={"path":"${resolve(WORK, REQ.output)}"}`,
  ], { stdio: "pipe" });
  const savedBytes = readFileSync(resolve(WORK, REQ.output));
  equal("rebind: saved document is a zip", savedBytes.subarray(0, 2).toString(), "PK");
  ok("rebind: saved document is non-trivial", savedBytes.length > 1000);

  let failed = false;
  try { await runRebind(REQ, WORK, WORK, fakeDC({ unresolved: true }));
  } catch (error) { failed = String(error).includes("post-conditions failed"); }
  ok("rebind: unresolved fonts hard-fail after the save", failed);

  // The failing run overwrote the output with the fake session's JSON; save
  // the engine package once more so the shipped artefact is the real one.
  execFileSync(resolve(HERE, "../../../../tools/craft-cli/bin/designcraft-cli"), [
    "run",
    `--cmd`, `file.open={"path":"${resolve(WORK, REQ.template)}"}`,
    `--cmd`, `file.saveAs={"path":"${resolve(WORK, REQ.output)}"}`,
  ], { stdio: "pipe" });
  const finalSaved = readFileSync(resolve(WORK, REQ.output));
  ok("rebind: final deliverable is a zip", finalSaved.subarray(0, 2).toString() === "PK");

  writeFileSync(resolve(OUTPUT, "annual-report-2022.idml"), readFileSync(resolve(WORK, REQ.template)));
  writeFileSync(resolve(OUTPUT, "annual-report-2026.designcraft"), readFileSync(resolve(WORK, REQ.output)));
  writeFileSync(resolve(OUTPUT, "rebind-report.json"), readFileSync(resolve(WORK, "rebind-report.json")));
  writeFileSync(resolve(OUTPUT, "font-substitutions.json"), JSON.stringify(report.fontSubstitutions, null, 2));
  writeFileSync(resolve(OUTPUT, "grid-port.json"), JSON.stringify(report.gridPort, null, 2));
  for (const artefact of ["annual-report-2022.idml", "annual-report-2026.designcraft",
    "rebind-report.json", "font-substitutions.json", "grid-port.json"]) {
    ok(`output: ${artefact}`, existsSync(resolve(OUTPUT, artefact)));
  }
  assert.equal(report.storiesRewired.length, 8);

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 5,
    engine: "DesignCraft IDML rebind (scripted engine, real IDML zip)",
    assertions: passed + 1,
    stories: report.storiesRewired.length,
    orphansRemoved: report.orphanFramesRemoved,
    fontSubstitutions: report.fontSubstitutions.length,
    grid: report.gridPort,
    artefacts: ["annual-report-2022.idml", "annual-report-2026.designcraft",
      "rebind-report.json", "font-substitutions.json", "grid-port.json"],
    result: "three legacy styles mapped, eight stories rewired, one orphan removed and the grid ported 792→850 pt",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
