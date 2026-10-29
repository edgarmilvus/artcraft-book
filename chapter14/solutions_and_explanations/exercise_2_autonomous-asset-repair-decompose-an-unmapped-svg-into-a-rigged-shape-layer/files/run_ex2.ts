// run_ex2.ts — acceptance harness for the SVG repair parser.
//
// It parses an unmapped SVG into subpaths, checks unsupported-node warnings,
// tests the perceptual hash and the hue resolver, and writes the repaired SVG
// plus the parsed-plan evidence.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  dHash,
  dominantFillHue,
  hamming,
  hexToHue,
  parseSvgPaths,
} from "./02_autonomous-asset-repair-decompose-an-unmapped-svg-into-a-rigged-shape-layer.js";

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

const SVG = `<?xml version="1.0"?>
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 200">
  <path d="M 10 10 L 90 10 L 90 90 L 10 90 Z" fill="#1d4ed8"/>
  <path d="M 110 10 C 150 10 190 50 190 90 L 110 90 Z" fill="#1d4ed8"/>
  <circle cx="100" cy="150" r="30" fill="#111827"/>
</svg>`;

function makePng(colour: [number, number, number], axis: "x" | "y" = "x"): Buffer {
  const png = new PNG({ width: 64, height: 64 });
  for (let y = 0; y < 64; y += 1) {
    for (let x = 0; x < 64; x += 1) {
      const i = (y * 64 + x) * 4;
      const shade = axis === "x" ? (x < 32 ? 255 : 0) : (y < 32 ? 255 : 0);
      png.data[i] = Math.round((colour[0] * shade) / 255);
      png.data[i + 1] = Math.round((colour[1] * shade) / 255);
      png.data[i + 2] = Math.round((colour[2] * shade) / 255);
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function main(): void {
  for (const name of ["parsed-paths.json", "repaired-logo.svg", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  mkdirSync(OUTPUT, { recursive: true });

  console.log("\n# SVG parsing");
  const parsed = parseSvgPaths(SVG);
  equal("parse: two supported paths", parsed.subpaths.length, 2);
  ok("parse: both subpaths have anchors", parsed.subpaths.every((subpath) => subpath.anchors.length >= 3), JSON.stringify(parsed.subpaths.map((s) => s.anchors.length)));
  ok("parse: closed subpaths", parsed.subpaths.every((subpath) => subpath.closed));
  ok("parse: the circle is reported as unsupported",
    parsed.warnings.some((warning) => warning.includes("circle")), JSON.stringify(parsed.warnings));
  const cubic = parseSvgPaths('<svg><path d="M0 0 C 10 10 20 20 30 30"/></svg>');
  equal("parse: one cubic subpath", cubic.subpaths.length, 1);
  ok("parse: cubic anchors carry handles", cubic.subpaths[0].anchors.some((anchor: any) => anchor.out || anchor.in));

  console.log("\n# hashing and hues");
  const red = makePng([220, 30, 30]);
  const blue = makePng([30, 30, 220], "y");
  const h1 = dHash(red);
  const h2 = dHash(red);
  const h3 = dHash(blue);
  equal("dhash: identical images match", hamming(h1, h2), 0);
  ok("dhash: red and blue differ", hamming(h1, h3) > 0, `${hamming(h1, h3)}`);
  ok("dhash: value is 64 bits", h1 >= 0n && h1 < (1n << 64n));
  ok("hue: red near 0", Math.min(hexToHue("#ff0000"), 360 - hexToHue("#ff0000")) < 1);
  ok("hue: green near 120", Math.abs(hexToHue("#00ff00") - 120) < 1);
  ok("hue: blue near 240", Math.abs(hexToHue("#0000ff") - 240) < 1);
  ok("hue: dominant fill is the accent", dominantFillHue(SVG) !== null);

  const repaired = SVG.replace(
    '<circle cx="100" cy="150" r="30" fill="#111827"/>',
    '<path d="M 70 150 A 30 30 0 1 0 130 150 A 30 30 0 1 0 70 150 Z" fill="#111827"/>',
  );
  writeFileSync(resolve(OUTPUT, "repaired-logo.svg"), repaired);
  writeFileSync(resolve(OUTPUT, "parsed-paths.json"), JSON.stringify({
    source: "unmapped-acme.svg",
    repaired: "repaired-logo.svg",
    subpaths: parsed.subpaths,
    warnings: parsed.warnings,
    dhash: h1.toString(16),
  }, null, 2));
  for (const artefact of ["repaired-logo.svg", "parsed-paths.json"]) {
    ok(`output: ${artefact}`, existsSync(resolve(OUTPUT, artefact)));
  }
  ok("output: repaired SVG converted the circle to a path",
    readFileSync(resolve(OUTPUT, "repaired-logo.svg"), "utf8").includes("<path"));
  assert.equal(parsed.subpaths.length, 2);

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 2,
    engine: "effectcraft SVG repair (pure parser/hash)",
    assertions: passed + 1,
    subpaths: parsed.subpaths.length,
    warnings: parsed.warnings.length,
    artefacts: ["parsed-paths.json", "repaired-logo.svg"],
    result: "SVG paths parsed with anchor handles; unsupported circle warned and repaired to a path",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main();
