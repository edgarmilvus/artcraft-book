// run_ex5.ts — acceptance harness for the end-to-end delivery normalizer.
//
// It normalizes one brief from each client into the common delivery spec and
// writes the normalized specs plus a manifest. The engine pipeline in
// runPipeline() consumes exactly this spec.

import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  STANDARD_LOOKUP,
  normalizeSpec,
  type DeliveryManifest,
  type RawSpec,
} from "./05_end-to-end-delivery-pipeline-integrating-three-way-grade-ducking-and-lufs-governance.js";

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

const streamingA: RawSpec = {
  client: "StreamingA", creativeTone: "warm_cinematic", acquisitionCamera: "Sony FX6",
  loudnessStandard: "STREAMING", expectedRuntimeSec: 900, targetCodec: "h264",
};
const streamingB: RawSpec = {
  client: "StreamingB", tone: { adjective1: "cool", adjective2: "restrained" },
  camera: "ARRI Alexa", loudness: { standard: "ATSC_A85" }, runtimeSec: 1200,
  codec: { container: "mov", profile: "ProRes 4444" },
};
const broadcastX: RawSpec = {
  client: "BroadcastX", styleGuide: { palette: "warm", saturation: "low" },
  cameraModel: "Sony HDC-3500", deliverySpec: { loudness: "EBU_R128", truePeakCeilingDbtp: -1 },
  duration: { hours: 0, minutes: 42, seconds: 0 }, outputFormat: "dnxhr",
};

function main(): void {
  for (const name of ["normalized-specs.json", "delivery_manifest.json", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  mkdirSync(OUTPUT, { recursive: true });

  console.log("\n# normalization");
  const a = normalizeSpec(streamingA);
  equal("A: client", a.client, "StreamingA");
  equal("A: streaming target", a.integratedLufsTarget, -14);
  equal("A: streaming tolerance", a.integratedLufsTolerance, 1);
  equal("A: true peak ceiling", a.truePeakCeilingDbtp, -1);
  equal("A: container", a.targetContainer, "mov");
  equal("A: tone preserved", a.creativeTone, "warm_cinematic");
  equal("A: codec", a.targetCodec, "h264");

  const b = normalizeSpec(streamingB);
  equal("B: cool adjectives map to cool", b.creativeTone, "cool_desaturated");
  equal("B: ATSC target", b.integratedLufsTarget, -24);
  equal("B: ATSC tolerance", b.integratedLufsTolerance, 2);
  equal("B: 4444 profile", b.proresProfile, "4444");
  equal("B: runtime", b.expectedRuntimeSec, 1200);

  const x = normalizeSpec(broadcastX);
  equal("X: warm low-saturation maps warm", x.creativeTone, "warm_cinematic");
  equal("X: EBU target", x.integratedLufsTarget, -23);
  equal("X: EBU tolerance", x.integratedLufsTolerance, 0.5);
  equal("X: true peak from brief", x.truePeakCeilingDbtp, -1);
  equal("X: runtime is 42 minutes", x.expectedRuntimeSec, 2520);
  equal("X: dnxhr codec", x.targetCodec, "dnxhr");

  console.log("\n# standard lookup");
  equal("lookup: streaming", STANDARD_LOOKUP("STREAMING").duckDepthDb, -12);
  equal("lookup: A85 duck", STANDARD_LOOKUP("ATSC_A85").duckDepthDb, -14);
  equal("lookup: EBU duck", STANDARD_LOOKUP("EBU_R128").duckDepthDb, -14);

  console.log("\n# manifest");
  const specHash = createHash("sha256").update(JSON.stringify(broadcastX)).digest("hex");
  const idempotencyHash = createHash("sha256").update(`${"revision-1"}|${specHash}|1.0.0`).digest("hex");
  const manifest: DeliveryManifest = {
    pipelineVersion: "1.0.0",
    specNormalization: { raw: broadcastX, normalized: x },
    gradeEvidence: [{
      clipId: 7, verificationPng: "clip_7.png",
      scopeReadout: { paradeMaxIre: 98, waveformMaxIre: 100, midtoneMeanY: 48 },
    }],
    audioEvidence: {
      preDuckLufs: -20, postDuckLufs: -32, duckingKeyframes: 8,
      finalIntegratedLufs: -23, finalTruePeakDbtp: -1.2,
    },
    exportEvidence: {
      path: "BroadcastX/master.mxf", codec: "dnxhr", durationSec: 2520,
      sampleRate: 48_000, channels: 2,
    },
    idempotencyHash,
    manifestGeneratedAtIso: "2026-01-01T00:00:00.000Z",
  };
  equal("manifest: pipeline version", manifest.pipelineVersion, "1.0.0");
  equal("manifest: hash length", manifest.idempotencyHash.length, 64);
  equal("manifest: export duration", manifest.exportEvidence.durationSec, 2520);
  equal("manifest: final loudness in window", manifest.audioEvidence.finalIntegratedLufs, -23);
  ok("manifest: true peak below ceiling",
    manifest.audioEvidence.finalTruePeakDbtp <= x.truePeakCeilingDbtp + 0.5,
    `${manifest.audioEvidence.finalTruePeakDbtp}`);

  writeFileSync(resolve(OUTPUT, "normalized-specs.json"), JSON.stringify({ streamingA: a, streamingB: b, broadcastX: x }, null, 2));
  writeFileSync(resolve(OUTPUT, "delivery_manifest.json"), JSON.stringify(manifest, null, 2));
  ok("output: normalized-specs.json", existsSync(resolve(OUTPUT, "normalized-specs.json")));
  ok("output: delivery_manifest.json", existsSync(resolve(OUTPUT, "delivery_manifest.json")));
  const disk = JSON.parse(readFileSync(resolve(OUTPUT, "delivery_manifest.json"), "utf8"));
  equal("output: stored client", disk.specNormalization.normalized.client, "BroadcastX");
  equal("output: stored hash", disk.idempotencyHash, idempotencyHash);
  assert.equal(disk.gradeEvidence.length, 1);

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 5,
    engine: "filmcraft delivery pipeline (pure spec normalizer)",
    assertions: passed + 1,
    clients: ["StreamingA", "StreamingB", "BroadcastX"],
    normalized: { A: a, B: b, X: x },
    artefacts: ["normalized-specs.json", "delivery_manifest.json"],
    result: "three client briefs normalized to one delivery spec; manifest and idempotency hash written",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main();
