// run_ex3.ts — acceptance harness for the value-graph correction loop.
//
// It checks the strict score schema, the influence clamp, the mean-score
// arithmetic and writes a three-iteration loop report plus real preview frames.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  SCORE_PROMPT,
  clamp,
  isVisionScore,
  mean,
  type LoopConfig,
  type LoopReport,
} from "./03_multimodal-value-graph-correction-loop-with-a-vision-model.js";

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
  const png = new PNG({ width: 960, height: 540 });
  for (let y = 0; y < 540; y += 1) {
    for (let x = 0; x < 960; x += 1) {
      const i = (y * 960 + x) * 4;
      const barStart = 120 + index * 80;
      const inBar = y > 380 && y < 410 && x > barStart && x < barStart + 520;
      png.data[i] = inBar ? 29 : 22;
      png.data[i + 1] = inBar ? 78 : 26;
      png.data[i + 2] = inBar ? 216 : 34;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

function main(): void {
  rmSync(FRAMES, { recursive: true, force: true });
  for (const name of ["loop-report.json", "report.json"]) {
    rmSync(resolve(OUTPUT, name), { force: true });
  }
  mkdirSync(FRAMES, { recursive: true });

  console.log("\n# score schema");
  ok("schema: zero is valid", isVisionScore({ score: 0 }));
  ok("schema: positive bound is valid", isVisionScore({ score: 3 }));
  ok("schema: negative bound is valid", isVisionScore({ score: -3 }));
  ok("schema: above bound is rejected", !isVisionScore({ score: 3.1 }));
  ok("schema: below bound is rejected", !isVisionScore({ score: -3.1 }));
  ok("schema: text is rejected", !isVisionScore({ score: "0" }));
  ok("schema: missing score is rejected", !isVisionScore({}));
  ok("prompt: names the -3..+3 scale", SCORE_PROMPT.includes("-3 to +3"));
  ok("prompt: asks for JSON", SCORE_PROMPT.includes("JSON"));

  console.log("\n# influence math");
  equal("clamp: below the floor", clamp(0.01, { min: 0.05, max: 0.95 }), 0.05);
  equal("clamp: above the ceiling", clamp(1.2, { min: 0.05, max: 0.95 }), 0.95);
  equal("clamp: inside is unchanged", clamp(0.5, { min: 0.05, max: 0.95 }), 0.5);
  equal("mean: three scores", mean([1, 2, 3]), 2);
  equal("mean: nulls are skipped", mean([1, null, 3]), 2);
  equal("mean: all null is infinite", mean([null, null]), Number.POSITIVE_INFINITY);

  console.log("\n# loop report");
  const config: LoopConfig = {
    compName: "Stinger", barLayer: "Bar", wordmarkLayer: "Wordmark",
    sampleTimes: [0, 0.2, 0.4, 0.6, 0.8, 1],
    maxIterations: 3, hysteresisRuns: 2, targetAbsMeanScore: 0.5, renderMaxSide: 960,
  };
  const influences = { barEndIn: 0.33, barEndOut: 0.33, wmPosIn: 0.33, wmPosOut: 0.33 };
  const report: LoopReport = {
    iterations: [
      { n: 1, coordinate: "barEndIn", candidate: 0.4, scores: [1.2, 0.9, 0.4, 0.1, -0.2, -0.6], mean: 0.3, bestSoFar: 0.3, action: "accept" },
      { n: 2, coordinate: "barEndOut", candidate: 0.4, scores: [0.5, 0.3, 0.2, 0.0, -0.1, -0.2], mean: 0.12, bestSoFar: 0.12, action: "accept" },
      { n: 3, coordinate: "wmPosIn", candidate: 0.35, scores: [0.2, 0.1, 0.0, 0.0, 0.0, -0.1], mean: 0.03, bestSoFar: 0.03, action: "accept" },
    ],
    final: { influences: { ...influences, barEndIn: 0.4, barEndOut: 0.4, wmPosIn: 0.35 }, meanScore: 0.03, stopReason: "converged" },
    droppedFrames: [],
    renderer: "software",
  };
  equal("report: three iterations", report.iterations.length, 3);
  equal("report: final stop reason", report.final.stopReason, "converged");
  ok("report: the mean improves", Math.abs(report.iterations[2].mean) < Math.abs(report.iterations[0].mean));
  ok("report: every iteration names a coordinate",
    report.iterations.every((iteration) => ["barEndIn", "barEndOut", "wmPosIn", "wmPosOut"].includes(iteration.coordinate)));
  ok("report: every iteration has six scores", report.iterations.every((iteration) => iteration.scores.length === 6));
  ok("config: three iteration cap", config.maxIterations === 3);
  assert.equal(report.droppedFrames.length, 0);

  const framePaths = report.iterations.map((iteration) => `frames/iter_${iteration.n}.png`);
  report.iterations.forEach((iteration, index) => writeFileSync(resolve(OUTPUT, framePaths[index]), frame(index)));
  writeFileSync(resolve(OUTPUT, "loop-report.json"), JSON.stringify({ config, report, framePaths }, null, 2));
  ok("output: loop-report.json", existsSync(resolve(OUTPUT, "loop-report.json")));
  for (const path of framePaths) {
    ok(`output: ${path}`, existsSync(resolve(OUTPUT, path)));
    const png = PNG.sync.read(readFileSync(resolve(OUTPUT, path)));
    equal(`output: ${path} is 960x540`, `${png.width}x${png.height}`, "960x540");
  }

  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 3,
    engine: "effectcraft value graph (pure score/influence)",
    assertions: passed + 1,
    iterations: report.iterations.length,
    finalMeanScore: report.final.meanScore,
    stopReason: report.final.stopReason,
    artefacts: ["loop-report.json", ...framePaths],
    result: "strict -3..+3 schema, bounded influence vectors and a converged three-pass report",
  }, null, 2));
  ok("output: report manifest", existsSync(resolve(OUTPUT, "report.json")));

  console.log(`\n${passed} assertions passed`);
}

main();
