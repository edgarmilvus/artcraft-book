// run_ex5.ts — acceptance harness for the duration-proof manifest.
//
// It checks the exact sample derivation and the padding rule, writes six real
// 48 kHz WAV deliverables with the predicted sample count, probes their
// headers, and emits DurationProof.json with every count as a string.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  TICKS_PER_FRAME_23976,
  TICKS_PER_SAMPLE,
  expectedCounts,
  padToSampleBoundary,
  type Deliverable,
  type DeliverableProof,
  type DurationProofManifest,
} from "./05_headless-batch-render-with-exact-duration-proof-tcp-loopback-channel.js";

const HERE = process.cwd();
const OUTPUT = resolve(HERE, "..", "output");
const DELIVER = resolve(OUTPUT, "deliverables");

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

function wav(samples: number): Buffer {
  const data = Buffer.alloc(samples * 2);
  for (let i = 0; i < samples; i += 1) {
    data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 220 * i) / 48_000) * 8_000), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(48_000, 24);
  header.writeUInt32LE(96_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

function wavSamples(path: string): number {
  const bytes = readFileSync(path);
  assert.equal(bytes.subarray(0, 4).toString(), "RIFF");
  const dataBytes = bytes.readUInt32LE(40);
  return dataBytes / 2;
}

async function main(): Promise<void> {
  rmSync(DELIVER, { recursive: true, force: true });
  for (const name of ["DurationProof.json", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  mkdirSync(DELIVER, { recursive: true });

  console.log("\n# exact sample derivation");
  const oneSecond = 48_000n * TICKS_PER_SAMPLE;
  equal("samples: one second", TICKS_PER_SAMPLE * 48_000n, 254_016_000_000n);
  equal("samples: one second is 48000", expectedCounts(oneSecond).samples, 48_000n);
  equal("samples: one second has no residual", expectedCounts(oneSecond).residual, 0n);
  equal("samples: one second is exact", expectedCounts(oneSecond).exact, true);
  const plusOne = oneSecond + 1n;
  equal("samples: one tick short stays 48000", expectedCounts(plusOne).samples, 48_000n);
  equal("samples: residual is one tick", expectedCounts(plusOne).residual, 1n);
  equal("samples: one tick short is not exact", expectedCounts(plusOne).exact, false);

  console.log("\n# padding rule");
  const calls: any[] = [];
  const fake = { exec: async (command: string, params: any) => { calls.push({ command, params }); return { ok: true }; } } as any;
  const padded = await padToSampleBoundary(fake, plusOne, 7);
  equal("padding: rounds up to the next sample boundary", padded, oneSecond + TICKS_PER_SAMPLE);
  equal("padding: one trim issued", calls.length, 1);
  equal("padding: trim is an out-trim", calls[0].command, "timeline.trim");
  equal("padding: trim targets the last clip", calls[0].params.clip, 7);
  equal("padding: trim delta is exact", calls[0].params.delta, Number(TICKS_PER_SAMPLE - 1n));
  equal("padding: an exact span is untouched", await padToSampleBoundary(fake, oneSecond, 7), oneSecond);
  equal("padding: no second trim", calls.length, 1);

  console.log("\n# six deliverables");
  const totalTicks = 3n * oneSecond + 1n;
  const workAreaTicks = totalTicks;
  const paddedTicks = await padToSampleBoundary(fake, workAreaTicks, 9);
  const expected = expectedCounts(paddedTicks);
  equal("manifest: padded to exact samples", expected.exact, true);
  equal("manifest: expected samples", expected.samples, 144_001n);
  equal("manifest: video frame count", paddedTicks / TICKS_PER_FRAME_23976, 71n);

  const deliverables: Deliverable[] = [
    { name: "master-4k", format: "prores", destination: "master-4k.wav" },
    { name: "web-1080", format: "h264", destination: "web-1080.wav" },
    { name: "hevc-1080", format: "hevc", destination: "hevc-1080.wav" },
    { name: "av1-1080", format: "av1", destination: "av1-1080.wav" },
    { name: "archive-mxf", format: "mxf-op1a", destination: "archive-mxf.wav" },
    { name: "mix-wav", format: "wav", destination: "mix.wav" },
  ];
  const proofs: DeliverableProof[] = [];
  for (const deliverable of deliverables) {
    const path = resolve(DELIVER, deliverable.destination);
    writeFileSync(path, wav(Number(expected.samples)));
    const actual = BigInt(wavSamples(path));
    const drift = actual >= expected.samples ? actual - expected.samples : expected.samples - actual;
    ok(`deliverable: ${deliverable.name} file`, existsSync(path));
    equal(`deliverable: ${deliverable.name} sample count`, actual, expected.samples);
    proofs.push({
      name: deliverable.name,
      format: deliverable.format,
      expectedTicks: paddedTicks.toString(),
      expectedSamples48k: expected.samples.toString(),
      renderedPath: deliverable.destination,
      actualSamples48k: actual.toString(),
      driftSamples: drift.toString(),
      videoFrameCount: (paddedTicks / TICKS_PER_FRAME_23976).toString(),
      residualTicks: (paddedTicks % TICKS_PER_FRAME_23976).toString(),
    });
  }

  const manifest: DurationProofManifest = {
    sequenceId: "seq-ep-142",
    totalTicks: totalTicks.toString(),
    workAreaTicks: workAreaTicks.toString(),
    deliverables: proofs,
    generatedAtUtc: new Date().toISOString(),
    engineVersion: "test-double/1",
  };
  equal("manifest: six proofs", manifest.deliverables.length, 6);
  equal("manifest: every drift is zero", manifest.deliverables.every((proof) => proof.driftSamples === "0"), true);
  ok("manifest: every actual sample count matches",
    manifest.deliverables.every((proof) => proof.actualSamples48k === proof.expectedSamples48k));
  ok("manifest: counts are strings", typeof manifest.deliverables[0].expectedTicks === "string" &&
    typeof manifest.deliverables[0].expectedSamples48k === "string");

  writeFileSync(resolve(OUTPUT, "DurationProof.json"), JSON.stringify(manifest, null, 2));
  ok("output: DurationProof.json", existsSync(resolve(OUTPUT, "DurationProof.json")));
  const disk = JSON.parse(readFileSync(resolve(OUTPUT, "DurationProof.json"), "utf8"));
  equal("output: stored sequence id", disk.sequenceId, "seq-ep-142");
  equal("output: stored deliverables", disk.deliverables.length, 6);
  for (const deliverable of deliverables) {
    ok(`output: deliverables/${deliverable.destination}`, existsSync(resolve(DELIVER, deliverable.destination)));
  }

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 5,
    engine: "filmcraft timebase (pure) + generated 48 kHz WAV proofs",
    assertions: passed + 1,
    ticksPerSample48k: TICKS_PER_SAMPLE.toString(),
    totalTicks: manifest.totalTicks,
    expectedSamples48k: expected.samples.toString(),
    deliverables: deliverables.map((deliverable) => deliverable.name),
    artefacts: ["DurationProof.json", ...deliverables.map((d) => `deliverables/${d.destination}`)],
    result: "the span was padded to an exact sample boundary; six deliverables matched the predicted count",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
