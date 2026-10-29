/**
 * The entry point, and the composition root: this is the one file that
 * knows how the pieces are wired together. It opens the store, loads
 * the corpus, injects the embedding model and the renderer, and hands
 * the pipeline a brief.
 *
 * Nothing below this line reads `process.env`, opens a socket or knows
 * what an embedding model is. The pipeline is handed four objects and a
 * brief; everything else is an implementation detail of this file.
 */
import { join } from "node:path";

import { ensureStudioWorkDir, loadStudioEnv } from "./env.js";
import { openBrandStore } from "./dbClient.js";
import {
  createLocalEmbedder,
  EXAMPLE_BRAND_ASSETS,
  seedBrandMemory,
} from "./brandMemory.js";
import { renderHeroBanner } from "./photocraftBridge.js";
import { runStudioOnce } from "./pipeline.js";

/**
 * The brief. The `as const` makes every field a literal type, so a
 * rename of `callToAction` in the pipeline becomes a compile error
 * here rather than a runtime `undefined`.
 */
const brief = {
  product: "ArtCraft Suite",
  audience: "indie game studios",
  tone: "confident, technical",
  callToAction: "Start the free trial",
} as const;

async function main(): Promise<void> {
  const env = loadStudioEnv();
  const workDir = ensureStudioWorkDir(env);

  // The brand memory: a durable file under the work root, seeded with
  // the campaigns the brand has already run.
  const store = openBrandStore({
    file: join(workDir, "brand-memory.sqlite"),
    dim: env.embeddingDim,
  });
  const embed = createLocalEmbedder(env.embeddingDim);
  await seedBrandMemory(store, EXAMPLE_BRAND_ASSETS, embed);

  // The run.
  const result = await runStudioOnce(brief, {
    env,
    store,
    embed,
    render: (spec) => renderHeroBanner(env.photocraftBin, spec),
  });

  console.log(`✓ Hero banner → ${result.assetPath}`);
  if (result.exemplarId !== null) {
    const similarity = result.exemplarSimilarity?.toFixed(3) ?? "0.000";
    console.log(`  Grounded in brand asset ${result.exemplarId} (${similarity})`);
  }
  for (const warning of result.warnings) {
    console.warn(`  ⚠ ${warning}`);
  }
  console.log(
    `  Budget: ${result.budget.spent}/${result.budget.limit} units, ${result.budget.remaining} left`,
  );
}

try {
  await main();
} catch (error: unknown) {
  console.error("studio-hello failed:", error);
  process.exitCode = 1;
}
