// ═══════════════════════════════════════════════════════════════════════════
// examples/compile-smoke.ts — runs the pure compiler with no engine required.
// Proves the recipe -> command-plan pipeline executes end-to-end.
//
//   npm run smoke
// ═══════════════════════════════════════════════════════════════════════════

import { compileRecipe } from '../src/artcraft/compiler.js';
import type { LayeredRecipe } from '../src/artcraft/recipe.js';

const recipe: LayeredRecipe = {
  schema: 'artcraft.layered-recipe/v1',
  id: 'smoke',
  title: 'Compiler smoke test',
  createdAt: '2026-01-01T00:00:00.000Z',
  canvas: { width: 1920, height: 1080, mode: 'rgb', depth: 8, background: '#ffffff', resolution: 72 },
  sources: [
    {
      id: 'hero',
      role: 'plate',
      path: 'assets/hero.png',
      sha256: 'a'.repeat(64),
      bytes: 12345,
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

const phases = compileRecipe(recipe, (asset) => asset.path);
const stepCount = phases.reduce((n, p) => n + p.steps.length, 0);

console.log(`compiled ${phases.length} phase(s), ${stepCount} step(s):`);
for (const phase of phases) {
  console.log(`\n[${phase.phase}]`);
  for (const step of phase.steps) console.log(`  - ${step.id}  ${JSON.stringify(step.params)}`);
}
