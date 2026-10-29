// run_ex2.ts — acceptance harness for Chapter 2, Exercise 2.
//
// Runs the dual-compositor parity audit against the real PhotoCraft engine,
// then reopens the saved artefacts with a second engine session and checks
// the report against the pixels that were actually written.
//
//   npx tsx run_ex2.ts
//
// Engine behaviour this harness works around:
//   * `doc_save` does not create parent directories, so the audit directory
//     is created before the reference PNG / round-trip master are saved.
//   * the headless CLI composites with the CPU SIMD oracle only; the wgpu
//     pipeline needs the desktop binary. The audit therefore compares the
//     same model at two resolutions, and says so in its notes.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const OUT = resolve(HERE, '..', 'output');
const AUDIT = join(OUT, 'audit');
const CLIS = resolve(REPO, 'tools/craft-cli/bin');
const TSX = resolve(REPO, 'node_modules/.bin/tsx');
const SOLUTION = join(HERE, '02_dual-compositor-parity-audit-between-cpu-oracle-and-gpu-pipelines.ts');

for (const stale of ['audit', 'run-log.json', 'run_ex2.log']) {
  rmSync(join(OUT, stale), { recursive: true, force: true });
}
mkdirSync(AUDIT, { recursive: true });

const transcript: string[] = [];
const say = (line: string): void => {
  transcript.push(line);
  console.log(line);
};
let checks = 0;
const failures: string[] = [];
const quirks: string[] = [
  'doc_save does not create missing parent directories; the audit directory is created before the first save',
  'the headless CLI has only the CPU SIMD oracle; the wgpu compositor requires the desktop app, so the audit compares one model at two resolutions',
];
const check = (label: string, condition: boolean, detail = ''): void => {
  checks += 1;
  if (!condition) failures.push(label);
  say(`${condition ? ' ok ' : 'FAIL'} ${label.padEnd(56)}${detail}`);
};
const equal = (label: string, actual: unknown, expected: unknown): void =>
  check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const pngSize = (path: string): { width: number; height: number } => {
  const b = readFileSync(path);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};
const pngMagic = (path: string): boolean =>
  readFileSync(path).subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

// ── MCP plumbing (used only to reopen the saved artefacts) ───────────────────
type ToolResult = { isError: boolean; text?: string; data: any };
const mcp = new Client({ name: 'cap2-exercise2', version: '1.0.0' }, { capabilities: {} });
await mcp.connect(new StdioClientTransport({
  command: join(CLIS, 'photocraft-cli'),
  args: ['mcp', '--automation-read-root', OUT, '--automation-write-root', OUT],
}));
const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
  const result: any = await mcp.callTool({ name, arguments: args });
  const text = result.content?.find((c: any) => c.type === 'text')?.text;
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { isError: Boolean(result.isError), text, data };
};

