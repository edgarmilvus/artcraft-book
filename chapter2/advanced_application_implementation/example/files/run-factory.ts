// run-factory.ts — drives the Advanced example end to end against the real
// engine and verifies what the chapter claims.
//
//   tsx run-factory.ts
//
// Checks:
//   1. the whole pipeline runs (two MCP sessions, registry, planner, workers);
//   2. the accelerated preview and the exported PNG agree pixel-for-pixel;
//   3. the reconciliation report says so with real RMSE numbers;
//   4. the supervisor's plan produces the intended layered document (and no
//      stray empty layer);
//   5. the registry rejects an unknown command id;
//   6. `deriveVectorId` is stable for an unchanged brief and changes when a
//      *nested* field changes (the bug the old stringify form had).
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import { ArtCraftSession } from "./session.js";
import { CommandRegistry } from "./registry.js";
import { BrandFactory } from "./factory.js";
import { decodePngToPlanes } from "./dual-compositor.js";
import { TileDeltaPlanner } from "./tile-delta.js";
import { SupervisorNode, TypeSetterAgent, GradientAgent, ComplianceAgent } from "./supervisor.js";
import { deriveVectorId, type AssetRecord } from "./asset-store.js";
import type { TenantBrief } from "./supervisor.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const base = resolve(here, "..", "output", "factory");
const readRoot = join(base, "in");
const writeRoot = join(base, "out");
await mkdir(readRoot, { recursive: true });
await mkdir(writeRoot, { recursive: true });

const brief: TenantBrief = {
  tenantId: "acme",
  campaignId: "FW26-hero",
  locale: "en-GB",
  width: 1200,
  height: 628,
  hero: {
    headline: "Built for the long run",
    subhead: "Merino, knitted in Porto.",
    cta: "Shop the drop",
  },
  colorway: { primary: "#12263a", accent: "#e4572e", background: "#f4f1ea" },
  tier: "growth",
  fonts: { headline: "Helvetica", body: "Helvetica" },
};

const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
const check = (name: string, ok: boolean, detail: string) => {
  checks.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name} — ${detail}`);
};

/** Stand-in for the vision model: a deterministic 16-dim vector from the PNG. */
const embed = async (png: Uint8Array): Promise<number[]> => {
  const digest = createHash("sha256").update(png).digest();
  return Array.from(digest.subarray(0, 16), (byte) => byte / 255);
};

const records: AssetRecord[] = [];
const vectorStore = {
  async upsert(batch: AssetRecord[]) {
    records.push(...batch);
    return { upserted: batch.length };
  },
};

// ── 1. the factory pipeline ────────────────────────────────────────────────
const factory = new BrandFactory({ readRoot, writeRoot, vectorStore, embed });
const result = await factory.run(brief);
console.log("factory result:", JSON.stringify(result, null, 2));

const exportPath = join(writeRoot, brief.tenantId, `${brief.campaignId}.png`);
const previewPath = join(writeRoot, brief.tenantId, `${brief.campaignId}-preview.png`);
const exported = await readFile(exportPath);
const preview = await readFile(previewPath);
check("export written", exported.length > 1000, `${exported.length} bytes`);
check("preview written", preview.length > 1000, `${preview.length} bytes`);
check("vector record upserted", records.length === 1, `${records.length} record(s), id ${result.vectorId}`);

// ── 2. customer preview vs delivered export ───────────────────────────────
const a = decodePngToPlanes(exported);
const b = decodePngToPlanes(preview);
const sameSize = a.width === b.width && a.height === b.height;
const rmse: [number, number, number] = [0, 0, 0];
if (sameSize) {
  for (let c = 0; c < 3; c++) {
    let sum = 0;
    for (let i = 0; i < a.width * a.height; i++) {
      const d = a.rgb[c][i] - b.rgb[c][i];
      sum += d * d;
    }
    rmse[c] = Math.sqrt(sum / (a.width * a.height));
  }
}
check(
  "preview == export (pixel level)",
  sameSize && rmse.every((v) => v <= 1.5),
  `${a.width}x${a.height} vs ${b.width}x${b.height}, rmse=[${rmse.map((v) => v.toFixed(3)).join(", ")}]`,
);
check(
  "reconciliation report",
  result.reconciliation.converged && result.reconciliation.hashAligned,
  `converged=${result.reconciliation.converged} hashAligned=${result.reconciliation.hashAligned}`,
);

// ── 3. replay the workers' plan into a fresh document and inspect it ──────
let layerNames: string[] = [];
const replay = new ArtCraftSession({ binary: "photocraft-cli", readRoot, writeRoot });
await replay.connect();
try {
  const registry = await CommandRegistry.load(replay);
  check("registry loaded", registry.engineVersion !== "unknown", `engine ${registry.engineVersion}`);
  check("registry size", (await replay.rawCall<unknown[]>("command_list", { enabled_only: false })).length > 400, ">400 commands");

  let rejected = false;
  try {
    registry.assertValid("this.command.does.not.exist", {});
  } catch {
    rejected = true;
  }
  check("unknown command rejected", rejected, "registry.get() threw for a hallucinated id");

  await replay.newDoc({
    width: brief.width,
    height: brief.height,
    mode: "rgb",
    depth: 8,
    background: brief.colorway.background,
  });
  const plan = new SupervisorNode(
    [new GradientAgent(), new TypeSetterAgent(), new ComplianceAgent()],
    registry,
  ).dispatch(brief);
  const frames = new TileDeltaPlanner(registry).plan("verify", plan);
  for (const frame of frames) await replay.batch(frame.steps);
  const tree = await replay.inspect<{ layers: Array<{ name: string; kind: string; opacity: number }> }>();
  layerNames = tree.layers.map((layer) => layer.name);
  console.log(`plan: ${plan.length} step(s) in ${frames.length} frame(s) → layers: ${layerNames.join(" | ")}`);

  check("no stray empty layer", !layerNames.includes("Headline"), "the plan never adds an empty pixel layer");
  check("headline present", layerNames.includes(brief.hero.headline), brief.hero.headline);
  check("footer present", layerNames.some((n) => n.includes(brief.campaignId)), "campaign id in the footer");
  check("tenant mark present", layerNames.includes(brief.tenantId.toUpperCase()), brief.tenantId.toUpperCase());
  const mark = tree.layers.find((l) => l.name === brief.tenantId.toUpperCase());
  check("tenant mark is faint", (mark?.opacity ?? 1) < 0.5, `opacity ${mark?.opacity ?? "n/a"}`);
} finally {
  await replay.close();
}

// ── 4. vector id stability ────────────────────────────────────────────────
const id1 = deriveVectorId(brief, "photocraft-cli@0.8.2", ["gradient", "typesetter", "compliance"]);
const id2 = deriveVectorId(
  JSON.parse(JSON.stringify(brief)) as TenantBrief,
  "photocraft-cli@0.8.2",
  ["gradient", "typesetter", "compliance"],
);
const changed = { ...brief, hero: { ...brief.hero, headline: "Built for the short run" } };
const id3 = deriveVectorId(changed, "photocraft-cli@0.8.2", ["gradient", "typesetter", "compliance"]);
check("vector id stable", id1 === id2, id1);
check("vector id sees nested changes", id1 !== id3, `${id1} vs ${id3}`);

const failed = checks.filter((c) => !c.ok);
await writeFile(
  join(here, "..", "output", "run-log.json"),
  JSON.stringify({ brief, result, checks, rmse, layers: layerNames }, null, 2) + "\n",
);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
if (failed.length > 0) {
  console.error("FAILED:", failed.map((c) => c.name).join(", "));
  process.exit(1);
}
