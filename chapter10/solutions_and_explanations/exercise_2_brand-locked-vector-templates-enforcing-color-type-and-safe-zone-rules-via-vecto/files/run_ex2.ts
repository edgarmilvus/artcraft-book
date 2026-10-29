// run_ex2.ts — acceptance harness for the brand-locked vector templates.
//
// It exercises the rule engine both as a dry-run and against a real
// VectorCraft session, then verifies the four exported artifacts.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { PNG } from "pngjs";
import {
  BrandRules,
  VectorCraftMcp,
  buildComposition,
  contrastRatio,
  processRow,
  type BrandKit,
  type CanonicalRow,
} from "./02_brand-locked-vector-templates-enforcing-color-type-and-safe-zone-rules-via-vectorcraft-mcp.js";

const HERE = process.cwd();
const OUTPUT = resolve(HERE, "..", "output");
const READ = resolve(OUTPUT, "read");
const WRITE = resolve(OUTPUT, "write");

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

const KIT: BrandKit = {
  version: "2026.1",
  swatches: [
    { name: "Brand Background", hex: "#f4f1ea", role: "background" },
    { name: "Brand Blue 500", hex: "#1d4ed8", role: "accent" },
    { name: "Brand Text", hex: "#111827", role: "text" },
    { name: "Brand Accent", hex: "#9a3412", role: "accent" },
    { name: "Brand White", hex: "#ffffff", role: "text" },
  ],
  fonts: ["Inter-Black", "Inter-Bold", "Inter-SemiBold"],
  safeZonePct: 0.04,
  minContrastRatio: 4.5,
  logoClearspacePt: 24,
  logoSvgPath: "logo.svg",
  allowedAspects: [[4, 5]],
};

function makeHero(): Buffer {
  const png = new PNG({ width: 1600, height: 1600 });
  for (let y = 0; y < 1600; y += 1) {
    for (let x = 0; x < 1600; x += 1) {
      const i = (y * 1600 + x) * 4;
      const glow = 1 - Math.hypot(x - 800, y - 800) / 1600;
      png.data[i] = Math.round(40 + glow * 120);
      png.data[i + 1] = Math.round(90 + glow * 90);
      png.data[i + 2] = Math.round(150 + glow * 60);
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function unitRules(): void {
  console.log("\n# rule engine");
  ok("contrast: black on white is high", contrastRatio("#000000", "#ffffff") > 20);
  ok("contrast: two identical colours are one", Math.abs(contrastRatio("#777777", "#777777") - 1) < 1e-9);

  const rules = new BrandRules(KIT);
  equal("swatch: role resolves to the token", rules.swatch("Brand Blue 500"), "#1d4ed8");
  let badColor = false;
  try { rules.swatch("Off Brand Red"); } catch (error: any) { badColor = error.rule === "brand-color"; }
  ok("swatch: an unknown token is refused", badColor);

  let badFont = false;
  try { rules.checkFont("Comic Sans"); } catch (error: any) { badFont = error.rule === "brand-font"; }
  ok("font: an unlisted family is refused", badFont);

  let safe = false;
  try { rules.checkSafeZone({ x: 0, y: 0, width: 100, height: 100 }, { width: 1000, height: 1000 }); }
  catch (error: any) { safe = error.rule === "safe-zone"; }
  ok("safe zone: a corner element is refused", safe);
}

async function main(): Promise<void> {
  rmSync(READ, { recursive: true, force: true });
  rmSync(WRITE, { recursive: true, force: true });
  rmSync(resolve(OUTPUT, "report.json"), { force: true });
  mkdirSync(READ, { recursive: true });
  mkdirSync(WRITE, { recursive: true });
  writeFileSync(resolve(READ, "hero.png"), makeHero());
  writeFileSync(resolve(READ, "logo.svg"),
    '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="100" viewBox="0 0 160 100"><circle cx="80" cy="50" r="42" fill="#1d4ed8"/></svg>');

  unitRules();
  const rules = new BrandRules(KIT);
  const row: CanonicalRow = {
    sku: "LOCKED-1",
    title: "Trail Runner",
    price: "$129.99",
    heroPath: "hero.png",
  };

  console.log("\n# the composition");
  const steps = buildComposition(row, rules, KIT);
  ok("composition: every step is a tool we can call",
    steps.every((step) => ["draw_shape", "draw_path", "add_text"].includes(step.id)),
    JSON.stringify([...new Set(steps.map((step) => step.id))]));
  ok("composition: the hero plate comes before the text",
    steps.findIndex((step) => (step.params as any).width === 1600) <
    steps.findIndex((step) => (step.params as any).text === "TRAIL RUNNER"));
  ok("composition: one CTA path", steps.filter((step) => step.id === "draw_path").length === 1);

  const dry = await processRow(
    { sku: "BAD-FONT", title: "x", price: "$1", heroPath: "hero.png" },
    new BrandRules({ ...KIT, fonts: ["Other"] }), { ...KIT, fonts: ["Other"] }, null, WRITE);
  equal("dry run: unlisted font is rejected", dry.rejected?.rule, "brand-font");

  const missing = await processRow({ sku: "", title: "", price: "", heroPath: "" }, rules, KIT, null, WRITE);
  equal("dry run: missing fields are rejected", missing.rejected?.rule, "missing-field");

  console.log("\n# the live export");
  const vc = new VectorCraftMcp();
  await vc.start(READ, WRITE);
  try {
    const result = await processRow(row, rules, KIT, vc, WRITE);
    equal("row: accepted", result.accepted, true);
    equal("row: four artifacts", result.artifacts?.length, 4);
    const expected = ["vectorcraft", "pdf", "svg", "png"];
    equal("row: artifact formats", result.artifacts?.map((art) => art.format).join(","), expected.join(","));
    for (const artifact of result.artifacts!) {
      const abs = isAbsolute(artifact.path) ? artifact.path : resolve(WRITE, artifact.path);
      ok(`artifact: ${artifact.format} exists`, existsSync(abs) && readFileSync(abs).byteLength > 200);
      equal(`artifact: ${artifact.format} byte count`, artifact.bytes, readFileSync(abs).byteLength);
    }
    ok("artifact: the SVG keeps live text",
      readFileSync(resolve(WRITE, "LOCKED-1.svg"), "utf8").includes("<text"));
    ok("artifact: the PNG is a real raster",
      readFileSync(resolve(WRITE, "LOCKED-1@2x.png")).subarray(0, 8).equals(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));

    const report = {
      kitVersion: KIT.version,
      results: [result],
    };
    writeFileSync(resolve(WRITE, "brand-template-audit.json"), JSON.stringify(report, null, 2));
    ok("audit: brand-template-audit.json", existsSync(resolve(WRITE, "brand-template-audit.json")));
  } finally {
    await vc.close();
  }

  const artefacts = [
    "read/hero.png", "read/logo.svg",
    "write/LOCKED-1.vectorcraft", "write/LOCKED-1.pdf", "write/LOCKED-1.svg",
    "write/LOCKED-1@2x.png", "write/brand-template-audit.json",
  ];
  for (const artefact of artefacts) ok(`output: ${artefact}`, existsSync(resolve(OUTPUT, artefact)));
  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 2,
    engine: "vectorcraft-cli",
    assertions: passed + 1,
    kitVersion: KIT.version,
    accepted: true,
    artifacts: artefacts,
    artefacts,
    result: "brand tokens, contrast, safe zone and tool-order composition passed; four artifacts exported",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