try {
  // ── run the audit ─────────────────────────────────────────────────────────
  const run = spawnSync(TSX, [SOLUTION], {
    cwd: HERE,
    encoding: 'utf8',
    timeout: 300_000,
    env: {
      ...process.env,
      READ_ROOT: OUT,
      WRITE_ROOT: OUT,
      PATH: `${CLIS}:${process.env.PATH ?? ''}`,
    },
  });
  writeFileSync(join(OUT, 'audit.stdout.log'), `${run.stdout ?? ''}${run.stderr ?? ''}`);
  check('audit process exits cleanly', run.status === 0, `status ${run.status}`);
  check('audit did not print a stack trace', !/Error:|TransformError/.test(run.stderr ?? ''), (run.stderr ?? '').slice(0, 120));

  const summaryLine = (run.stdout ?? '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
  check('audit prints a JSON summary', Boolean(summaryLine), summaryLine ?? '');
  const summary = summaryLine ? JSON.parse(summaryLine) : {};

  // ── report structure ─────────────────────────────────────────────────────
  const reportPath = join(AUDIT, 'parity_report.json');
  check('parity report exists', existsSync(reportPath), `${existsSync(reportPath) ? statSync(reportPath).size : 0} bytes`);
  const report = JSON.parse(readFileSync(reportPath, 'utf8'));
  equal('report names the audit', report.audit, 'dual_compositor_parity');
  equal('report is convergent', report.convergent, true);
  equal('epsilon is the contract value', report.epsilon, 0.75);
  check('report timestamp parses', !Number.isNaN(Date.parse(report.generated_at)), report.generated_at);

  // ── canvas and tile geometry ─────────────────────────────────────────────
  equal('canvas width', report.canvas?.width, 2600);
  equal('canvas height', report.canvas?.height, 1600);
  equal('canvas is RGB', report.canvas?.mode, 'rgb');
  equal('canvas is 16-bit', report.canvas?.depth, 16);
  equal('tile size', report.tile?.size, 256);
  equal('tile columns', report.tile?.columns, Math.ceil(2600 / 256));
  equal('tile rows', report.tile?.rows, Math.ceil(1600 / 256));
  equal('every tile is reported once', report.tile_deltas?.length, 11 * 7);
  const tileKeys = new Set(report.tile_deltas.map((t: any) => `${t.tx},${t.ty}`));
  equal('tile coordinates are unique', tileKeys.size, 11 * 7);
  const inRange = report.tile_deltas.every((t: any) =>
    Number.isInteger(t.tx) && Number.isInteger(t.ty) &&
    t.tx >= 0 && t.tx < 11 && t.ty >= 0 && t.ty < 7 &&
    ['r', 'g', 'b', 'a'].every((k) => Number.isFinite(t.meanDelta?.[k]) &&
      t.meanDelta[k] >= 0 && t.meanDelta[k] <= 255));
  check('tile deltas are finite and in range', inRange);

  // ── parity measurements ─────────────────────────────────────────────────
  equal('no tile is flagged', report.tile_deltas.filter((t: any) => t.flagged).length, 0);
  equal('summary agrees on convergence', summary.convergent, true);
  equal('summary agrees on flagged tiles', summary.flagged_tiles, 0);
  const recomputedMax = report.tile_deltas.reduce((m: number, t: any) =>
    Math.max(m, t.meanDelta.r, t.meanDelta.g, t.meanDelta.b, t.meanDelta.a), 0);
  check('max_mean_delta is the maximum tile channel delta',
    Math.abs(report.max_mean_delta - recomputedMax) < 1e-9,
    `${report.max_mean_delta} vs ${recomputedMax}`);
  check('max_mean_delta stays under epsilon', report.max_mean_delta < report.epsilon,
    `${report.max_mean_delta} < ${report.epsilon}`);
  equal('summary repeats max_mean_delta', summary.max_mean_delta, report.max_mean_delta);

  // ── samples and determinism ─────────────────────────────────────────────
  equal('16 grid samples + 12 boundary samples', report.grid_samples?.length, 28);
  const gridKeys = new Set(report.grid_samples.map((s: any) => `${s.x},${s.y}`));
  equal('grid sample coordinates are unique', gridKeys.size, 28);
  check('grid samples are inside the canvas',
    report.grid_samples.every((s: any) => s.x >= 0 && s.x < 2600 && s.y >= 0 && s.y < 1600));
  check('grid samples carry RGBA in range',
    report.grid_samples.every((s: any) => ['r', 'g', 'b', 'a'].every((k) =>
      Number.isFinite(s.px?.[k]) && s.px[k] >= 0 && s.px[k] <= 255)));
  equal('save/load is deterministic', report.determinism_drift?.length, 0);

  // ── batch and dimensions ────────────────────────────────────────────────
  equal('effect batch completed', report.batch?.completed, 6);
  equal('effect batch failed steps', report.batch?.failed, 0);
  equal('effect batch failure list', report.batch?.failures?.length, 0);
  equal('preview is bounded to 2048 wide', report.preview_dimensions?.width, 2048);
  equal('preview keeps the aspect ratio', report.preview_dimensions?.height, 1260);
  equal('reference is full resolution', `${report.reference_dimensions?.width}x${report.reference_dimensions?.height}`, '2600x1600');

  // ── notes state the pipeline truth ──────────────────────────────────────
  equal('report carries three notes', report.notes?.length, 3);
  const notes = (report.notes ?? []).join(' ');
  check('notes reject ui_screenshot as a reference', /ui_screenshot was NOT used/i.test(notes));
  check('notes explain the 16-bit canvas', /16-bit/i.test(notes));
  check('notes explain the 256-px tile grid', /256-px geometry/i.test(notes));
  check('stdout never mentions ui_screenshot calls', !/ui\.screenshot/i.test(run.stdout ?? ''));

  // ── files on disk ───────────────────────────────────────────────────────
  const referencePath = join(AUDIT, 'parity_reference.png');
  const roundtripPath = join(AUDIT, 'parity_roundtrip.pcraft');
  check('reference PNG exists', existsSync(referencePath), `${existsSync(referencePath) ? statSync(referencePath).size : 0} bytes`);
  check('reference PNG magic', existsSync(referencePath) && pngMagic(referencePath));
  if (existsSync(referencePath)) {
    const size = pngSize(referencePath);
    equal('reference PNG is 2600x1600', `${size.width}x${size.height}`, '2600x1600');
  }
  check('round-trip master exists', existsSync(roundtripPath), `${existsSync(roundtripPath) ? statSync(roundtripPath).size : 0} bytes`);
  check('round-trip master is non-trivial', existsSync(roundtripPath) && statSync(roundtripPath).size > 50_000);

  // ── reopen both artefacts with a fresh engine session ──────────────────
  const openMaster = await call('doc_open', { path: 'audit/parity_roundtrip.pcraft' });
  check('round-trip master reopens', !openMaster.isError && Boolean(openMaster.data?.width), String(openMaster.data?.width));
  const masterInspect = await call('doc_inspect');
  equal('master keeps canvas width', masterInspect.data?.width, 2600);
  equal('master keeps canvas height', masterInspect.data?.height, 1600);
  equal('master keeps 16-bit depth', masterInspect.data?.depth, 16);
  equal('master keeps the five-layer stack', masterInspect.data?.layers?.length, 5);
  check('master layer kinds match the audit stack',
    (masterInspect.data?.layers ?? []).filter((l: any) => String(l.kind).includes('Adjustment')).length >= 3,
    (masterInspect.data?.layers ?? []).map((l: any) => l.kind).join(','));
  await call('doc_close', {});

  const openReference = await call('doc_open', { path: 'audit/parity_reference.png' });
  check('reference PNG reopens', !openReference.isError && Boolean(openReference.data?.width), String(openReference.data?.width));
  const referenceInspect = await call('doc_inspect');
  equal('reference document is 2600 wide', referenceInspect.data?.width, 2600);
  equal('reference document is 1600 tall', referenceInspect.data?.height, 1600);
  equal('reference has one flat pixel layer', referenceInspect.data?.layers?.length, 1);
  equal('reference layer is a Pixel layer', referenceInspect.data?.layers?.[0]?.kind, 'Pixel');
  const oob = await call('command_run', { id: 'document.pixel', params: { x: 1200, y: 2048 } });
  if (!oob.isError) {
    quirks.push('document.pixel clamps out-of-range coordinates instead of rejecting them (y=2048 on a 1600-tall canvas returned a pixel)');
  }
  await call('doc_close', {});

  writeFileSync(join(OUT, 'run-log.json'), JSON.stringify({
    checks,
    failures,
    quirks,
    report: {
      convergent: report.convergent,
      max_mean_delta: report.max_mean_delta,
      tiles: report.tile_deltas.length,
      batch: report.batch,
    },
  }, null, 2));
  say('');
  say(`${checks} checks, ${failures.length} failing; ${quirks.length} engine quirk(s); artefacts in ${OUT}`);
  writeFileSync(join(OUT, 'run_ex2.log'), `${transcript.join('\n')}\n`);
  if (failures.length > 0) process.exitCode = 1;
} catch (error) {
  say(`FAIL harness crashed: ${error instanceof Error ? error.stack : String(error)}`);
  writeFileSync(join(OUT, 'run_ex2.log'), `${transcript.join('\n')}\n`);
  process.exitCode = 1;
} finally {
  await mcp.close();
}
