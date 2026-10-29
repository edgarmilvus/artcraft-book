// run_ex5.ts — acceptance harness for Chapter 2, Exercise 5.
//
// Rebuilds the bundle fixtures from an empty write root, runs the four-suite
// pipeline, then reopens the PNGs with PhotoCraft and the spec sheet with
// PdfCraft. A failure exits non-zero.
//
// Engine behaviour this harness works around:
//   * none of the four engines creates output directories, so the fixture
//     builders and the pipeline create `imports/`, `templates/`, `spec/`,
//     `hero/`, `work/` and `logs/` before the first write;
//   * DesignCraft and PdfCraft ignore the automation-root flags and resolve
//     relative paths against their process cwd, so both children run with
//     cwd set to the bundle root.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '../../../..');
const OUT = resolve(HERE, '..', 'output');
const ROOT = join(OUT, 'roots');
const CLIS = resolve(REPO, 'tools/craft-cli/bin');
const TSX = resolve(REPO, 'node_modules/.bin/tsx');
const SOLUTION = join(HERE, '05_cross-suite-autonomous-asset-resolution-pipeline-with-sandboxed-file-roots.ts');
const REQUEST = join(HERE, '01_json.json');

const checks: string[] = [];
const failures: string[] = [];
const transcript: string[] = [];
const say = (line = ''): void => { transcript.push(line); console.log(line); };
const check = (label: string, ok: boolean, detail = ''): void => {
  checks.push(label);
  if (!ok) failures.push(label);
  say(`${ok ? ' ok ' : 'FAIL'} ${label.padEnd(62)}${detail}`);
};
const equal = (label: string, actual: unknown, expected: unknown): void =>
  check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

