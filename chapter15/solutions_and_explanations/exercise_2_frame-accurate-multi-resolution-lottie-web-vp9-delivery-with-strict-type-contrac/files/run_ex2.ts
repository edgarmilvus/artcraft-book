// run_ex2.ts — acceptance harness for the multi-resolution Lottie delivery.
//
// It renders one Lottie at three sizes in headless Chromium, encodes each
// sequence to VP9, decodes it back and runs the real ParityAuditor over the
// browser frames and the encoded frames.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  ParityAuditor,
  XorShift32,
  encodeVp9Sequence,
  hammingDistance,
  hasExpressions,
  makeUmd,
  rasteriseLottie,
  type LottieJson,
  type NativeBundle,
  type WebBundle,
} from "./02_frame-accurate-multi-resolution-lottie-web-vp9-delivery-with-strict-type-contracts.js";

const HERE = process.cwd();
const OUTPUT = resolve(HERE, "..", "output");
const FRAMES = 6;

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

const LOTTIE: LottieJson = JSON.parse(
  readFileSync(resolve(HERE, "lottie-fixture.json"), "utf8"),
) as LottieJson;

interface Resolution { width: number; height: number }

const RESOLUTIONS: Resolution[] = [
  { width: 485, height: 125 },
  { width: 970, height: 250 },
  { width: 1940, height: 500 },
];

function pngSize(path: string): string {
  const png = PNG.sync.read(readFileSync(path));
  return `${png.width}x${png.height}`;
}

