// run_ex5.ts — acceptance harness for the screenshot-audited brand gate.
//
// It checks the self-contained D65 ΔE2000 chain, the zod vision schema, the
// CLI parser and the headless capture. It renders a real 1080×1080 proof
// frame in Chromium, samples three pixels, writes the gate report and
// exercises the signalstats fallback on a real VP9 encode.

import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import {
  VisionResponseSchema,
  captureProofFrame,
  deltaE2000,
  hexToLab,
  hexToRgb,
  numericFallback,
  parse,
  srgbToLinear,
  type VisionGateResult,
} from "./05_multimodal-correction-loop-screenshot-audited-lottie-frame-sanity-checks-in-ci-cd.js";

const pexec = promisify(execFile);
const HERE = process.cwd();
const OUTPUT = resolve(HERE, "..", "output");
const BRAND = "#0F62FE";

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

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

async function main(): Promise<void> {
  for (const name of ["onboarding.json", "proof-frame-30.png", "proof-frame-30-repeat.png",
    "onboarding.webm", "vision-gate.json", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  rmSync(resolve(OUTPUT, "audit"), { recursive: true, force: true });
  mkdirSync(resolve(OUTPUT, "audit"), { recursive: true });

  console.log("\n# colour science");
  equal("linear: black maps to zero", srgbToLinear(0), 0);
  equal("linear: white maps to one", srgbToLinear(1), 1);
  ok("linear: mid grey follows the EOTF", Math.abs(srgbToLinear(0.5) - 0.21404114) < 1e-6);
  const rgb = hexToRgb(BRAND);
  equal("hex: red channel", Math.round(rgb[0] * 255), 15);
  equal("hex: green channel", Math.round(rgb[1] * 255), 98);
  equal("hex: blue channel", Math.round(rgb[2] * 255), 254);
  let badHex = false;
  try { hexToRgb("#12345"); } catch { badHex = true; }
  ok("hex: a short value is refused", badHex);
  const brandLab = hexToLab(BRAND);
  equal("deltaE: identical colours are zero", deltaE2000(brandLab, brandLab), 0);
  const oneStep = deltaE2000(brandLab, hexToLab("#0F62FF"));
  ok(`deltaE: a one-step change is tiny (${oneStep.toFixed(3)})`, oneStep > 0 && oneStep < 1);
  const red = deltaE2000(brandLab, hexToLab("#FF0000"));
  ok(`deltaE: red is far from the brand (${red.toFixed(1)})`, red > 4);
  ok("deltaE: symmetric", Math.abs(red - deltaE2000(hexToLab("#FF0000"), brandLab)) < 1e-9);
  const white = deltaE2000(hexToLab("#FFFFFF"), hexToLab("#000000"));
  ok(`deltaE: white vs black is large (${white.toFixed(1)})`, white > 90);

  console.log("\n# vision schema and CLI");
  const sample = { observedHex: "#0F62FE", confidence: 0.94, notes: "flat brand panel" };
  ok("schema: a valid sample passes", VisionResponseSchema.safeParse(sample).success);
  ok("schema: a bad hex fails", !VisionResponseSchema.safeParse({ ...sample, observedHex: "blue" }).success);
  ok("schema: confidence above one fails", !VisionResponseSchema.safeParse({ ...sample, confidence: 1.2 }).success);
  ok("schema: notes over 240 chars fail", !VisionResponseSchema.safeParse({ ...sample, notes: "x".repeat(241) }).success);
  const cli = parse(["--lottie", "comps/Onboarding.json", "--brand", "#0F62FE",
    "--out", "dist", "--dry-run", "--bridge-port", "9001"]);
  equal("cli: lottie path", cli.lottie, "comps/Onboarding.json");
  equal("cli: brand", cli.brand, "#0F62FE");
  equal("cli: dry run", cli.dryRun, true);
  equal("cli: bridge port", cli.bridgePort, 9001);
  const defaults = parse([]);
  equal("cli: default composition", defaults.lottie, "comps/Onboarding.json");
  equal("cli: default output", defaults.out, "dist");
  equal("cli: default is not dry-run", defaults.dryRun, false);

  console.log("\n# headless proof frame");
  const lottie = JSON.parse(readFileSync(resolve(HERE, "proof-lottie.json"), "utf8")) as Record<string, unknown>;
  writeFileSync(resolve(OUTPUT, "onboarding.json"), JSON.stringify(lottie, null, 2));
  const proof = resolve(OUTPUT, "proof-frame-30.png");
  await captureProofFrame(resolve(OUTPUT, "onboarding.json"), 30, proof);
  ok("capture: proof frame exists", existsSync(proof) && readFileSync(proof).length > 1000);
  const png = PNG.sync.read(readFileSync(proof));
  equal("capture: width", png.width, 1080);
  equal("capture: height", png.height, 1080);
  const pixel = (x: number, y: number): string => {
    const i = (y * png.width + x) * 4;
    return hex(png.data[i]!, png.data[i + 1]!, png.data[i + 2]!);
  };
  const samples: [string, string, string] = [pixel(540, 540), pixel(400, 540), pixel(680, 540)];
  ok("capture: the centre is the brand colour", samples.every((s) => s === BRAND), JSON.stringify(samples));
  equal("capture: the page background is black", pixel(10, 10), "#000000");

  const repeat = resolve(OUTPUT, "proof-frame-30-repeat.png");
  await captureProofFrame(resolve(OUTPUT, "onboarding.json"), 30, repeat);
  const png2 = PNG.sync.read(readFileSync(repeat));
  const samePixels = png.data.length === png2.data.length &&
    Buffer.compare(png.data, png2.data) === 0;
  ok("capture: a repeat render is pixel-identical", samePixels);
  equal("capture: the repeat matches the hash", sha256(repeat), sha256(proof));

  console.log("\n# brand gate");
  const agreed = samples[0] === samples[1] && samples[1] === samples[2] ? samples[0] : null;
  const de = agreed ? deltaE2000(hexToLab(BRAND.toUpperCase()), hexToLab(agreed)) : Number.POSITIVE_INFINITY;
  const gate: VisionGateResult = {
    expectedHex: BRAND,
    observedSamples: samples,
    agreedHex: agreed,
    deltaE2000: de,
    pass: agreed !== null && de <= 4,
    fallbackUsed: false,
  };
  ok("gate: three samples agree", gate.agreedHex === BRAND);
  ok(`gate: deltaE within tolerance (${gate.deltaE2000.toFixed(3)})`, gate.deltaE2000 <= 4);
  ok("gate: pass", gate.pass);
  const disagreement: VisionGateResult = {
    ...gate,
    observedSamples: [BRAND, BRAND, "#FF0000"],
    agreedHex: null,
    deltaE2000: Number.POSITIVE_INFINITY,
    pass: false,
  };
  ok("gate: disagreement fails closed", !disagreement.pass && disagreement.agreedHex === null);
  assert.equal(gate.observedSamples.length, 3);

  console.log("\n# VP9 encode and numeric fallback");
  const webm = resolve(OUTPUT, "onboarding.webm");
  await pexec("ffmpeg", [
    "-y", "-loglevel", "error", "-loop", "1", "-framerate", "60", "-i", proof,
    "-t", "0.5", "-r", "60", "-c:v", "libvpx-vp9",
    "-pix_fmt", "yuva420p", "-auto-alt-ref", "0", "-crf", "24", "-b:v", "0",
    "-row-mt", "1", webm,
  ]);
  ok("encode: webm exists", existsSync(webm) && readFileSync(webm).length > 500);
  const { stdout: frameCount } = await pexec("ffprobe", [
    "-v", "error", "-count_frames", "-select_streams", "v:0",
    "-show_entries", "stream=nb_read_frames",
    "-of", "default=noprint_wrappers=1:nokey=1", webm,
  ]);
  equal("encode: thirty frames at 60 fps", Number(frameCount.trim()), 30);
  const fallback = await numericFallback(webm);
  ok(`fallback: mean luma is finite (${fallback.yavg.toFixed(2)})`, Number.isFinite(fallback.yavg));
  ok("fallback: the encode is not crushed or clipped", fallback.yavg > 16 && fallback.yavg < 235);

  writeFileSync(resolve(OUTPUT, "audit", "vision-gate.json"), JSON.stringify(gate, null, 2));
  for (const artefact of ["onboarding.json", "proof-frame-30.png", "proof-frame-30-repeat.png",
    "onboarding.webm", "signalstats-fallback.txt", "audit/vision-gate.json"]) {
    ok(`output: ${artefact}`, existsSync(resolve(OUTPUT, artefact)));
  }
  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 5,
    engine: "Chromium proof frame + D65 ΔE2000 + ffmpeg VP9",
    assertions: passed + 1,
    brandHex: BRAND,
    observedHex: gate.agreedHex,
    deltaE2000: gate.deltaE2000,
    proofFrame: "1080x1080",
    artefacts: ["onboarding.json", "proof-frame-30.png", "proof-frame-30-repeat.png",
      "onboarding.webm", "signalstats-fallback.txt", "audit/vision-gate.json"],
    result: "proof frame renders the brand exactly, three samples agree at ΔE 0 and the encode passes the signalstats floor",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