const pngSize = (path: string): { width: number; height: number } | null => {
  if (!existsSync(path)) return null;
  const b = readFileSync(path);
  if (b.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') return null;
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
};
const jpegMagic = (path: string): boolean =>
  existsSync(path) && readFileSync(path).subarray(0, 3).toString('hex').startsWith('ffd8ff');
const pdfMagic = (path: string): boolean =>
  existsSync(path) && readFileSync(path).subarray(0, 5).toString() === '%PDF-';

type Tool = { isError: boolean; data: any; text?: string };
const makeClient = async (command: string, args: string[], cwd?: string) => {
  const client = new Client({ name: 'cap2-exercise5', version: '1.0.0' }, { capabilities: {} });
  await client.connect(new StdioClientTransport({ command, args, cwd }));
  const call = async (name: string, params: Record<string, unknown> = {}): Promise<Tool> => {
    const result: any = await client.callTool({ name, arguments: params });
    const text = result.content?.find((c: any) => c.type === 'text')?.text;
    let data: any; try { data = JSON.parse(text); } catch { data = text; }
    return { isError: Boolean(result.isError), data, text };
  };
  return { client, call };
};

// ── clean slate ─────────────────────────────────────────────────────────────
for (const stale of ['roots', 'run-log.json', 'run_ex5.log', 'fixtures.log', 'pipeline.log']) {
  rmSync(join(OUT, stale), { recursive: true, force: true });
}
mkdirSync(join(ROOT, 'imports'), { recursive: true });

const env = {
  ...process.env,
  PATH: `${CLIS}:${process.env.PATH ?? ''}`,
  READ_ROOT: ROOT,
  WRITE_ROOT: ROOT,
  REQUEST_JSON: REQUEST,
};

// ── fixtures ────────────────────────────────────────────────────────────────
const photos = spawnSync('node', ['make-photos.mjs', ROOT], { cwd: HERE, env, encoding: 'utf8', timeout: 180_000 });
const bundles = spawnSync('node', ['make-bundle-fixtures.mjs', ROOT], { cwd: HERE, env, encoding: 'utf8', timeout: 180_000 });
writeFileSync(join(OUT, 'fixtures.log'), [photos.stdout, photos.stderr, bundles.stdout, bundles.stderr].join('\n'));
equal('photo fixture builder exits cleanly', photos.status, 0);
equal('template/PDF fixture builder exits cleanly', bundles.status, 0);

for (const name of ['ochre', 'walnut', 'sage']) {
  const jpg = join(ROOT, 'imports', `velvet_${name}.jpg`);
  check(`source photo ${name} exists`, existsSync(jpg), existsSync(jpg) ? `${statSync(jpg).size} bytes` : 'missing');
  check(`source photo ${name} is a JPEG`, jpegMagic(jpg));
  const xmp = join(ROOT, 'imports', `velvet_${name}.jpg.xmp`);
  check(`XMP sidecar ${name} exists`, existsSync(xmp));
  if (existsSync(xmp)) {
    const text = readFileSync(xmp, 'utf8');
    check(`XMP sidecar ${name} carries a rating`, /xmp:Rating="[0-9]"/.test(text));
    check(`XMP sidecar ${name} carries a colour label`, /xmp:Label="[^"]+"/.test(text));
  }
}
const ochreXmp = readFileSync(join(ROOT, 'imports', 'velvet_ochre.jpg.xmp'), 'utf8');
check('ochre is rated highest', /xmp:Rating="4"/.test(ochreXmp));
check('ochre carries the brief keywords', /velvet-chair/.test(ochreXmp) && /studio-shot/.test(ochreXmp));
check('design template exists', existsSync(join(ROOT, 'templates', 'hero_furniture.designcraft')),
  existsSync(join(ROOT, 'templates', 'hero_furniture.designcraft')) ? `${statSync(join(ROOT, 'templates', 'hero_furniture.designcraft')).size} bytes` : 'missing');
check('PDF boilerplate exists', pdfMagic(join(ROOT, 'spec', 'FW26_spec_boilerplate.pdf')));
check('PDF boilerplate is non-trivial', existsSync(join(ROOT, 'spec', 'FW26_spec_boilerplate.pdf'))
  && statSync(join(ROOT, 'spec', 'FW26_spec_boilerplate.pdf')).size > 1000);

// ── pipeline ────────────────────────────────────────────────────────────────
const run = spawnSync(TSX, [SOLUTION], { cwd: HERE, env, encoding: 'utf8', timeout: 300_000 });
writeFileSync(join(OUT, 'pipeline.log'), `${run.stdout ?? ''}${run.stderr ?? ''}`);
equal('pipeline exits cleanly', run.status, 0);
check('pipeline printed no stack trace', !/Error:|at .*\.ts:[0-9]+:[0-9]+/.test(run.stderr ?? ''), (run.stderr ?? '').slice(0, 120));
check('pipeline reports the fallback tier', /used fallback/i.test(run.stderr ?? ''), (run.stderr ?? '').slice(0, 120));
const passLines = (run.stdout ?? '').split('\n').filter((l) => l.startsWith('PASS ') || l.startsWith('FAIL '));
equal('pipeline runs its four self-checks', passLines.length, 4);
check('pipeline self-checks all pass', passLines.every((l) => l.startsWith('PASS ')), passLines.join(' | '));

const firstBrace = (run.stdout ?? '').indexOf('{');
const lastBrace = (run.stdout ?? '').lastIndexOf('}');
check('pipeline emits a JSON report', firstBrace >= 0 && lastBrace > firstBrace);
const report = firstBrace >= 0 ? JSON.parse((run.stdout ?? '').slice(firstBrace, lastBrace + 1)) : {};

// ── report contract ────────────────────────────────────────────────────────
equal('report is ok', report.ok, true);
equal('selected photo', report.selected_photo, 1);
equal('fallback tier was used', report.used_fallback, true);
equal('PhotoCraft document index', report.photocraft_doc, 0);
equal('report names the transaction log', report.txn_log, 'logs/bundle-2607_txn.jsonl');
const outputs = report.outputs ?? {};
equal('wide hero path', outputs.hero_wide, 'hero/hero_1920x1080.png');
equal('square hero path', outputs.hero_square, 'hero/hero_1080x1080.png');
equal('spec sheet path', outputs.spec_sheet, 'spec/FW26_VelvetChair_spec.pdf');
const relPaths = [outputs.hero_wide, outputs.hero_square, outputs.spec_sheet, report.txn_log].filter(Boolean);
check('every reported path is relative', relPaths.every((p: string) => !p.startsWith('/') && !/^[A-Za-z]:/.test(p)));
check('no reported path escapes the root', relPaths.every((p: string) => !p.split('/').includes('..')));
check('every reported output exists under the root',
  [outputs.hero_wide, outputs.hero_square, outputs.spec_sheet].every((p: string) => existsSync(join(ROOT, p))));

const wide = pngSize(join(ROOT, outputs.hero_wide ?? ''));
const square = pngSize(join(ROOT, outputs.hero_square ?? ''));
equal('wide hero is 1920x1080', wide ? `${wide.width}x${wide.height}` : null, '1920x1080');
equal('square hero is 1080x1080', square ? `${square.width}x${square.height}` : null, '1080x1080');
check('spec sheet is a PDF', pdfMagic(join(ROOT, outputs.spec_sheet ?? '')));
check('spec sheet is non-trivial', existsSync(join(ROOT, outputs.spec_sheet ?? ''))
  && statSync(join(ROOT, outputs.spec_sheet ?? '')).size > 1000);
check('conditioned source was staged', existsSync(join(ROOT, 'work', `hero_source_${report.selected_photo}.jpg`)));

// ── transaction log ────────────────────────────────────────────────────────
const txnPath = join(ROOT, 'logs/bundle-2607_txn.jsonl');
check('transaction log exists', existsSync(txnPath), existsSync(txnPath) ? `${statSync(txnPath).size} bytes` : 'missing');
const txn = existsSync(txnPath)
  ? readFileSync(txnPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
  : [];
equal('four suites reached', new Set(txn.map((t: any) => t.suite)).size, 4);
equal('first step is the LightCraft export', txn[0]?.suite, 'lightcraft');
equal('last step is the PdfCraft save', txn[txn.length - 1]?.command, 'doc_save');
equal('last suite is PdfCraft', txn[txn.length - 1]?.suite, 'pdfcraft');
const expectedCommands = [
  ['lightcraft', 'export'],
  ['photocraft', 'command_batch'],
  ['photocraft', 'doc_save'],
  ['designcraft', 'open_document'],
  ['designcraft', 'layout.documentSetup'],
  ['designcraft', 'place_image'],
  ['designcraft', 'frame.create'],
  ['designcraft', 'text.insert'],
  ['designcraft', 'export_png'],
  ['designcraft', 'layout.documentSetup'],
  ['designcraft', 'export_png'],
  ['pdfcraft', 'form_fill'],
  ['pdfcraft', 'doc_set_info'],
  ['pdfcraft', 'doc_save'],
];
check('every mutating step is logged in order',
  JSON.stringify(txn.map((t: any) => `${t.suite}:${t.command}`)) ===
    JSON.stringify(expectedCommands.map(([s, c]) => `${s}:${c}`)),
  txn.map((t: any) => `${t.suite}:${t.command}`).join(', '));
check('every record carries the four contract fields',
  txn.every((t: any) => typeof t.suite === 'string' && typeof t.command === 'string'
    && (typeof t.doc_id === 'string' || typeof t.doc_id === 'number') && typeof t.reversible === 'boolean'));
check('the log records reversible and irreversible steps',
  txn.some((t: any) => t.reversible === true) && txn.some((t: any) => t.reversible === false));
check('design paths are recorded relative to the root',
  txn.filter((t: any) => t.suite === 'designcraft' && typeof t.doc_id === 'string')
    .every((t: any) => !t.doc_id.startsWith('/') && !t.doc_id.split('/').includes('..')));
equal('one LightCraft export record', txn.filter((t: any) => t.suite === 'lightcraft').length, 1);
equal('two PhotoCraft records', txn.filter((t: any) => t.suite === 'photocraft').length, 2);
equal('eight DesignCraft records', txn.filter((t: any) => t.suite === 'designcraft').length, 8);
equal('three PdfCraft records', txn.filter((t: any) => t.suite === 'pdfcraft').length, 3);
check('the spec save is not reversible', txn.filter((t: any) => t.suite === 'pdfcraft' && t.command === 'doc_save')
  .every((t: any) => t.reversible === false));

// ── reopen the artefacts with their own engines ────────────────────────────
const { client: pc, call: pcCall } = await makeClient(join(CLIS, 'photocraft-cli'),
  ['mcp', '--automation-read-root', ROOT, '--automation-write-root', ROOT]);
try {
  for (const [label, rel, want] of [
    ['wide hero', outputs.hero_wide, '1920x1080'],
    ['square hero', outputs.hero_square, '1080x1080'],
  ] as const) {
    const opened = await pcCall('doc_open', { path: rel });
    check(`${label} reopens in PhotoCraft`, !opened.isError, String(opened.data?.width));
    const inspected = await pcCall('doc_inspect');
    equal(`${label} engine width`, inspected.data?.width, Number(want.split('x')[0]));
    equal(`${label} engine height`, inspected.data?.height, Number(want.split('x')[1]));
    equal(`${label} is a flat composite`, inspected.data?.layers?.length, 1);
    await pcCall('doc_close', {});
  }
} finally {
  await pc.close();
}

const { client: pdf, call: pdfCall } = await makeClient(join(CLIS, 'pdfcraft-cli'), ['mcp'], ROOT);
try {
  const opened = await pdfCall('doc_open', { path: outputs.spec_sheet });
  check('spec sheet reopens in PdfCraft', !opened.isError, String(opened.data?.pages));
  const docId = opened.data?.doc ?? opened.data?.id ?? 1;
  equal('spec sheet is one page', opened.data?.pages, 1);
  const fields = await pdfCall('form_fields', { doc: docId });
  equal('three filled form fields', fields.data?.count, 3);
  const values = Object.fromEntries((fields.data?.fields ?? []).map((f: any) => [f.name, f.value]));
  equal('product field is filled', values.Product, 'Velvet Chair');
  equal('CTA field is filled', values.CTA, 'Save 25% This Week');
  equal('price field is filled', values.Price, 'USD 1199');
  const text = await pdfCall('text_extract', { doc: docId });
  const extracted = (text.data?.pages ?? []).map((p: any) => p.text).join('\n');
  for (const needle of ['Velvet Chair', 'Save 25% This Week', 'USD 1199']) {
    check(`PDF text contains "${needle}"`, extracted.includes(needle));
  }
  await pdfCall('doc_close', { doc: docId });
} finally {
  await pdf.close();
}

// ── summary ────────────────────────────────────────────────────────────────
say();
say(`${checks.length} checks, ${failures.length} failing; artefacts in ${OUT}`);
writeFileSync(join(OUT, 'run-log.json'), JSON.stringify({
  checks: checks.length,
  failures,
  quirks: [
    'DesignCraft takes no root flag and PdfCraft uses --root; both resolve relative paths against the process cwd',
    'none of the four engines creates output directories; the pipeline and the fixture builders create them up front',
    'the primary tier requires the "pick" flag, so a rating-4 photo without that flag resolves through the fallback tier',
  ],
  report,
  txn: txn.length,
}, null, 2));
writeFileSync(join(OUT, 'run_ex5.log'), `${transcript.join('\n')}\n`);
if (failures.length > 0) process.exitCode = 1;
