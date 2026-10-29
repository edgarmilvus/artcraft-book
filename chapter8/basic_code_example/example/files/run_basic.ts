// run_basic.ts — deterministic harness for the VectorCraft "hello" example.
//
// The example builds a brand mark out of two cubic Bézier paths, a live
// blend between them, and a Pathfinder-united badge. The harness checks the
// artifacts, not the prose: the SVG has to contain the interpolated blend
// steps and the united plate, the preview has to be a real raster, and a
// second run has to produce the same geometry byte for byte.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import { generateBrandMark } from "./01_hello-bezier-blend-pathfinder.js";

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
  rmSync(OUTPUT, { recursive: true, force: true });
  mkdirSync(OUTPUT, { recursive: true });
  // The engine writes its exports into the automation root, which is the
  // working directory, so the run happens inside output/.
  process.chdir(OUTPUT);

  console.log("\n# first run");
  const first = await generateBrandMark({ brandName: "acme", size: 512, accent: "#0ea5e9" });

  console.log("\n# identities");
  const ids = first.ids;
  ok("ids: the two key paths are distinct", ids.bezierA !== ids.bezierB);
  ok("ids: the blend is its own object", ids.blend !== ids.bezierA && ids.blend !== ids.bezierB);
  ok(
    "ids: the united badge is a new object",
    ids.unitedBadge !== ids.bezierA && ids.unitedBadge !== ids.bezierB && ids.unitedBadge !== ids.blend,
    JSON.stringify(ids),
  );
  ok("ids: every id is a positive integer", Object.values(ids).every((id) => Number.isInteger(id) && id > 0));

  console.log("\n# the svg");
  const svg = first.svg;
  ok("svg: it comes back as text", svg.startsWith("<?xml"), svg.slice(0, 40));
  ok("svg: the canvas is 512 pt", svg.includes('width="512"') && svg.includes('height="512"'));
  const paths = svg.match(/<path\b/g) ?? [];
  // Nine interpolated steps, the two key paths, and the united badge.
  equal("svg: nine blend steps, two keys and the badge", paths.length, 12);
  const stroked = svg.match(/stroke="#0ea5e9"/g) ?? [];
  equal("svg: eleven blend paths are stroked", stroked.length, 11);
  ok("svg: the curves carry the accent stroke", svg.includes('stroke="#0ea5e9"'));
  ok("svg: the badge is filled with the accent", svg.includes('fill="#0ea5e9"'));
  ok("svg: the badge is a rounded plate", /M1?76 208 C/.test(svg), svg.slice(0, 200));

  console.log("\n# the preview raster");
  const png = PNG.sync.read(Buffer.from(first.previewPngBase64, "base64"));
  equal("preview: 512 px wide", png.width, 512);
  equal("preview: 512 px tall", png.height, 512);
  let inked = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    if (png.data[i] < 240 || png.data[i + 1] < 240 || png.data[i + 2] < 240) inked += 1;
  }
  ok("preview: the mark actually drew something", inked > 2000, `${inked} inked pixels`);

  console.log("\n# the document tree");
  const tree = JSON.stringify(first.documentTree);
  ok("tree: the blend is named", tree.includes("aura") || tree.includes("Blend"), tree.slice(0, 200));

  console.log("\n# determinism");
  const second = await generateBrandMark({ brandName: "acme", size: 512, accent: "#0ea5e9" });
  equal("determinism: the same svg comes out", second.svg, svg);
  ok("determinism: the exports are on disk", existsSync(resolve(OUTPUT, "acme-Mark.svg")));
  ok("determinism: the native document is on disk", existsSync(resolve(OUTPUT, "acme-Mark.vectorcraft")));

  const written = readFileSync(resolve(OUTPUT, "acme-Mark.svg"), "utf8");
  equal("determinism: the file matches the returned svg", written, svg);
  assert.ok(written.length > 1000);

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
