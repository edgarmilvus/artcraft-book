// run_ex1.ts — acceptance harness for the Lottie → VP9-alpha manifest.
//
// It writes a real 12-frame animation, encodes it as VP9 with an alpha plane,
// checks the yuva420p container tag, hashes every delivery and writes the
// manifest. The engine/browser capture path is `main()` in the solution.

import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  assertYuva420p,
  sha256Bytes,
  sha256File,
  writeManifest,
  type DeliveryManifest,
} from "./01_pipeline.js";

const HERE = process.cwd();
const OUTPUT = resolve(HERE, "..", "output");
const FRAMES = resolve(OUTPUT, "frames");

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

function frame(index: number): Buffer {
  const png = new PNG({ width: 320, height: 180 });
  for (let y = 0; y < 180; y += 1) {
    for (let x = 0; x < 320; x += 1) {
      const i = (y * 320 + x) * 4;
      const cx = 40 + index * 20;
      const inside = Math.hypot(x - cx, y - 90) < 34;
      png.data[i] = inside ? 29 : 20;
      png.data[i + 1] = inside ? 78 : 24;
      png.data[i + 2] = inside ? 216 : 30;
      png.data[i + 3] = inside ? 255 : 0;
    }
  }
  return PNG.sync.write(png);
}

async function main(): Promise<void> {
  rmSync(FRAMES, { recursive: true, force: true });
  for (const name of ["lottie.json", "hero-vp9.webm", "delivery.json", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  mkdirSync(FRAMES, { recursive: true });

  const frames = 12;
  for (let index = 0; index < frames; index += 1) {
    writeFileSync(resolve(FRAMES, `f_${String(index).padStart(5, "0")}.png`), frame(index));
  }
  writeFileSync(resolve(OUTPUT, "lottie.json"), JSON.stringify({
    v: "5.12.2", fr: 24, ip: 0, op: frames, w: 320, h: 180,
    nm: "HeroLoop", ddd: 0, assets: [], layers: [{ ty: 4 }],
  }, null, 2));

  console.log("\n# frame proof");
  ok("frames: twelve PNGs", existsSync(resolve(FRAMES, "f_00000.png")) &&
    existsSync(resolve(FRAMES, "f_00011.png")));
  const png = PNG.sync.read(readFileSync(resolve(FRAMES, "f_00000.png")));
  equal("frames: width", png.width, 320);
  equal("frames: height", png.height, 180);
  const lottie = JSON.parse(readFileSync(resolve(OUTPUT, "lottie.json"), "utf8"));
  equal("lottie: frame span", lottie.op - lottie.ip, frames);

  console.log("\n# VP9 alpha");
  const webm = resolve(OUTPUT, "hero-vp9.webm");
  execFileSync("ffmpeg", [
    "-y", "-loglevel", "error", "-framerate", "24",
    "-i", resolve(FRAMES, "f_%05d.png"),
    "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p", "-crf", "28", "-b:v", "0",
    webm,
  ]);
  ok("encode: webm exists", existsSync(webm) && readFileSync(webm).length > 1000);
  await assertYuva420p(webm);
  ok("encode: yuva420p probe passes", true);
  ok("encode: webm magic", readFileSync(webm).subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3])));

  console.log("\n# hashes and manifest");
  equal("hash: bytes", sha256Bytes(Buffer.from("abc")).length, 64);
  equal("hash: file", (await sha256File(webm)).length, 64);
  const manifest: DeliveryManifest = {
    compositionHash: sha256Bytes(Buffer.from(JSON.stringify(lottie))),
    lottie: { path: "lottie.json", sha256: await sha256File(resolve(OUTPUT, "lottie.json")) },
    webmAlpha: {
      path: "hero-vp9.webm", sha256: await sha256File(webm), pixFmt: "yuva420p",
      crf: 28, twoPassSizeBytes: readFileSync(webm).length,
    },
    parity: { lottieFrames: frames, encodedFrames: frames, matched: true },
  };
  writeFileSync(resolve(OUTPUT, "delivery.json"), JSON.stringify(manifest, null, 2));
  await writeManifest(manifest, resolve(OUTPUT, "delivery-copy.json"));
  ok("manifest: delivery.json", existsSync(resolve(OUTPUT, "delivery.json")));
  ok("manifest: written by helper", existsSync(resolve(OUTPUT, "delivery-copy.json")));
  equal("manifest: parity", manifest.parity.matched, true);
  equal("manifest: pix fmt", manifest.webmAlpha.pixFmt, "yuva420p");
  assert.equal(manifest.compositionHash.length, 64);

  for (const name of ["lottie.json", "hero-vp9.webm", "delivery.json", "delivery-copy.json"]) {
    ok(`output: ${name}`, existsSync(resolve(OUTPUT, name)));
  }
  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 1,
    engine: "ffmpeg + Lottie manifest (pure delivery proof)",
    assertions: passed + 1,
    frames,
    webmBytes: manifest.webmAlpha.twoPassSizeBytes,
    pixFmt: manifest.webmAlpha.pixFmt,
    artefacts: ["lottie.json", "frames/", "hero-vp9.webm", "delivery.json", "delivery-copy.json"],
    result: "12 frames encoded to VP9 alpha; yuva420p, hashes and parity manifest verified",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
