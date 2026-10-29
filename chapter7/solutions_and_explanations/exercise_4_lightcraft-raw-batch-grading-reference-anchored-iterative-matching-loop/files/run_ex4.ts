// run_ex4.ts — deterministic harness for the LightCraft grading loop.
//
// Builds a small photo and a reference render in the live catalog, runs the
// loop with a scripted critique that reads the actual luminance of both
// rasters, checks the rollback path, exercises the TCP control channel against
// a stub server, and validates the quadratic fit and convergence units.

import { strict as assert } from "node:assert";
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { PNG } from "pngjs";
import {
  DEFAULT_CONFIG,
  DevelopChannel,
  GradeConfig,
  LightcraftSession,
  LightcraftTcp,
  VisionZoneCritique,
  ZoneDeltaE,
  critiqueToDeltas,
  deltaE2000,
  fitQuadratic,
  gradePhoto,
  perZoneDeltaE,
  rgbToLab,
  runBatch,
  shouldConverge,
  startStubControlServer,
} from "./04_lightcraft-raw-batch-grading-reference-anchored-iterative-matching-loop.js";

const ROOT = process.cwd();
const OUTPUT = resolve(ROOT, "..", "output");
const INPUT = resolve(ROOT, "input");

let passed = 0;
function ok(label: string, condition: boolean, detail = ""): void {
  if (!condition) {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  passed++;
  console.log(`PASS ${label}`);
}

function equal<T>(label: string, actual: T, expected: T): void {
  ok(label, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

function near(label: string, actual: number, expected: number, eps: number): void {
  ok(label, Math.abs(actual - expected) <= eps, `expected ${expected} ± ${eps}, got ${actual}`);
}

// ---------------------------------------------------------------------------
// Fixture pixels
// ---------------------------------------------------------------------------

function basePhoto(): PNG {
  const png = new PNG({ width: 900, height: 600 });
  for (let y = 0; y < 600; y++) {
    for (let x = 0; x < 900; x++) {
      const i = (y * 900 + x) * 4;
      // A room-like frame: dark corners, warm midtones, a bright window.
      const window = Math.exp(-(((x - 700) ** 2) / 90000 + ((y - 200) ** 2) / 70000));
      const corner = Math.exp(-(((x - 120) ** 2) / 70000 + ((y - 480) ** 2) / 50000));
      png.data[i] = Math.round(40 + (x / 900) * 155 + window * 90);
      png.data[i + 1] = Math.round(32 + (y / 600) * 135 + window * 80);
      png.data[i + 2] = Math.round(28 + ((x + y) / 1500) * 95 + corner * 35);
      png.data[i + 3] = 255;
    }
  }
  return png;
}

const TARGET = {
  "light.exposure": 0.55,
  "light.shadows": 28,
  "light.highlights": -18,
  "wb.temp": 7200,
};

const OFF = {
  "light.exposure": -0.15,
  "light.shadows": -8,
  "light.highlights": 8,
  "wb.temp": 6200,
};

function zoneMeanL(png: PNG, zonesOf: PNG): { shadows: number; midtones: number; highlights: number } {
  const sums = { shadows: 0, midtones: 0, highlights: 0 };
  const counts = { shadows: 0, midtones: 0, highlights: 0 };
  for (let y = 0; y < zonesOf.height; y++) {
    for (let x = 0; x < zonesOf.width; x++) {
      const rz = (y * zonesOf.width + x) * 4;
      const target = rgbToLab([zonesOf.data[rz], zonesOf.data[rz + 1], zonesOf.data[rz + 2]]);
      const zone = target[0] < 25 ? "shadows" : target[0] < 75 ? "midtones" : "highlights";
      const sx = Math.round((x / zonesOf.width) * (png.width - 1));
      const sy = Math.round((y / zonesOf.height) * (png.height - 1));
      const pi = (sy * png.width + sx) * 4;
      const candidate = rgbToLab([png.data[pi], png.data[pi + 1], png.data[pi + 2]]);
      sums[zone] += candidate[0];
      counts[zone]++;
    }
  }
  return {
    shadows: sums.shadows / Math.max(1, counts.shadows),
    midtones: sums.midtones / Math.max(1, counts.midtones),
    highlights: sums.highlights / Math.max(1, counts.highlights),
  };
}

function scriptedCritique(confidence = 0.9) {
  let calls = 0;
  const fn = async ({ proxyPng, referencePng }: { proxyPng: string; referencePng: string }): Promise<VisionZoneCritique> => {
    calls++;
    const proxy = PNG.sync.read(Buffer.from(proxyPng, "base64"));
    const reference = PNG.sync.read(Buffer.from(referencePng, "base64"));
    const proxyL = zoneMeanL(proxy, reference);
    const refL = zoneMeanL(reference, reference);
    const zone = (name: keyof typeof proxyL) => {
      const difference = refL[name] - proxyL[name];
      if (!Number.isFinite(difference)) {
        return {
          direction: "hold" as const,
          magnitude: "subtle" as const,
          rationale: `${name}: no pixels in this zone`,
          confidence,
        };
      }
      const direction = difference > 0.35 ? "increase" : difference < -0.35 ? "decrease" : "hold";
      const magnitude = Math.abs(difference) > 8 ? "strong" : Math.abs(difference) > 2 ? "moderate" : "subtle";
      return {
        direction: direction as "increase" | "decrease" | "hold",
        magnitude: magnitude as "subtle" | "moderate" | "strong",
        rationale: `${name}: proxy L* ${proxyL[name].toFixed(1)} against ${refL[name].toFixed(1)}`,
        confidence,
      };
    };
    return {
      zone_deltas: { shadows: zone("shadows"), midtones: zone("midtones"), highlights: zone("highlights") },
      global_confidence: confidence,
      calls,
    } as VisionZoneCritique & { calls: number };
  };
  return { fn, calls: () => calls };
}

// ---------------------------------------------------------------------------
// Units
// ---------------------------------------------------------------------------

function unitColour(): void {
  console.log("\n# colour");
  const black = rgbToLab([0, 0, 0]);
  const white = rgbToLab([255, 255, 255]);
  near("ΔE: black to white", deltaE2000(black, white), 100, 0.05);
  near("ΔE: red to green", deltaE2000(rgbToLab([255, 0, 0]), rgbToLab([0, 255, 0])), 86.61, 0.05);
  equal("ΔE: identical", deltaE2000(black, black), 0);

  const png = basePhoto();
  const b64 = PNG.sync.write(png).toString("base64");
  const zero = perZoneDeltaE(b64, b64);
  equal("zones: identical shadows", zero.shadows, 0);
  equal("zones: identical midtones", zero.midtones, 0);
  equal("zones: identical highlights", zero.highlights, 0);

  const white2 = new PNG({ width: 8, height: 8 });
  white2.data.fill(255);
  const black2 = new PNG({ width: 8, height: 8 });
  for (let i = 0; i < black2.data.length; i += 4) {
    black2.data[i] = 0;
    black2.data[i + 1] = 0;
    black2.data[i + 2] = 0;
    black2.data[i + 3] = 255;
  }
  const contrast = perZoneDeltaE(
    PNG.sync.write(black2).toString("base64"),
    PNG.sync.write(white2).toString("base64"),
  );
  near("zones: black against white", contrast.midtones, 100, 0.5);
}

function unitFit(): void {
  console.log("\n# quadratic fit");
  const exact = [-1, 0, 1, 2, 3, 4].map((x) => ({ x, y: (x - 2) ** 2 + 1 }));
  const fit = fitQuadratic(exact);
  near("fit: vertex", fit.vertex, 2, 0.01);
  ok("fit: minimum", fit.isMinimum);
  ok("fit: trusted", fit.trusted);
  ok("fit: residual is small", fit.rss < 1e-6, `${fit.rss}`);

  const inverted = [-1, 0, 1].map((x) => ({ x, y: -(x ** 2) }));
  const bad = fitQuadratic(inverted);
  ok("fit: maximum is not trusted", !bad.trusted && !bad.isMinimum);

  const sparse = fitQuadratic([{ x: 0, y: 1 }]);
  ok("fit: one point is not trusted", !sparse.trusted);

  const noisy = [
    { x: 0, y: 5 },
    { x: 1, y: 1 },
    { x: 2, y: 4 },
    { x: 3, y: 2 },
    { x: 4, y: 6 },
  ];
  ok("fit: scattered points are not trusted", !fitQuadratic(noisy).trusted);
}

function unitConvergence(): void {
  console.log("\n# convergence");
  const flat: ZoneDeltaE = { shadows: 1, midtones: 1, highlights: 1 };
  const history = [
    { zoneDeltaE: { shadows: 1.2, midtones: 1.1, highlights: 1.3 }, appliedDeltas: { "light.shadows": 8 } },
    { zoneDeltaE: flat, appliedDeltas: { "light.shadows": 8 } },
  ];
  const critique: VisionZoneCritique = {
    zone_deltas: {
      shadows: { direction: "decrease", magnitude: "subtle", rationale: "", confidence: 0.5 },
      midtones: { direction: "hold", magnitude: "subtle", rationale: "", confidence: 0.5 },
      highlights: { direction: "hold", magnitude: "subtle", rationale: "", confidence: 0.5 },
    },
    global_confidence: 0.8,
  };
  const flatResult = shouldConverge({ history, critique, fit: [], thresholds: DEFAULT_CONFIG.zoneThresholds });
  ok("convergence: flat ΔE", flatResult.converged);
  ok("convergence: flat reason", flatResult.reason.includes("flat"));

  const moving = shouldConverge({
    history: [
      { zoneDeltaE: { shadows: 4, midtones: 4, highlights: 4 }, appliedDeltas: {} },
      { zoneDeltaE: { shadows: 3, midtones: 2, highlights: 1 }, appliedDeltas: {} },
    ],
    critique,
    fit: [],
    thresholds: DEFAULT_CONFIG.zoneThresholds,
  });
  ok("convergence: still moving", !moving.converged);

  const vertex = shouldConverge({
    history: [],
    critique,
    fit: [{ control: "light.exposure", vertex: 0.55, current: 0.55, step: 0.01, trusted: true }],
    thresholds: DEFAULT_CONFIG.zoneThresholds,
  });
  ok("convergence: trusted vertex", vertex.converged && vertex.reason.includes("vertex"));
}

// ---------------------------------------------------------------------------
// Live fixtures
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  mkdirSync(OUTPUT, { recursive: true });
  mkdirSync(INPUT, { recursive: true });
  unitColour();
  unitFit();
  unitConvergence();

  const photo = basePhoto();
  writeFileSync(resolve(INPUT, "base.png"), PNG.sync.write(photo));
  writeFileSync(resolve(INPUT, "base-copy.png"), PNG.sync.write(photo));

  const session = new LightcraftSession();
  await session.connect();
  try {
    await session.import([resolve(INPUT, "base.png")]);
    const photos = await session.photos();
    ok("catalog: the source photo is imported", photos.length === 1, `${photos.length}`);
    const gradedPhoto = photos[0].id;

    // Reference: the founder's look, rendered once and kept beside the photo.
    await session.select(gradedPhoto);
    await session.execute("develop.set", { values: TARGET });
    const referencePng = await session.render(gradedPhoto, 512);
    writeFileSync(resolve(INPUT, "reference.png"), Buffer.from(referencePng, "base64"));

    // The graded photo starts from an off look, as if a junior editor synced
    // yesterday's preset across the property.
    await session.execute("develop.reset");
    await session.execute("develop.set", { values: OFF });
    const controls = await session.controls();
    ok("controls: exposure present", controls.some((c) => c.id === "light.exposure"));
    ok("controls: temperature is wb.temp", controls.some((c) => c.id === "wb.temp"));

    const critique = scriptedCritique();
    const { report, state } = await gradePhoto(session, gradedPhoto, referencePng, {
      ...DEFAULT_CONFIG,
      maxIterations: 6,
    }, { critique: critique.fn });

    ok("grade: converged", report.converged, report.reason);
    ok("grade: within six iterations", report.iterationsUsed <= 6, `${report.iterationsUsed}`);
    const initialSum = report.initialDeltaE.shadows + report.initialDeltaE.midtones + report.initialDeltaE.highlights;
    const finalSum = report.finalDeltaE.shadows + report.finalDeltaE.midtones + report.finalDeltaE.highlights;
    ok("grade: ΔE dropped", finalSum < initialSum, `${initialSum.toFixed(2)} → ${finalSum.toFixed(2)}`);
    ok("grade: corrections recorded", report.appliedDeltas.length >= 3, `${report.appliedDeltas.length}`);
    ok("grade: not escalated", !report.escalated);
    ok("grade: not rolled back", !report.rolledBack);
    ok("grade: state holds one run", state.iterations.length === report.iterationsUsed);

    const finalDevelop = await session.execute("develop.get") as any;
    ok("grade: exposure moved up", finalDevelop.light.exposure > OFF["light.exposure"], `${finalDevelop.light.exposure}`);
    ok("grade: shadows moved up", finalDevelop.light.shadows > OFF["light.shadows"], `${finalDevelop.light.shadows}`);

    writeFileSync(resolve(OUTPUT, "proxy-final.png"), Buffer.from(state.iterations.at(-1)!.renderedProxy, "base64"));
    writeFileSync(resolve(OUTPUT, "grading_report.json"), JSON.stringify(report, null, 2));

    // --- Low confidence rolls back ----------------------------------------
    console.log("\n# low confidence");
    await session.execute("develop.set", { values: OFF });
    const lowCritique = scriptedCritique(0.3);
    const low = await gradePhoto(session, gradedPhoto, referencePng, { ...DEFAULT_CONFIG, maxIterations: 6 }, { critique: lowCritique.fn });
    ok("rollback: escalated", low.report.escalated);
    ok("rollback: flagged", low.report.rolledBack);
    ok("rollback: two low-confidence reads", low.report.iterationsUsed === 2, `${low.report.iterationsUsed}`);
    equal("rollback: nothing applied", low.report.appliedDeltas.length, 0);
    ok("rollback: reason names confidence", low.report.reason.includes("confidence"), low.report.reason);
    const restored = await session.execute("develop.get") as any;
    near("rollback: exposure restored", restored.light.exposure, OFF["light.exposure"], 0.001);
    near("rollback: shadows restored", restored.light.shadows, OFF["light.shadows"], 0.5);

    writeFileSync(resolve(OUTPUT, "report-rollback.json"), JSON.stringify(low.report, null, 2));
    const lowProxy = low.state.iterations.at(-1)?.renderedProxy;
    if (lowProxy) {
      writeFileSync(resolve(OUTPUT, "proxy-rollback.png"), Buffer.from(lowProxy, "base64"));
    }

    // --- TCP channel -------------------------------------------------------
    console.log("\n# tcp channel");
    const stub = await startStubControlServer({
      token: "s3cret",
      execute: (command, params) => session.execute(command, params),
      render: (id, maxSide) => session.render(id, maxSide),
    });
    const port = (stub as any).port as number;
    try {
      const bad = new LightcraftTcp("127.0.0.1", port, "wrong");
      let refused = "";
      try {
        await bad.execute("develop.get");
      } catch (error) {
        refused = (error as Error).message;
      }
      ok("tcp: wrong token is refused", refused.includes("bad token"), refused);
      await bad.close();

      const good = new LightcraftTcp("127.0.0.1", port, "s3cret");
      const development = await good.execute("develop.get") as any;
      ok("tcp: develop.get returns settings", typeof development.light === "object");
      const rendered = await good.render(gradedPhoto, 256);
      const renderedPng = PNG.sync.read(Buffer.from(rendered, "base64"));
      equal("tcp: render returns the proxy", renderedPng.height > 0, true);
      ok("tcp: auth frame was sent", (stub as any).authFrames >= 1);
      await good.close();
    } finally {
      stub.server.close();
    }

    // --- Batch resume and a short batch ------------------------------------
    console.log("\n# batch");
    let clock = 0;
    let persisted = 0;
    const resume = await runBatch(session, {
      photos: [{ id: gradedPhoto, referencePng }],
      config: { ...DEFAULT_CONFIG, maxIterations: 1 },
      budgetMs: 10,
    }, { critique: critique.fn, now: () => { const stamp = clock; clock += 20_000; return stamp; }, persist: async () => { persisted++; } });
    ok("batch: resumes at the first unprocessed photo", resume.resumeFrom === 0, `${resume.resumeFrom}`);
    ok("batch: partial state persisted", persisted === 1, `${persisted}`);
    equal("batch: nothing reported before the budget", Object.keys(resume.report).length, 0);

    const short = await runBatch(session, {
      photos: [{ id: gradedPhoto, referencePng }],
      config: { ...DEFAULT_CONFIG, maxIterations: 1 },
      budgetMs: 45 * 60 * 1000,
    }, { critique: critique.fn, now: Date.now, persist: async () => { persisted++; } });
    ok("batch: report keyed by photo", Object.prototype.hasOwnProperty.call(short.report, String(gradedPhoto)));
    ok("batch: elapsed is measured", short.elapsedMs >= 0);
  } finally {
    await session.close();
  }

  copyFileSync(resolve(INPUT, "base.png"), resolve(OUTPUT, "source.png"));
  copyFileSync(resolve(INPUT, "reference.png"), resolve(OUTPUT, "reference.png"));
  const artefacts = [
    "source.png",
    "reference.png",
    "proxy-final.png",
    "proxy-rollback.png",
    "grading_report.json",
    "report-rollback.json",
  ];
  for (const artefact of artefacts) {
    ok(`output: ${artefact}`, existsSync(resolve(OUTPUT, artefact)));
  }
  writeFileSync(resolve(OUTPUT, "report.json"), JSON.stringify({
    exercise: 4,
    engine: "lightcraft-cli",
    assertions: passed,
    artefacts,
    result: "reference-anchored grade converged; low-confidence batch rolled back",
  }, null, 2));

  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
