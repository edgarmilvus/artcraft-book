// run_basic.ts — deterministic harness for the e-commerce banner factory.
//
// The factory is driven against the real headless PhotoCraft: one product is
// rendered, the batch loop is run over a feed that contains a bad record, and
// the pixels of the finished banner are checked.

import { strict as assert } from "node:assert";
import { writeFileSync } from "node:fs";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import { formatPrice, renderBanner } from "./01_banner-factory.js";
import { renderBatch } from "./02_common_pitfalls.js";

const OUTPUT = resolve(process.cwd(), "output");
const SAMPLES = resolve(OUTPUT, "samples");
const BANNERS = resolve(OUTPUT, "banners");

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

const PRODUCT = {
  name: "Aurora Mechanical Keyboard",
  priceMinorUnits: 12900,
  currency: "USD",
  imagePath: "aurora-keyboard.png",
  badge: "NEW",
  background: "#0b1020",
  foreground: "#f5f7ff",
};

/** A copy of the sample, so the fixture never depends on the repo. */
function writeSample(): void {
  const size = 600;
  const png = new PNG({ width: size, height: size });
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const i = (y * size + x) * 4;
      png.data[i] = 30 + Math.floor(80 * Math.sin(x / 40) * Math.cos(y / 50));
      png.data[i + 1] = 60 + Math.floor(60 * Math.sin((x + y) / 70));
      png.data[i + 2] = 120 + Math.floor(100 * Math.cos(x / 33));
      png.data[i + 3] = 255;
    }
  }
  writeFileSync(resolve(SAMPLES, "aurora-keyboard.png"), PNG.sync.write(png));
}

async function main(): Promise<void> {
  rmSync(OUTPUT, { recursive: true, force: true });
  mkdirSync(SAMPLES, { recursive: true });
  mkdirSync(BANNERS, { recursive: true });
  writeSample();

  console.log("\n# the formatters");
  equal("price: dollars", formatPrice(12900, "USD"), "$129.00");
  equal("price: euros", formatPrice(12900, "EUR"), "€129.00");
  equal("price: yen has no decimals", formatPrice(12900, "JPY"), "¥12,900");

  console.log("\n# one banner");
  const path = await renderBanner(PRODUCT, BANNERS, SAMPLES);
  ok("banner: the file exists", existsSync(path));
  const png = PNG.sync.read(readFileSync(path));
  equal("banner: the canvas is 1200 wide", png.width, 1200);
  equal("banner: the canvas is 628 tall", png.height, 628);

  const at = (x: number, y: number) => {
    const i = (y * png.width + x) * 4;
    return [png.data[i], png.data[i + 1], png.data[i + 2]];
  };
  const background = at(20, 300);
  ok(
    "banner: the background is the product's colour",
    Math.abs(background[0] - 0x0b) < 6 && Math.abs(background[1] - 0x10) < 6 && Math.abs(background[2] - 0x20) < 6,
    JSON.stringify(background),
  );
  const hero = at(900, 300);
  ok(
    "banner: the hero image is on the right",
    Math.abs(hero[0] - background[0]) > 20 || Math.abs(hero[2] - background[2]) > 20,
    JSON.stringify(hero),
  );
  // The name is drawn in the foreground colour: the left half carries some
  // pixels close to #f5f7ff.
  let brightest = 0;
  for (let y = 100; y < 300; y += 1) {
    for (let x = 60; x < 600; x += 1) {
      const i = (y * png.width + x) * 4;
      brightest = Math.max(brightest, png.data[i]);
    }
  }
  ok("banner: the name is drawn in the foreground colour", brightest > 200, `${brightest}`);

  console.log("\n# the batch");
  const results = await renderBatch(
    [
      { ...PRODUCT, name: "Second Product", imagePath: "aurora-keyboard.png" },
      { ...PRODUCT, name: "Broken", priceMinorUnits: -1 },
      { ...PRODUCT, name: "Third Product", imagePath: "aurora-keyboard.png" },
    ],
    BANNERS,
    SAMPLES,
  );
  equal("batch: three records", results.length, 3);
  ok("batch: the first rendered", results[0].path !== null);
  ok("batch: the broken one failed", results[1].path === null && results[1].error !== null);
  ok("batch: the third still rendered", results[2].path !== null);
  ok("batch: the failures are recorded", results[1].error!.includes("price") || results[1].error!.length > 0);
  ok("batch: every render is a file", results.filter((r) => r.path).every((r) => existsSync(r.path!)));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