async function main(): Promise<void> {
  for (const name of ["lottie.json", "parity-all.json", "multi-resolution.json", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  for (const dir of ["web-485x125", "web-970x250", "web-1940x500",
    "native-485x125", "native-970x250", "native-1940x500"]) {
    rmSync(resolve(OUTPUT, dir), { recursive: true, force: true });
  }
  mkdirSync(OUTPUT, { recursive: true });
  writeFileSync(resolve(OUTPUT, "lottie.json"), JSON.stringify(LOTTIE, null, 2));

  console.log("\n# type contracts");
  equal("lottie: frame span is six", Math.round(LOTTIE.op - LOTTIE.ip), FRAMES);
  ok("expressions: clean source", !hasExpressions(LOTTIE));
  const expressed = structuredClone(LOTTIE) as unknown as {
    layers: Array<{ ks: { p: { x?: string } } }>;
  };
  expressed.layers[0]!.ks.p.x = "wiggle(2,10)";
  ok("expressions: live expression detected", hasExpressions(expressed as unknown as LottieJson));
  const umd = makeUmd("/tmp/hero.json", false);
  ok("umd: references the basename", umd.includes("hero.json") && !umd.includes("/tmp/"));
  ok("umd: minify strips the banner", !makeUmd("/tmp/hero.json", true).includes("generated"));
  equal("hash: identical digests", hammingDistance("00000000000000ff", "00000000000000ff"), 0);
  equal("hash: one bit differs", hammingDistance("00000000000000ff", "00000000000000fe"), 1);

  console.log("\n# deterministic sampling");
  const a = new ParityAuditor().sampleFrames(12, 42);
  const b = new ParityAuditor().sampleFrames(12, 42);
  const c = new ParityAuditor().sampleFrames(12, 43);
  equal("samples: same seed, same order", JSON.stringify(a), JSON.stringify(b));
  ok("samples: a different seed differs", JSON.stringify(a) !== JSON.stringify(c));
  equal("samples: unique values", new Set(a).size, 12);
  const rng = new XorShift32(7);
  const draws = [rng.uniformInt(6), rng.uniformInt(6), rng.uniformInt(6)];
  ok("rng: draws stay in range", draws.every((n) => n >= 0 && n < 6), JSON.stringify(draws));

  console.log("\n# render, encode, audit");
  const auditor = new ParityAuditor();
  const results: Array<Record<string, unknown>> = [];
  for (const resolution of RESOLUTIONS) {
    const label = `${resolution.width}x${resolution.height}`;
    const webDir = resolve(OUTPUT, `web-${label}`);
    const nativeDir = resolve(OUTPUT, `native-${label}`);
    mkdirSync(webDir, { recursive: true });
    mkdirSync(nativeDir, { recursive: true });
    writeFileSync(resolve(webDir, "hero.json"), JSON.stringify(LOTTIE, null, 2));

    const webFrames = await rasteriseLottie(
      LOTTIE, resolve(webDir, "frames"), resolution.width, resolution.height,
    );
    equal(`web ${label}: frame count`, webFrames.length, FRAMES);
    equal(`web ${label}: first frame size`, pngSize(webFrames[0]!), `${resolution.width}x${resolution.height}`);
    equal(`web ${label}: last frame size`, pngSize(webFrames[FRAMES - 1]!), `${resolution.width}x${resolution.height}`);

    const nativeFrames = await rasteriseLottie(
      LOTTIE, resolve(nativeDir, "png"), resolution.width, resolution.height,
    );
    equal(`native ${label}: source frames`, nativeFrames.length, FRAMES);
    const webmPath = resolve(nativeDir, "hero.webm");
    await encodeVp9Sequence({
      pngDir: resolve(nativeDir, "png"),
      webmPath,
      decodedDir: resolve(nativeDir, "decoded"),
      frameCount: FRAMES,
      targetFps: 30,
      crf: 30,
      alphaMode: "straight",
    });
    ok(`native ${label}: webm exists`, existsSync(webmPath) && readFileSync(webmPath).length > 500);
    const decoded = resolve(nativeDir, "decoded", "f_00000.png");
    ok(`native ${label}: decoded frame exists`, existsSync(decoded));
    equal(`native ${label}: decoded size`, pngSize(decoded), `${resolution.width}x${resolution.height}`);

    const web: WebBundle = {
      jsonPath: resolve(webDir, "hero.json"),
      jsPath: resolve(webDir, "hero.js"),
      frameCount: FRAMES,
      fr: LOTTIE.fr,
    };
    const native: NativeBundle = { webmPath, frameCount: FRAMES, sourcePngs: nativeFrames };
    const report = await auditor.assertParity(web, native, [0, 1, 2, 3, 4, 5]);
    equal(`parity ${label}: six samples`, report.samples.length, 6);
    ok(`parity ${label}: max delta <= 3 (got ${report.maxDelta})`, report.maxDelta <= 3);
    ok(`parity ${label}: pass`, report.pass);
    ok(`parity ${label}: histogram accounts for every sample`,
      Object.values(report.histogram).reduce((sum, n) => sum + n, 0) === 6);
    results.push({
      resolution: label,
      frames: webFrames.length,
      encodedFrames: FRAMES,
      maxDelta: report.maxDelta,
      pass: report.pass,
      histogram: report.histogram,
      webmBytes: readFileSync(webmPath).length,
    });
  }

  assert.equal(results.length, 3);
  writeFileSync(resolve(OUTPUT, "parity-all.json"), JSON.stringify(results, null, 2));
  writeFileSync(resolve(OUTPUT, "multi-resolution.json"), JSON.stringify({
    composition: LOTTIE.nm,
    fps: LOTTIE.fr,
    frames: FRAMES,
    resolutions: RESOLUTIONS.map((r) => `${r.width}x${r.height}`),
    results,
  }, null, 2));

  for (const artefact of ["lottie.json", "parity-all.json", "multi-resolution.json",
    "web-485x125/frames/f_00000.png", "native-970x250/hero.webm",
    "native-1940x500/hero.webm", "native-1940x500/decoded/f_00005.png"]) {
    ok(`output: ${artefact}`, existsSync(resolve(OUTPUT, artefact)));
  }

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 2,
    engine: "lottie-web + Chromium + ffmpeg VP9",
    assertions: passed + 1,
    resolutions: RESOLUTIONS.map((r) => `${r.width}x${r.height}`),
    framesPerResolution: FRAMES,
    maxDelta: Math.max(...results.map((r) => Number(r.maxDelta))),
    artefacts: ["lottie.json", "web-*/frames", "native-*/hero.webm", "native-*/decoded", "parity-all.json", "multi-resolution.json"],
    result: "three resolutions rendered in Chromium, encoded to VP9 and audited frame-by-frame at delta <= 3",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
