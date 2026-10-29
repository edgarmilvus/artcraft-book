// run_basic.ts — deterministic harness for the Hello Rig example.
//
// The rig is built inside a real headless EffectCraft: one atomic batch
// creates the composition, the null controller, the star badge and the
// title, and the preview frame is rendered from the same process.

import { strict as assert } from "node:assert";
import { writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { buildHelloRig } from "./01_effectcraft-hello-rig.js";

const OUTPUT = resolve(process.cwd(), "output");

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
  mkdirSync(OUTPUT, { recursive: true });

  console.log("\n# the rig");
  const rig = await buildHelloRig({
    accent: "#f59e0b",
    title: "Hello, Motion",
    frameTime: 0.75,
    maxSide: 480,
  });

  console.log("\n# the composition");
  equal("comp: it has an id", typeof rig.comp.id, "number");
  equal("comp: it is named", rig.comp.name, "Hello Rig");
  equal("comp: it is 1920 wide", rig.comp.width, 1920);
  equal("comp: it is 1080 tall", rig.comp.height, 1080);
  equal("comp: it runs at 30 fps", rig.comp.frameRate, 30);
  equal("comp: it is three seconds long", rig.comp.duration, 3);

  console.log("\n# the layers");
  ok("ctrl: it has an id", typeof rig.ctrlLayer.layer === "number", `${rig.ctrlLayer.layer}`);
  ok("badge: it has an id", typeof rig.badgeLayer.layer === "number", `${rig.badgeLayer.layer}`);
  ok("title: it has an id", typeof rig.titleLayer.layer === "number", `${rig.titleLayer.layer}`);
  ok(
    "layers: they are three different layers",
    new Set([rig.ctrlLayer.layer, rig.badgeLayer.layer, rig.titleLayer.layer]).size === 3,
  );

  console.log("\n# the preview");
  ok("preview: it is a PNG", rig.previewPngBase64.length > 1000, `${rig.previewPngBase64.length} chars`);
  const png = Buffer.from(rig.previewPngBase64, "base64");
  ok("preview: it has the PNG signature", png.subarray(0, 8).toString("hex") === "89504e470d0a1a0a");
  const previewPath = resolve(OUTPUT, "hello-rig-preview.png");
  writeFileSync(previewPath, png);
  ok("preview: it was written", png.length > 1000, `${png.length} bytes`);

  assert.ok(rig.comp.id > 0);
  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
