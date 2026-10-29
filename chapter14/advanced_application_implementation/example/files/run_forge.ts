// run_forge.ts — deterministic harness for the motion-graphics service.
//
// The whole pipeline runs against the real headless EffectCraft: the
// template is compiled into a rigged composition, the QA frame is rendered,
// the deliverable is encoded and the project is persisted.

import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, rmSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { runRenderJob, cacheKeyFor } from "./service.js";
import type { TemplateRequest } from "./contracts.js";

const OUTPUT = resolve(process.cwd(), "output");
const ROOT = resolve(OUTPUT, "workspace");
const DELIVERABLES = resolve(ROOT, "deliverables");
const PROJECTS = resolve(ROOT, "projects");

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

const request: TemplateRequest = {
  requestId: "9f1b0d2c-4a1e-4c7a-9b2d-0f6f1a2b3c4d",
  tenantId: "acme",
  templateId: "lower-third/v3",
  width: 1280,
  height: 720,
  frameRate: 30,
  tokens: {
    primary: "#111827",
    accent: "#f59e0b",
    ink: "#ffffff",
    surface: "#0b1220",
    fontFamily: "Inter",
    fontVariations: {},
  },
  content: {
    eyebrow: "CHAPTER 14",
    headline: "Autonomous Motion",
    subhead: "Compiled, graded and delivered by an agent.",
    holdMs: 2400,
    enterMs: 600,
    exitMs: 400,
  },
  deliverable: { format: "png", quality: 90, transparent: false },
};

async function main(): Promise<void> {
  rmSync(OUTPUT, { recursive: true, force: true });
  for (const dir of [DELIVERABLES, PROJECTS]) mkdirSync(dir, { recursive: true });

  console.log("\n# the cache key");
  const key = cacheKeyFor(request);
  equal("cache: it is a sha256 digest", key.length, 64);
  equal("cache: it is deterministic", cacheKeyFor(request), key);

  console.log("\n# the job");
  const result = await runRenderJob(request, {
    binaryPath: "effectcraft-cli",
    outputDir: DELIVERABLES,
    projectDir: PROJECTS,
  });

  console.log("\n# the result");
  ok("result: it has a request id", result.requestId === request.requestId);
  equal("result: the cache key came back", result.cacheKey, key);
  ok("result: the composition has an id", result.compId !== undefined, `${result.compId}`);
  ok("result: the duration is positive", result.durationSec > 0, `${result.durationSec}`);
  ok("result: the seed is a number", Number.isFinite(result.seed), `${result.seed}`);
  ok("result: the preview is a PNG", result.previewPngBase64.length > 1000, `${result.previewPngBase64.length}`);

  console.log("\n# the artefacts");
  ok("artefact: the preview was written", existsSync(resolve(DELIVERABLES, `${key}.preview.png`)));
  ok("artefact: the preview is not empty", statSync(resolve(DELIVERABLES, `${key}.preview.png`)).size > 1000);
  ok("artefact: the deliverable was written", existsSync(result.outputPath), result.outputPath);
  ok("artefact: the deliverable is not empty", statSync(result.outputPath).size > 1000);
  ok("artefact: the project was saved", existsSync(resolve(PROJECTS, `${key}.ecproj`)));

  assert.ok(existsSync(result.outputPath));
  console.log(`\n${passed} assertions passed`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
