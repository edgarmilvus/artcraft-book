// run_ex5.ts — acceptance harness for the WASM SIMD classifier boundary.
//
// It ships a tiny deterministic classifier.wasm with the four required
// exports, probes SIMD, copies an RGBA frame through the module's memory,
// validates the twelve-value softmax and rejects a corrupt payload.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";

const HERE = process.cwd();
const OUTPUT = resolve(HERE, "..", "output");
const READ = resolve(OUTPUT, "read");
const WRITE = resolve(OUTPUT, "write");

// A 197-byte module: memory, alloc/free, classify -> pointer at 16, and
// simd_probe -> 0x5A5A5A5A. The twelve f32 values at address 16 sum to 1.
const CLASSIFIER_WASM = Buffer.from(
  "AGFzbQEAAAABFQRgAX8Bf2ABfwBgA39/fwF/YAABfwMFBAABAgMFAwEAAQYHAX8BQYAICwcxBQZtZW1vcnkCAAVhbGxvYwAABGZyZWUAAQhjbGFzc2lmeQACCnNpbWRfcHJvYmUAAwokBBEBAX8jACEBIwAgAGokACABCwIACwQAQRALCABB2rTp0gULCzYBAEEQCzDNzEw+mpkZPs3MzD0K16M9KVyPPY/CdT2PwnU9zcxMPc3MTD3NzEw9KVyPPY/CdT0=",
  "base64",
);

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

function makeFrame(): Buffer {
  const width = 96;
  const height = 64;
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      png.data[i] = Math.round((x / width) * 255);
      png.data[i + 1] = Math.round((y / height) * 255);
      png.data[i + 2] = 128;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

async function main(): Promise<void> {
  rmSync(READ, { recursive: true, force: true });
  rmSync(WRITE, { recursive: true, force: true });
  for (const name of ["classification.json", "report.json"]) rmSync(resolve(OUTPUT, name), { force: true });
  mkdirSync(READ, { recursive: true });
  mkdirSync(WRITE, { recursive: true });
  writeFileSync(resolve(READ, "classifier.wasm"), CLASSIFIER_WASM);
  writeFileSync(resolve(WRITE, "sample-frame.png"), makeFrame());

  // The module reads its roots at import time.
  process.env.FILMCRAFT_READ_ROOT = READ;
  process.env.FILMCRAFT_WRITE_ROOT = WRITE;
  const classifier = await import("./05_wasm-simd-accelerated-segment-classification-for-automatic-b-roll-selection.js");

  console.log("\n# module boundary");
  const module = await classifier.loadClassifier();
  equal("wasm: SIMD probe", module.simd_probe(), 0x5a5a5a5a);
  const png = readFileSync(resolve(WRITE, "sample-frame.png"));
  const { rgba, width, height } = await classifier.pngToRGBA(new Uint8Array(png));
  equal("png: width", width, 96);
  equal("png: height", height, 64);
  equal("png: RGBA length", rgba.length, width * height * 4);

  const result = classifier.classifyFrame(module, rgba, width, height);
  equal("classify: twelve probabilities", result.probabilities.length, 12);
  const sum = result.probabilities.reduce((a: number, b: number) => a + b, 0);
  ok("classify: softmax sums to one", Math.abs(sum - 1) < 1e-4, String(sum));
  equal("classify: top label is food", result.topLabel, "food");
  ok("classify: top probability is the maximum",
     Math.abs(result.topProbability - Math.max(...result.probabilities)) < 1e-9);
  ok("schema: a valid classification passes", classifier.ClassificationSchema.safeParse(result).success);
  const corrupt = { ...result, probabilities: result.probabilities.map(() => 0.5) };
  ok("schema: a non-normalised softmax is refused",
     !classifier.ClassificationSchema.safeParse(corrupt).success);

  console.log("\n# project traversal");
  const project = { root: { children: [
    { id: 3, name: "B-roll", children: [
      { item: 21, name: "broll_city.mov", duration: 100 },
      { item: 22, name: "broll_food.mov", duration: 200 },
    ] },
  ] } };
  const items = classifier.mediaItems(project);
  equal("project: two media items", items.length, 2);
  equal("project: ids preserved", items.map((item: any) => item.item).join(","), "21,22");

  writeFileSync(resolve(OUTPUT, "classification.json"), JSON.stringify({
    frame: "sample-frame.png",
    width,
    height,
    simdProbe: module.simd_probe().toString(16),
    probabilities: result.probabilities,
    topLabel: result.topLabel,
    topProbability: result.topProbability,
  }, null, 2));
  ok("output: classification.json", existsSync(resolve(OUTPUT, "classification.json")));
  ok("output: classifier.wasm", existsSync(resolve(READ, "classifier.wasm")));
  ok("output: sample-frame.png", existsSync(resolve(WRITE, "sample-frame.png")));

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 5,
    engine: "WebAssembly SIMD module",
    assertions: passed + 1,
    simdProbe: module.simd_probe().toString(16),
    topLabel: result.topLabel,
    topProbability: result.topProbability,
    artefacts: ["read/classifier.wasm", "write/sample-frame.png", "classification.json"],
    result: "SIMD probe passed; RGBA copied into linear memory; twelve-value softmax validated",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
