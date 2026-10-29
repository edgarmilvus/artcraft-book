// ═══════════════════════════════════════════════════════════════════════════
// examples/forge-real-engine.ts — the Advanced example, run against the REAL
// engine (photocraft-cli) instead of the pure smoke compiler.
//
//   npm run forge:real
//
// recipe -> compileRecipe -> command plan -> EngineSession (MCP stdio) -> .pcraft + PNG
// ═══════════════════════════════════════════════════════════════════════════

import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ArtCraftEngine, EngineSession } from '../src/artcraft/engine-session.js';
import { compileRecipe } from '../src/artcraft/compiler.js';
import type { LayeredRecipe } from '../src/artcraft/recipe.js';

const recipe: LayeredRecipe = {
  schema: 'artcraft.layered-recipe/v1',
  id: 'forge-real',
  title: 'Forge real-engine run',
  createdAt: '2026-01-01T00:00:00.000Z',
  canvas: { width: 1920, height: 1080, mode: 'rgb', depth: 8, background: '#ffffff', resolution: 72 },
  sources: [
    {
      id: 'hero',
      role: 'plate',
      path: 'assets/hero.png',
      sha256: 'a'.repeat(64),
      bytes: 9731,
      pixelWidth: 2048,
      pixelHeight: 1152,
      origin: { generator: 'camera', license: 'proprietary' },
    },
  ],
  stack: [
    { kind: 'shape', name: 'bg', shape: { kind: 'rect', rect: [0, 0, 1920, 1080] }, fill: '#0f172a', stroke: null },
    {
      kind: 'smart-object',
      name: 'hero',
      assetId: 'hero',
      fit: true,
      mask: { kind: 'brush', stroke: { points: [[10, 10], [20, 40]], size: 120, hardness: 0.7 } },
    },
    { kind: 'adjustment', name: 'grade', adjustment: 'curves', params: { points: [[0, 0], [64, 40], [192, 215], [255, 255]] } },
    {
      kind: 'group',
      name: 'title-block',
      children: [
        { kind: 'type', name: 'headline', text: 'Hello Layered World', x: 120, y: 820, font: 'Inter', size: 120, color: '#f8fafc' },
      ],
    },
  ],
  variants: [{ name: 'warm', appearance: true }],
  delivery: [{ id: 'out', kind: 'raster', path: 'out.png', format: 'png', width: 1920, height: 1080 }],
};

const root = process.cwd();
// Run artifacts live beside the project, in ../output (kept out of the source).
const outDir = process.env.RUN_OUTPUT ?? resolve(root, '..', 'output');
await mkdir(outDir, { recursive: true });
const session = new EngineSession({
  binary: process.env.ARTCRAFT_BIN ?? 'photocraft-cli',
  readRoot: root,
  writeRoot: outDir,
});
const engine = new ArtCraftEngine(session);

try {
  const phases = compileRecipe(recipe, (asset) => asset.path);
  let completed = 0;
  let failed = 0;

  for (const phase of phases) {
    // ── FIX 1: `file.placeEmbedded` is disabled under automation ──────────
    // The engine refuses it ("uses ambient filesystem paths and is disabled;
    // use capability-scoped document methods"). The capability-scoped path is
    // the `doc_place` MCP tool, and it does create a Smart Object.
    const placeStep = phase.steps.find((s) => s.id === 'file.placeEmbedded');
    if (placeStep) {
      const scopedName = String(placeStep.params.path).split('/').pop() ?? 'placed';
      const placed = await engine.session.call<{ layer: number; smartObject?: boolean }>('doc_place', {
        path: String(placeStep.params.path),
        fit: Boolean(placeStep.params.fit),
        center: [recipe.canvas.width / 2, recipe.canvas.height / 2],
      });
      console.log(`   doc_place -> layer ${placed.layer}, smartObject=${placed.smartObject}`);
      // Rename from the file basename to the scoped name later $layer refs use.
      const scoped = collectLayerNames(phase.steps).find((n) => n.includes('/'));
      if (scoped) await engine.runCommand('layer.setProps', { layer: { $layer: scopedName }, name: scoped });
    }

    // ── FIX 2: `select.deselect` is disabled with an empty selection ──────
    // It errors when nothing is selected, which aborts a stop-on-error batch.
    const steps = phase.steps
      .filter((s) => s.id !== 'file.placeEmbedded' && s.id !== 'select.deselect')
      .map((s) => ({ id: s.id, params: s.params, wait: true }));

    if (steps.length === 0) continue;
    const outcome = await engine.runBatch(steps, false);
    completed += outcome.completed;
    failed += outcome.failed;
    console.log(`[${phase.phase}] completed=${outcome.completed} failed=${outcome.failed}`);
    for (const r of outcome.results) {
      if (!r.ok) console.log('   FAIL:', JSON.stringify(r).slice(0, 200));
    }
  }

  const saved = await engine.save({ path: 'forge-real.pcraft' });
  console.log('save    ->', JSON.stringify(saved));

  const preview = await engine.renderPreview(1024);
  const image = preview.images?.[0];
  if (image) {
    await writeFile(resolve(outDir, 'forge-real.png'), Buffer.from(image.data, 'base64'));
    console.log('preview ->', resolve(outDir, 'forge-real.png'));
  }

  console.log(`\nTOTAL completed=${completed} failed=${failed}`);
} finally {
  await session.close();
}

/** Collect every {"$layer": name} reference found anywhere in the steps. */
function collectLayerNames(steps: Array<{ params: unknown }>): string[] {
  const names: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>;
      if (typeof o.$layer === 'string') names.push(o.$layer);
      Object.values(o).forEach(walk);
    }
  };
  steps.forEach((s) => walk(s.params));
  return names;
}
