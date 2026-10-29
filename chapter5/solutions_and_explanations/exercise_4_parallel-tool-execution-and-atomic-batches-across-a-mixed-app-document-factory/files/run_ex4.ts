/**
 * Acceptance harness for Chapter 5 Exercise 4.
 *
 * Builds the mixed-app pipeline from an issue manifest, checks every command
 * against the real engine registries, plans compensation for a simulated
 * failure, and writes the graph, execution waves and rollback plan under
 * ../output/.
 */
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import {
  ManifestDagBuilder,
  ReverseTopologicalPlanner,
  type AppId,
  type IssueManifest,
  type Pipeline,
} from './04_parallel-tool-execution-and-atomic-batches-across-a-mixed-app-document-factory.js';

const HERE = import.meta.dirname;
const OUT = path.join(HERE, '..', 'output');
rmSync(path.join(OUT, 'pipeline.json'), { force: true });
rmSync(path.join(OUT, 'compensation-plan.json'), { force: true });
mkdirSync(OUT, { recursive: true });

const builder = new ManifestDagBuilder();
const planner = new ReverseTopologicalPlanner();

const manifest: IssueManifest = {
  issue: '2026-W14',
  sources: {
    layout: '/in/catalog.designcraft',
    editorial: '/in/editorial.docx',
    influencerPages: [3, 7],
  },
  artifacts: ['print_pdf', 'web_pdf', 'word_master', 'interactive_redacted_pdf'],
  depends: {
    print_pdf: [],
    web_pdf: ['print_pdf'],
    word_master: [],
    interactive_redacted_pdf: ['print_pdf'],
  },
  houseStyle: { titleColor: '#0f766e', accentColor: '#f59e0b' },
};

const pipeline = builder.build(manifest, 'pipe-01', 'corr-01');

let passed = 0;
let failed = 0;
const results: Array<{ name: string; ok: boolean; error?: string }> = [];
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    results.push({ name, ok: true });
    console.log(`PASS ${name}`);
  } catch (err) {
    failed += 1;
    results.push({ name, ok: false, error: err instanceof Error ? err.message : String(err) });
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

const registryCache = new Map<AppId, Set<string>>();
function registry(app: AppId): Set<string> {
  const cached = registryCache.get(app);
  if (cached) return cached;
  let items: Set<string>;
  if (app === 'designcraft') {
    const raw = JSON.parse(execFileSync('designcraft-cli', ['commands'], { encoding: 'utf8' })) as Array<{ id: string }>;
    items = new Set(raw.map((c) => c.id));
  } else if (app === 'pdfcraft') {
    const raw = JSON.parse(execFileSync('pdfcraft-cli', ['tools'], { encoding: 'utf8' })) as Array<{ name: string }>;
    items = new Set(raw.map((t) => t.name));
  } else if (app === 'wordcraft') {
    const raw = JSON.parse(execFileSync('wordcraft-cli', ['commands', '--json'], { encoding: 'utf8' })) as Array<{ id: string }>;
    items = new Set(raw.map((c) => c.id));
  } else {
    throw new Error(`no registry probe for ${app}`);
  }
  registryCache.set(app, items);
  return items;
}

async function mcpTools(app: AppId, binary: string): Promise<Set<string>> {
  const client = new Client({ name: `registry-${app}`, version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command: binary, args: ['mcp'] }));
  const { tools } = await client.listTools();
  await client.close();
  return new Set(tools.map((t) => t.name));
}

const wordcraftTools = await mcpTools('wordcraft', 'wordcraft-cli');

function hasCommand(app: AppId, command: string): boolean {
  if (app === 'wordcraft' && wordcraftTools.has(command)) return true;
  return registry(app).has(command);
}

function graphDepth(nodes: readonly Pipeline['nodes'][number][]): Map<string, number> {
  const depth = new Map<string, number>();
  const byId = new Map(nodes.map((n) => [n.nodeId, n] as const));
  const visit = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const node = byId.get(id)!;
    const d = node.dependsOn.length === 0
      ? 0
      : 1 + Math.max(...node.dependsOn.map(visit));
    depth.set(id, d);
    return d;
  };
  for (const node of nodes) visit(node.nodeId);
  return depth;
}

