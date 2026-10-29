// run_photocraft.mjs — Chapter 1, Exercise 1 "The Disposable Banner Autopsy".
//
// Executes the chapter's Solutions and Explanations assembly against a real
// `photocraft-cli mcp` session and checks the document it produces:
//
//   node run_photocraft.mjs
//
// Engine behaviour this harness depends on (forced by the real MCP server):
//   * `file.placeEmbedded` is disabled under automation, so the flat PNG is
//     ingested with the `doc_place` meta-tool (still a Smart Object).
//   * `$N.layer` expands in a command's own `layer` field but not in
//     `layer.moveTo.target`, so every target below is a real id resolved
//     before the batch.
//   * the engine does not create missing directories, so `banners/` is made
//     before `doc_save` writes into it.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.env.RUN_OUTPUT ?? resolve(here, '..', 'output');
const banners = resolve(outDir, 'banners');

// Each run starts from an empty set of artefacts, so a stale document from an
// earlier run can never be mistaken for this run's output.
for (const stale of [
  'banners', 'banner-base.png', 'banner-warm.png',
  'inspect-base.json', 'inspect-warm.json', 'run-log.json',
  'flash-sale-base.pcraft', 'flash-sale-warm.pcraft',
]) {
  rmSync(resolve(outDir, stale), { recursive: true, force: true });
}
await mkdir(banners, { recursive: true });

const BASE_PATH = 'banners/flash-sale-base.pcraft';
const WARM_PATH = 'banners/flash-sale-warm.pcraft';

const transport = new StdioClientTransport({
  command: process.env.PHOTOCRAFT_BIN ?? 'photocraft-cli',
  args: ['mcp', '--automation-read-root', here, '--automation-write-root', outDir],
});
const mcp = new Client({ name: 'cap1-exercise1', version: '1.0.0' }, { capabilities: {} });
await mcp.connect(transport);

const call = async (name, args = {}) => {
  const r = await mcp.callTool({ name, arguments: args });
  const text = r.content?.find((c) => c.type === 'text')?.text;
  const images = r.content?.filter((c) => c.type === 'image') ?? [];
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { isError: r.isError, text, data, images };
};
const run = (id, params) => call('command_run', { id, params });

