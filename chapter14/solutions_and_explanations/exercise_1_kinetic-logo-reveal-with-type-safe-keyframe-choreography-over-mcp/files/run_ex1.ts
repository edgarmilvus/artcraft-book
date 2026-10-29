// run_ex1.ts — acceptance harness for the franchise rig batch.
//
// It checks the five-step rig plan, the font/TOFU gate and the write-root
// guard, then writes the plan, a preview frame and a summary report.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  buildRigSteps,
  tofuRisk,
  underRoot,
  type FontFamily,
  type FranchiseSpec,
} from "./01_franchise-batch.js";

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

const SPEC: FranchiseSpec = {
  slug: "northic",
  displayName: "NORTHIC",
  tagline: "tools for the long run",
  locale: "en-US",
  accent: "#1d4ed8",
  wordmarkFont: "Inter",
};

function preview(): Buffer {
  const png = new PNG({ width: 1920, height: 1080 });
  png.data.fill(20);
  for (let y = 0; y < 1080; y += 1) {
    for (let x = 0; x < 1920; x += 1) {
      const i = (y * 1920 + x) * 4;
      const inBar = y > 600 && y < 624 && x > 320 && x < 1600;
      const inWord = y > 340 && y < 470 && x > 500 && x < 1420;
      png.data[i] = inBar ? 29 : inWord ? 245 : 20;
      png.data[i + 1] = inBar ? 78 : inWord ? 245 : 24;
      png.data[i + 2] = inBar ? 216 : inWord ? 240 : 32;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function main(): void {
  for (const name of ["rig-steps.json", "preview.png", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  mkdirSync(OUTPUT, { recursive: true });

  console.log("\n# rig plan");
  const steps = buildRigSteps("Logo-northic", SPEC, 960, 540);
  equal("plan: five primitives", steps.length, 5);
  equal("plan: null first", steps[0]!.command, "layer.newNull");
  equal("plan: rename to the rig", (steps[1]!.params as any).name, "Null – Rig");
  equal("plan: accent bar command", steps[2]!.command, "layer.newShape");
  equal("plan: accent fill", (steps[2]!.params as any).fill, "#1d4ed8");
  equal("plan: wordmark", (steps[3]!.params as any).text, "NORTHIC");
  equal("plan: tagline", (steps[4]!.params as any).text, "tools for the long run");
  ok("plan: wordmark above the tagline", (steps[3]!.params as any).position[1] < (steps[4]!.params as any).position[1]);
  ok("plan: every step is atomic input", steps.every((step) => typeof step.command === "string" && step.params && typeof step.params === "object"));

  console.log("\n# font and path guards");
  const bundled: FontFamily = { family: "Inter", origin: "bundled", styles: ["Regular"] };
  const native: FontFamily = { family: "Noto Sans JP", origin: "bundled", nativeName: "ja-JP", styles: ["Regular"] };
  ok("font: combining mark with no locale coverage warns",
    (tofuRisk("Cafe\u0301", bundled, "fr-FR") ?? "").includes("possible-glyph-fallback"));
  equal("font: a native family has no warning", tofuRisk("Cafe\u0301", native, "ja-JP"), null);
  ok("path: a child stays inside", underRoot("/tmp/root", "slug/file.png").startsWith("/tmp/root"));
  let escaped = false;
  try { underRoot("/tmp/root", "../escape.png"); } catch { escaped = true; }
  ok("path: an escape is refused", escaped);

  writeFileSync(resolve(OUTPUT, "rig-steps.json"), JSON.stringify({ slug: SPEC.slug, steps }, null, 2));
  writeFileSync(resolve(OUTPUT, "preview.png"), preview());
  for (const artefact of ["rig-steps.json", "preview.png"]) {
    ok(`output: ${artefact}`, existsSync(resolve(OUTPUT, artefact)));
  }
  const decoded = PNG.sync.read(readFileSync(resolve(OUTPUT, "preview.png")));
  equal("output: preview width", decoded.width, 1920);
  equal("output: preview height", decoded.height, 1080);
  assert.equal(steps.length, 5);

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 1,
    engine: "effectcraft rig plan (pure)",
    assertions: passed + 1,
    slug: SPEC.slug,
    steps: steps.map((step) => step.command),
    artefacts: ["rig-steps.json", "preview.png"],
    result: "five-step franchise rig, font fallback and write-root guard verified",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main();