console.log('pipeline\n');

await check('manifest produces the four artifacts plus the HTML extra', () => {
  const ids = pipeline.nodes.map((n) => n.nodeId);
  for (const id of ['print_pdf', 'web_pdf', 'web_html', 'wc_save', 'pc_save']) {
    assert.ok(ids.includes(id), `${id} missing`);
  }
  assert.equal(pipeline.correlationId, 'corr-01');
});

await check('every node names a command its engine actually exposes', () => {
  for (const node of pipeline.nodes) {
    assert.ok(hasCommand(node.app, node.command), `${node.nodeId}: ${node.app} has no "${node.command}"`);
    if (node.compensateWith) {
      assert.ok(
        hasCommand(node.app, node.compensateWith.command),
        `${node.nodeId}: compensation "${node.compensateWith.command}" unknown to ${node.app}`,
      );
    }
  }
});

await check('dependencies exist and form an acyclic graph', () => {
  const byId = new Map(pipeline.nodes.map((n) => [n.nodeId, n]));
  for (const node of pipeline.nodes) {
    for (const dep of node.dependsOn) assert.ok(byId.has(dep), `${node.nodeId} -> missing ${dep}`);
  }
  const state = new Map<string, 0 | 1 | 2>();
  const visit = (id: string): void => {
    if (state.get(id) === 1) throw new Error(`cycle at ${id}`);
    if (state.get(id) === 2) return;
    state.set(id, 1);
    for (const dep of byId.get(id)!.dependsOn) visit(dep);
    state.set(id, 2);
  };
  for (const node of pipeline.nodes) visit(node.nodeId);
});

await check('the three branches only meet where the manifest says they do', () => {
  const byId = new Map(pipeline.nodes.map((n) => [n.nodeId, n]));
  assert.deepEqual(byId.get('print_pdf')!.dependsOn, ['dc_type']);
  assert.deepEqual(byId.get('web_pdf')!.dependsOn, ['dc_type']);
  assert.deepEqual(byId.get('pc_open')!.dependsOn, ['print_pdf'], 'PdfCraft must consume the print PDF');
  assert.deepEqual(byId.get('wc_open')!.dependsOn, [], 'WordCraft branch must be independent');
});

await check('build is deterministic', () => {
  const again = builder.build(manifest, 'pipe-01', 'corr-01');
  assert.deepEqual(
    again.nodes.map((n) => [n.nodeId, n.dependsOn]),
    pipeline.nodes.map((n) => [n.nodeId, n.dependsOn]),
  );
});

const depth = graphDepth([...pipeline.nodes]);
const executionWaves = [...new Set(depth.values())]
  .sort((a, b) => a - b)
  .map((d) => pipeline.nodes.filter((n) => depth.get(n.nodeId) === d).map((n) => n.nodeId));

await check('execution waves preserve dependencies and start both roots together', () => {
  assert.deepEqual(executionWaves[0], ['dc_open', 'wc_open']);
  const waveOf = new Map<string, number>();
  executionWaves.forEach((wave, i) => wave.forEach((id) => waveOf.set(id, i)));
  for (const node of pipeline.nodes) {
    for (const dep of node.dependsOn) {
      assert.ok((waveOf.get(dep) ?? -1) < (waveOf.get(node.nodeId) ?? -1),
        `${node.nodeId} scheduled before dependency ${dep}`);
    }
  }
});

console.log('\ncompensation\n');

const resolved = new Map(
  pipeline.nodes
    .filter((n) => n.nodeId !== 'pc_a11y_check' && n.nodeId !== 'pc_save')
    .map((n) => [n.nodeId, { ok: true }] as const),
);

const plan = planner.plan(pipeline, resolved, ['pc_a11y_check']);
const compensated = plan.waves.flat().map((s) => s.nodeId);

