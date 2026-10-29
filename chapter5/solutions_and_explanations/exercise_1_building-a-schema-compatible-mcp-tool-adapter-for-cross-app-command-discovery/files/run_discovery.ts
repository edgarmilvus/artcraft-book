/**
 * Harness for exercise 1: the cross-app discovery adapter.
 *
 * Runs discovery against a real PhotoCraft worker, then checks the three
 * properties the exercise is about — normalized shape, stable versioning,
 * and an immutable diff.
 */
import { strict as assert } from 'node:assert';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';
import {
  ArtCraftDiscoveryAdapter,
  buildCapabilityIndex,
  type AppId,
  type NormalizedTool,
} from './01_solutions_and_explanations.js';

const HERE = import.meta.dirname;
const OUTPUT = path.join(HERE, '..', 'output');
const ROOT = path.join(OUTPUT, 'discovery');
const CATALOG = path.join(ROOT, 'catalog');
rmSync(ROOT, { recursive: true, force: true });
mkdirSync(path.join(ROOT, 'read'), { recursive: true });
mkdirSync(path.join(ROOT, 'write'), { recursive: true });
mkdirSync(CATALOG, { recursive: true });
mkdirSync(path.join(OUTPUT, '.mcp'), { recursive: true });
const APPS: AppId[] = ['photocraft', 'vectorcraft', 'filmcraft', 'effectcraft', 'designcraft', 'lightcraft', 'pdfcraft', 'wordcraft'];
writeFileSync(
  path.join(OUTPUT, '.mcp', 'config.json'),
  JSON.stringify({
    apps: Object.fromEntries(
      APPS.map((a) => [a, { readRoot: path.join(ROOT, 'read'), writeRoot: path.join(ROOT, 'write') }]),
    ),
  }, null, 2) + '\n',
);

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

const adapter = new ArtCraftDiscoveryAdapter(path.join(OUTPUT, '.mcp', 'config.json'));
const app: AppId = 'photocraft';

console.log('discovering photocraft…\n');
const first = await adapter.discover(app);
const tools = first.tools;
const reports: Record<string, { tools: typeof tools; registryVersion: string }> = {
  [app]: first,
};

await check('meta-tools are read from the live registry, not a static table', () => {
  const meta = tools.filter((t) => t._meta.isMetaTool);
  assert.ok(meta.length >= 20, `only ${meta.length} meta-tools`);
  for (const m of meta) {
    assert.equal(m.commandId, null, m.name);
    assert.ok(m.name.startsWith('photocraft_'), m.name);
  }
  const names = new Set(meta.map((m) => m.name));
  for (const n of ['photocraft_command_run', 'photocraft_doc_new', 'photocraft_doc_save']) {
    assert.ok(names.has(n), `${n} missing`);
  }
});

await check("every engine's catalog is discovered with its own naming", async () => {
  const counts: Record<string, number> = {};
  for (const app of APPS) {
    const report = app === 'photocraft' ? first : await adapter.discover(app);
    reports[app] = report;
    counts[app] = report.tools.length;
    assert.ok(report.tools.length > 6, `${app}: only ${report.tools.length} tools`);
    assert.match(report.registryVersion, /^[0-9a-f]{64}$/, app);
  }
  // The meta-tool vocabulary really does differ per app.
  const design = await adapter.discover('designcraft');
  const designNames = new Set(design.tools.map((t) => t.name));
  assert.ok(designNames.has('designcraft_execute'), 'designcraft_execute missing');
  assert.ok(!designNames.has('designcraft_command_run'), 'DesignCraft has no command_run');
  console.log('   catalog sizes:', counts);
});

await check('registry commands are normalized into parameters + commandId', () => {
  const registry = tools.filter((t) => !t._meta.isMetaTool);
  assert.ok(registry.length > 300, `only ${registry.length} registry commands`);
  const typeCreate = registry.find((t) => t.commandId === 'type.create');
  assert.ok(typeCreate, 'type.create missing');
  assert.equal(typeCreate!.name, 'photocraft_type_create');
  assert.equal((typeCreate!.parameters as { type?: string }).type, 'object');
  assert.ok(typeCreate!.description.includes('Location: Layer › New'), typeCreate!.description);
});

await check('command ids are kebab-normalized into tool names', () => {
  const names = new Set(tools.map((t) => t.name));
  for (const n of names) assert.match(n, /^[A-Za-z0-9_]+$/, n);
  assert.ok(names.has('photocraft_layer_new_layer'));
});

await check('registryVersion is a content hash, stable across runs', async () => {
  const second = await adapter.discover(app);
  assert.match(first.registryVersion, /^[0-9a-f]{64}$/);
  assert.equal(second.registryVersion, first.registryVersion);
});

await check('diff of two identical discoveries is empty', () => {
  const patch = adapter.diff(tools, tools);
  assert.equal(patch.added.length, 0);
  assert.equal(patch.removed.length, 0);
  assert.equal(patch.changed.length, 0);
});

await check('diff reports removals without mutating the previous catalog', () => {
  const prev = [...tools];
  const next = tools.filter((t) => t.name !== 'photocraft_type_create');
  const patch = adapter.diff(prev, next as NormalizedTool[]);
  assert.deepEqual(patch.removed, ['photocraft_type_create']);
  assert.equal(prev.length, tools.length, 'previous catalog was mutated');
});

await check('capability index maps every tool back to its app and command', () => {
  const idx = buildCapabilityIndex(tools);
  assert.equal(idx.size, tools.length);
  const entry = idx.get('photocraft_type_create');
  assert.equal(entry?.app, 'photocraft');
  assert.equal(entry?.commandId, 'type.create');
  assert.equal(entry?.transportRequired, 'mcp');
});

// ---- Durable artefacts -------------------------------------------------
for (const app of APPS) {
  writeFileSync(
    path.join(CATALOG, `${app}.json`),
    JSON.stringify(reports[app], null, 2) + '\n',
  );
}
const capabilityIndex = buildCapabilityIndex(tools);
const indexObject = Object.fromEntries(capabilityIndex);
writeFileSync(path.join(ROOT, 'capability-index.json'), JSON.stringify(indexObject, null, 2) + '\n');
const identicalPatch = adapter.diff(tools, tools);
writeFileSync(path.join(ROOT, 'diff-identical.json'), JSON.stringify(identicalPatch, null, 2) + '\n');
writeFileSync(
  path.join(ROOT, 'summary.json'),
  JSON.stringify({
    apps: APPS.map((app) => ({
      app,
      tools: reports[app].tools.length,
      registryVersion: reports[app].registryVersion,
      metaTools: reports[app].tools.filter((t) => t._meta.isMetaTool).length,
    })),
    capabilityIndexEntries: capabilityIndex.size,
    checks: passed + failed,
    failures: failed,
  }, null, 2) + '\n',
);
console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
