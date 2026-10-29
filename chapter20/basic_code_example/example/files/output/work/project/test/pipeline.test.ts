// test/pipeline.test.ts
/**
 * The pipeline's test. Everything the pipeline touches is injected, so
 * the test substitutes a store and a renderer and never opens a socket
 * and never spawns an engine.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

import { createInMemoryBrandStore } from "../src/dbClient.js";
import {
  createLocalEmbedder,
  EMBEDDING_DIM,
  EXAMPLE_BRAND_ASSETS,
  seedBrandMemory,
} from "../src/brandMemory.js";
import {
  HERO_RENDER_COST,
  type HeroRenderResult,
  type HeroRenderSpec,
} from "../src/photocraftBridge.js";
import { runStudioOnce, type StudioBrief } from "../src/pipeline.js";
import type { StudioEnv } from "../src/env.js";

/** A one-pixel PNG: enough for the pipeline's artefact guard. */
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

const workDir = mkdtempSync(join(tmpdir(), "studio-hello-"));

after(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** The configuration the test runs with. */
function makeEnv(overrides: Partial<StudioEnv> = {}): StudioEnv {
  return {
    photocraftBin: "photocraft-cli",
    workDir,
    budgetUnits: 8,
    embeddingDim: EMBEDDING_DIM,
    ...overrides,
  };
}

/** A renderer that writes a file and reports what the engine would. */
function fakeRenderer(
  warnings: readonly string[] = [],
): (spec: HeroRenderSpec) => Promise<HeroRenderResult> {
  return async (spec: HeroRenderSpec): Promise<HeroRenderResult> => {
    mkdirSync(spec.outDir, { recursive: true });
    const path = join(spec.outDir, spec.outFile);
    writeFileSync(path, ONE_PIXEL_PNG);
    return {
      path,
      relativePath: spec.outFile,
      warnings,
      calls: [
        "doc_new",
        "command_run:shape.create",
        "command_run:type.create",
        "command_run:type.create",
        "doc_save",
      ],
    };
  };
}

/** A store with the corpus already in it. */
async function seededStore(): Promise<ReturnType<typeof createInMemoryBrandStore>> {
  const store = createInMemoryBrandStore({
    file: ":memory:",
    dim: EMBEDDING_DIM,
  });
  await seedBrandMemory(store, EXAMPLE_BRAND_ASSETS, createLocalEmbedder());
  return store;
}

const BRIEF: StudioBrief = {
  product: "ArtCraft Suite",
  audience: "indie game studios",
  tone: "confident, technical",
  callToAction: "Start the free trial",
};

test("the retrieval grounds the copy in the approved exemplar", async () => {
  const store = await seededStore();
  const result = await runStudioOnce(BRIEF, {
    env: makeEnv(),
    store,
    embed: createLocalEmbedder(),
    render: fakeRenderer(["4 layer(s) flattened"]),
  });

  assert.equal(result.exemplarId, "brand-001");
  assert.equal(result.headline, "Ship faster");
  assert.equal(result.subhead, "Try it now");
  assert.ok((result.exemplarSimilarity ?? 0) > 0.72);
  assert.deepEqual([...result.warnings], ["4 layer(s) flattened"]);
});

test("the run spends the budget it reserved and records the trace", async () => {
  const store = await seededStore();
  const result = await runStudioOnce(BRIEF, {
    env: makeEnv(),
    store,
    embed: createLocalEmbedder(),
    render: fakeRenderer(),
    now: () => "2026-01-01T00:00:00.000Z",
  });

  assert.equal(result.budget.spent, HERO_RENDER_COST);
  assert.equal(result.budget.limit, 8);
  assert.equal(result.budget.remaining, 8 - HERO_RENDER_COST);
  assert.deepEqual(
    result.journal.map((entry) => entry.name),
    ["embed", "retrieve", "compose", "render", "materialise"],
  );

  const journal = readFileSync(
    join(workDir, "runs", `${result.runId}.jsonl`),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { step: number; at: string });
  assert.equal(journal.length, 5);
  assert.deepEqual(
    journal.map((entry) => entry.step),
    [1, 2, 3, 4, 5],
  );
  assert.equal(journal[0]?.at, "2026-01-01T00:00:00.000Z");
});

test("a brief the brand has never seen falls back to the template", async () => {
  const store = await seededStore();
  const result = await runStudioOnce(
    {
      product: "SoundCraft",
      audience: "sound designers",
      tone: "warm",
      callToAction: "Hear the difference",
    },
    {
      env: makeEnv(),
      store,
      embed: createLocalEmbedder(),
      render: fakeRenderer(),
    },
  );

  assert.equal(result.exemplarId, null);
  assert.equal(result.headline, "SoundCraft");
  assert.equal(result.subhead, "Hear the difference");
});

test("the budget refuses a run it cannot pay for", async () => {
  const store = await seededStore();
  await assert.rejects(
    runStudioOnce(BRIEF, {
      env: makeEnv({ budgetUnits: 1 }),
      store,
      embed: createLocalEmbedder(),
      render: fakeRenderer(),
    }),
    /budget exhausted/,
  );
});

test("the run is addressed by the content of its brief", async () => {
  const store = await seededStore();
  const deps = {
    env: makeEnv(),
    store,
    embed: createLocalEmbedder(),
    render: fakeRenderer(),
  };
  const first = await runStudioOnce(BRIEF, deps);
  const second = await runStudioOnce(BRIEF, deps);

  assert.equal(first.runId, second.runId);
  assert.equal(first.assetPath, second.assetPath);
});