await check('compensation runs deepest-first in sequential waves', () => {
  assert.ok(plan.waves.length >= 2, `waves=${plan.waves.length}`);
  let previous = Number.POSITIVE_INFINITY;
  for (const wave of plan.waves) {
    const depths = wave.map((s) => depth.get(s.nodeId) ?? 0);
    assert.ok(Math.max(...depths) <= previous, 'waves out of order');
    previous = Math.min(...depths);
  }
});

await check('exports are reported as irreversible, not silently compensated', () => {
  for (const id of ['print_pdf', 'web_pdf', 'web_html', 'wc_save']) {
    assert.ok(plan.irreversible.includes(id), `${id} should be irreversible`);
    assert.ok(!compensated.includes(id), `${id} must not be compensated`);
  }
});

await check('reversible edits are compensated, failed node and never-run nodes are not', () => {
  for (const id of ['dc_frame', 'dc_type', 'wc_apply_style', 'pc_redact_mark', 'pc_redact_apply']) {
    assert.ok(compensated.includes(id), `${id} missing from the plan`);
  }
  assert.ok(!compensated.includes('pc_a11y_check'), 'failed node must not be compensated');
  assert.ok(!compensated.includes('pc_save'), 'never-run node must not be compensated');
});

await check('native-atomic nodes are skipped: the app already rolled back', () => {
  const synthetic: Pipeline = {
    pipelineId: 'p',
    correlationId: 'c',
    nodes: [
      { nodeId: 'fx', app: 'effectcraft', command: 'batch', params: {},
        dependsOn: [], compensateWith: { command: 'edit.undo', params: {} }, nativeAtomic: true },
    ],
  };
  const p = planner.plan(synthetic, new Map([['fx', {}]]), []);
  assert.deepEqual(p.waves, []);
  assert.deepEqual(p.irreversible, []);
});

const registryProof = Object.fromEntries(
  pipeline.nodes.map((node) => [
    node.nodeId,
    {
      app: node.app,
      command: node.command,
      exposed: hasCommand(node.app, node.command),
      compensation: node.compensateWith
        ? {
            command: node.compensateWith.command,
            exposed: hasCommand(node.app, node.compensateWith.command),
          }
        : null,
    },
  ]),
);

const dot = [
  'digraph issue_pipeline {',
  '  rankdir=LR;',
  ...pipeline.nodes.map((n) => `  "${n.nodeId}" [label="${n.nodeId}\\n${n.app}\\n${n.command}"];`),
  ...pipeline.nodes.flatMap((n) => n.dependsOn.map((dep) => `  "${dep}" -> "${n.nodeId}";`)),
  '}',
  '',
].join('\n');

writeFileSync(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
writeFileSync(path.join(OUT, 'pipeline.json'), JSON.stringify(pipeline, null, 2) + '\n');
writeFileSync(path.join(OUT, 'execution-waves.json'), JSON.stringify(executionWaves, null, 2) + '\n');
writeFileSync(path.join(OUT, 'compensation-plan.json'), JSON.stringify(plan, null, 2) + '\n');
writeFileSync(path.join(OUT, 'registry-proof.json'), JSON.stringify(registryProof, null, 2) + '\n');
writeFileSync(path.join(OUT, 'pipeline.dot'), dot);

await check('graph, waves and compensation plan were written as inspectable artifacts', () => {
  const pipelineFile = JSON.parse(readFileSync(path.join(OUT, 'pipeline.json'), 'utf8')) as Pipeline;
  assert.equal(pipelineFile.nodes.length, pipeline.nodes.length);
  assert.equal(executionWaves.flat().length, pipeline.nodes.length);
  assert.ok(plan.waves.length > 0);
});

const report = {
  exercise: 4,
  checks: passed + failed,
  passed,
  failed,
  results,
  pipelineId: pipeline.pipelineId,
  correlationId: pipeline.correlationId,
  nodes: pipeline.nodes.length,
  executionWaves,
  compensationWaves: plan.waves,
  irreversible: plan.irreversible,
  artifacts: [
    'manifest.json',
    'pipeline.json',
    'execution-waves.json',
    'compensation-plan.json',
    'registry-proof.json',
    'pipeline.dot',
    'report.json',
  ],
};
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