let checks = 0;
const failures = [];
const record = (label, ok, detail = '') => {
  checks += 1;
  if (!ok) failures.push(label);
  console.log(`${ok ? ' ok ' : 'FAIL'} ${label.padEnd(40)}${detail}`);
};
const check = (label, cond, detail = '') => record(label, Boolean(cond), detail);
const equal = (label, actual, expected) =>
  record(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const near = (label, actual, expected, eps = 1e-4) =>
  record(label, Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);

const savePng = async (name) => {
  const r = await call('doc_render_preview', { max_side: 1024 });
  if (r.images[0]) await writeFile(resolve(outDir, name), Buffer.from(r.images[0].data, 'base64'));
  return Boolean(r.images[0]);
};

/** Find the Smart Object record in a saved document's manifest. */
function smartSource(pcraft) {
  const manifest = JSON.parse(
    execFileSync('unzip', ['-p', resolve(outDir, pcraft), 'manifest.json'], { encoding: 'utf8' }),
  );
  const visit = (node) => {
    if (Array.isArray(node)) return node.map(visit).find(Boolean);
    if (node && typeof node === 'object') {
      if (node.kind === 'smart') return node;
      for (const value of Object.values(node)) {
        const found = visit(value);
        if (found) return found;
      }
    }
    return undefined;
  };
  return { manifest, smart: visit(manifest) };
}

try {
  // ── PHASE 0 — canvas + Smart Object placement ──────────────────────────────
  const created = await call('doc_new', {
    width: 1920, height: 1080, mode: 'rgb', depth: 8, background: 'black',
  });
  check('doc_new 1920x1080 rgb/8 black', !created.isError);

  const placed = await call('doc_place', {
    path: 'assets/hero-flat-v3.png', fit: false, scale: 100, center: [960, 540],
  });
  const soId = placed.data?.layer;
  check('doc_place returns a Smart Object', placed.data?.smartObject === true, `layer ${soId}`);

  // ── BATCH #1 — build: both adjustments and the tagline in one call ────────
  // The two layer.moveTo steps use `$0.layer`, i.e. the id returned by the
  // immediately preceding step. Targets are the Smart Object id, which is
  // known before dispatch (the engine does not expand `$N.layer` in `target`).
  const build = await call('command_batch', {
    steps: [
      // 0 — Curves with the contract's points.
      { id: 'layer.newAdjustmentLayer.curves',
        params: { points: [[0, 0], [64, 40], [192, 215], [255, 255]] } },
      // 1 — `$0.layer` is the id step 0 returned. The target is the Smart
      //     Object, known before dispatch, so the move is valid even though
      //     the engine does not expand refs in `target`.
      { id: 'layer.moveTo', params: { layer: '$0.layer', target: soId, position: 'above' } },
      // 2 — Hue/Saturation, neutral until the warm mutation.
      { id: 'layer.newAdjustmentLayer.hueSaturation',
        params: { hue: 0, saturation: 0, lightness: 0, colorize: false } },
      // 3 — Tagline, the first live type layer.
      { id: 'type.create',
        params: { x: 160, y: 640, text: '48 HOURS ONLY', font: 'Inter-SemiBold',
                  size: 64, color: '#d97706', align: 'left' } },
    ],
  });
  equal('batch #1: completed steps', build.data?.completed, 4);
  equal('batch #1: failed steps', build.data?.failed, 0);
  check('batch #1: the $0.layer move ran', build.data?.results?.[1]?.ok === true);

  const curvesId = build.data?.results?.[0]?.result?.layer;
  const hueSatId = build.data?.results?.[2]?.result?.layer;
  const taglineId = build.data?.results?.[3]?.result?.layer;
  check('batch #1: curve id', Number.isInteger(curvesId), `layer ${curvesId}`);
  check('batch #1: hue/sat id', Number.isInteger(hueSatId), `layer ${hueSatId}`);
  check('batch #1: tagline id', Number.isInteger(taglineId), `layer ${taglineId}`);

  // Price type layer: a follow-up command_run, as the contract specifies.
  const price = await run('type.create', {
    x: 160, y: 820, text: '$19.99', font: 'Inter-Bold', size: 180,
    color: '#111111', align: 'left',
  });
  const priceId = price.data?.layer;
  check('price type layer', Number.isInteger(priceId), `layer ${priceId}`);

  const baseSave = await call('doc_save', { path: BASE_PATH });
  check('doc_save base', !baseSave.isError && baseSave.data?.path === BASE_PATH, BASE_PATH);
  const fontOnly = (warnings) => (warnings ?? []).every((w) => /is not installed/i.test(w));
  check('base save: warnings are font fallbacks only', fontOnly(baseSave.data?.warnings),
    JSON.stringify(baseSave.data?.warnings));

  const base = (await call('doc_inspect')).data;
  await writeFile(resolve(outDir, 'inspect-base.json'), JSON.stringify(base, null, 2));

  const baseLayers = base.layers;
  const bottomUp = [...baseLayers].reverse();
  const byId = Object.fromEntries(baseLayers.map((l) => [l.id, l]));

  // Exactly: Background + Smart Object + two adjustments + two type layers.
  equal('base: layer count', baseLayers.length, 6);
  const kinds = baseLayers.reduce((acc, l) => ({ ...acc, [l.kind]: (acc[l.kind] ?? 0) + 1 }), {});
  equal('base: one Smart Object', kinds['Smart Object'], 1);
  equal('base: two adjustments', kinds.Adjustment, 2);
  equal('base: two type layers', kinds.Type, 2);
  equal('base: one Background', kinds.Pixel, 1);

  // The z-order invariant, bottom → top.
  equal('base: z-order bottom → top',
    bottomUp.map((l) => l.kind).join(' | '),
    'Pixel | Smart Object | Adjustment | Adjustment | Type | Type');
  equal('base: curves below hue/sat', bottomUp[2].id, curvesId);
  equal('base: hue/sat below type', bottomUp[3].id, hueSatId);
  equal('base: tagline below price', bottomUp[4].id, taglineId);
  equal('base: price on top', bottomUp[5].id, priceId);

  // Smart Object is live, embedded, full-canvas.
  const so = byId[soId];
  equal('base: smart object kind', so?.kind, 'Smart Object');
  equal('base: smart source', so?.smartSource?.kind, 'embedded');
  equal('base: smart source file', so?.smartSource?.fileName, 'hero-flat-v3.png');
  equal('base: smart object bounds', JSON.stringify(so?.bounds), JSON.stringify([0, 0, 1920, 1080]));

  // Curves: the exact contract points, stored normalised 0..1.
  const master = byId[curvesId]?.adjustment?.Curves?.master ?? [];
  equal('base: curves has four points', master.length, 4);
  const expected = [[0, 0], [64 / 255, 40 / 255], [192 / 255, 215 / 255], [1, 1]];
  master.forEach((p, i) => {
    near(`base: curves point ${i} input`, p.input, expected[i][0]);
    near(`base: curves point ${i} output`, p.output, expected[i][1]);
  });
  equal('base: curves pencil off', byId[curvesId]?.adjustment?.Curves?.pencil, false);

  // Hue/Saturation starts neutral.
  const hs0 = byId[hueSatId]?.adjustment?.HueSaturation;
  equal('base: hue 0', hs0?.hue, 0);
  equal('base: saturation 0', hs0?.saturation, 0);
  equal('base: lightness 0', hs0?.lightness, 0);
  equal('base: colorize off', hs0?.colorize, false);

  // Live type, never outlined or rasterised.
  const tagline = byId[taglineId];
  equal('base: tagline text', tagline?.text?.text, '48 HOURS ONLY');
  equal('base: tagline font', tagline?.text?.font, 'Inter-SemiBold');
  equal('base: tagline size', tagline?.text?.sizePt, 64);
  const priceLayer = byId[priceId];
  equal('base: price text', priceLayer?.text?.text, '$19.99');
  equal('base: price font', priceLayer?.text?.font, 'Inter-Bold');
  equal('base: price size', priceLayer?.text?.sizePt, 180);

  // Non-destructiveness: live adjustments and placement in the history,
  // no destructive pixel operation anywhere.
  const destructive = /flatten|merge|rasteri[sz]e|stamp|apply image|desaturate|auto tone|auto contrast|auto color|image size|canvas size|trim/i;
  check('base: history shows Place Embedded', base.history?.includes('Place Embedded'), JSON.stringify(base.history));
  check('base: history shows the curves layer', base.history?.some((h) => /New Curves Layer/i.test(h)));
  check('base: history shows the hue/sat layer', base.history?.some((h) => /New Hue\/Saturation Layer/i.test(h)));
  check('base: no destructive pixel edit in history', !(base.history ?? []).some((h) => destructive.test(h)),
    JSON.stringify(base.history));

  check('base: preview rendered', await savePng('banner-base.png'));

  // ── BATCH #2 — warm-market mutation ───────────────────────────────────────
  const warm = await call('command_batch', {
    steps: [
      { id: 'type.edit', params: { layer: priceId, text: '$17.99' } },
      { id: 'layer.setAdjustment', params: { layer: hueSatId, hue: -8, saturation: 15, lightness: 0 } },
    ],
  });
  equal('batch #2: completed steps', warm.data?.completed, 2);
  equal('batch #2: failed steps', warm.data?.failed, 0);

  const warmSave = await call('doc_save', { path: WARM_PATH });
  check('doc_save warm', !warmSave.isError && warmSave.data?.path === WARM_PATH, WARM_PATH);
  check('warm save: warnings are font fallbacks only', fontOnly(warmSave.data?.warnings),
    JSON.stringify(warmSave.data?.warnings));

  const after = (await call('doc_inspect')).data;
  await writeFile(resolve(outDir, 'inspect-warm.json'), JSON.stringify(after, null, 2));
  const afterById = Object.fromEntries(after.layers.map((l) => [l.id, l]));

  equal('warm: no layer was added', after.layers.length, 6);
  equal('warm: layer ids unchanged',
    after.layers.map((l) => l.id).sort().join(','), baseLayers.map((l) => l.id).sort().join(','));
  equal('warm: z-order unchanged',
    [...after.layers].reverse().map((l) => l.kind).join(' | '),
    'Pixel | Smart Object | Adjustment | Adjustment | Type | Type');

  const hs1 = afterById[hueSatId]?.adjustment?.HueSaturation;
  equal('warm: hue -8', hs1?.hue, -8);
  equal('warm: saturation +15', hs1?.saturation, 15);
  equal('warm: lightness 0', hs1?.lightness, 0);
  equal('warm: price retyped', afterById[priceId]?.text?.text, '$17.99');
  equal('warm: tagline untouched', afterById[taglineId]?.text?.text, '48 HOURS ONLY');
  equal('warm: curves untouched',
    JSON.stringify(afterById[curvesId]?.adjustment?.Curves?.master),
    JSON.stringify(byId[curvesId]?.adjustment?.Curves?.master));

  // Mutation-only history: the base entries plus the two edits.
  const baseHistory = base.history ?? [];
  equal('warm: history is base + two edits', JSON.stringify(after.history),
    JSON.stringify([...baseHistory, 'Edit Type', 'Modify Adjustment']));
  check('warm: no re-import in history', !(after.history ?? []).slice(baseHistory.length).some((h) => /place|import/i.test(h)));

  check('warm: preview rendered', await savePng('banner-warm.png'));

  // ── Saved files: the embedded source is byte-identical ───────────────────
  const baseFile = smartSource(BASE_PATH);
  const warmFile = smartSource(WARM_PATH);
  const baseBlob = baseFile.smart?.source?.blob;
  const warmBlob = warmFile.smart?.source?.blob;
  equal('base file: document 1920x1080',
    `${baseFile.manifest.document.size.width}x${baseFile.manifest.document.size.height}`, '1920x1080');
  equal('warm file: document 1920x1080',
    `${warmFile.manifest.document.size.width}x${warmFile.manifest.document.size.height}`, '1920x1080');
  check('base file: embedded source blob', /^[0-9a-f]{64}$/.test(baseBlob ?? ''), baseBlob ?? '');
  equal('warm file: same embedded source blob', warmBlob, baseBlob);

  const blobPath = `blobs/${baseBlob}.zst`;
  const baseBlobBytes = execFileSync('unzip', ['-p', resolve(outDir, BASE_PATH), blobPath]);
  const warmBlobBytes = execFileSync('unzip', ['-p', resolve(outDir, WARM_PATH), blobPath]);
  check('warm file: smart object bytes identical', baseBlobBytes.length > 0 && baseBlobBytes.equals(warmBlobBytes),
    `${baseBlobBytes.length} bytes`);

  // ── Evidence ─────────────────────────────────────────────────────────────
  for (const path of [BASE_PATH, WARM_PATH]) {
    check(`exists ${path}`, existsSync(resolve(outDir, path)));
  }
  await writeFile(resolve(outDir, 'run-log.json'), JSON.stringify({ checks, failures }, null, 2));

  console.log(`\n${checks} checks, ${failures.length} failing; artifacts in ${outDir}`);
  if (failures.length > 0) process.exitCode = 1;
} finally {
  await mcp.close();
}
