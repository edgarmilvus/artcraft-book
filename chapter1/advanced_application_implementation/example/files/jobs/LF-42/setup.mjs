// jobs/LF-42/setup.mjs — make the LF-42 job runnable on this machine.
//
// The book's job.json points its roots at /srv/forge/tenants/acme/{in,out},
// which do not exist here, and it references jobs/LF-42/recipe.json, which the
// chapter never ships. This script writes both: the missing recipe (with the
// real sha256 of the source asset) and a job.local.json whose read/write roots
// are real directories under the section's output/ folder.
//
//   node jobs/LF-42/setup.mjs
import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));       // .../files/jobs/LF-42
const project = resolve(here, '..', '..');                   // .../files
const outRoot = process.env.RUN_OUTPUT ?? resolve(project, '..', 'output');
const inDir = resolve(outRoot, 'LF-42', 'in');
const outDir = resolve(outRoot, 'LF-42', 'out');
await mkdir(inDir, { recursive: true });
await mkdir(outDir, { recursive: true });

const source = resolve(project, 'assets', 'hero.png');
const target = resolve(inDir, 'hero.png');
await copyFile(source, target);
const bytes = await readFile(target);
const sha256 = createHash('sha256').update(bytes).digest('hex');

const recipe = {
  schema: 'artcraft.layered-recipe/v1',
  id: 'LF-42',
  title: 'Forge CLI job LF-42',
  createdAt: '2026-01-01T00:00:00.000Z',
  canvas: { width: 1920, height: 1080, mode: 'rgb', depth: 8, background: '#ffffff', resolution: 72 },
  sources: [{
    id: 'hero', role: 'plate', path: 'hero.png', sha256, bytes: bytes.byteLength,
    pixelWidth: 2048, pixelHeight: 1152, origin: { generator: 'camera', license: 'proprietary' },
  }],
  stack: [
    { kind: 'shape', name: 'bg', shape: { kind: 'rect', rect: [0, 0, 1920, 1080] }, fill: '#0f172a', stroke: null },
    {
      kind: 'smart-object', name: 'hero', assetId: 'hero', fit: true,
      mask: { kind: 'brush', stroke: { points: [[10, 10], [20, 40]], size: 120, hardness: 0.7 } },
    },
    { kind: 'adjustment', name: 'grade', adjustment: 'curves', params: { points: [[0, 0], [64, 40], [192, 215], [255, 255]] } },
    {
      kind: 'group', name: 'title-block',
      children: [
        { kind: 'type', name: 'headline', text: 'Hello Layered World', x: 120, y: 820, font: 'Inter', size: 120, color: '#f8fafc' },
      ],
    },
  ],
  variants: [{ name: 'warm', appearance: true }],
  delivery: [{ id: 'out', kind: 'raster', path: 'out.png', format: 'png', width: 1920, height: 1080 }],
};
await writeFile(resolve(here, 'recipe.json'), JSON.stringify(recipe, null, 2) + '\n');

// `recipePath` is resolved against the process cwd, so keep it relative to the
// project folder the CLI is launched from.
const job = {
  jobId: 'LF-42',
  readRoot: inDir,
  writeRoot: outDir,
  recipePath: 'jobs/LF-42/recipe.json',
  capture: 'preview',
  replaceSource: null,
};
await writeFile(resolve(here, 'job.local.json'), JSON.stringify(job, null, 2) + '\n');
console.log(`recipe.json + job.local.json ready\n  read root:  ${inDir}\n  write root: ${outDir}`);
