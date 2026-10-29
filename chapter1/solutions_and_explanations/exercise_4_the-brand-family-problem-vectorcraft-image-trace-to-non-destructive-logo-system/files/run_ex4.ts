// run_ex4.ts — acceptance harness for Chapter 1, Exercise 4.
//
// Rebuilds the flat logo as a live VectorCraft master, then proves the
// non-destructive rebrand: one `swatch.edit` on Brand/Primary must recolour the
// traced mark and the wordmark in place — with no image trace — while the
// inverted artboard keeps Brand/Inverse.
//
//   npx tsx run_ex4.ts
//
// Engine behaviour this harness works around:
//   * the MCP `pathfinder` tool takes ids; the registry's
//     `object.pathfinder.unite` command operates on the selection instead.
//   * a swatch-linked fill on type is set with `paint.setFill`, not with
//     `text.setStyle { fill }` (which rejects a swatch link as a bad colour).
//   * export paths resolve against the process cwd, so every path is absolute
//     under the exercise's output directory.
//   * `imageTrace.makeAndExpand` consumes the placed raster, so the
//     `_trace-source` layer is deleted only if it still exists.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BRAND,
  CANVAS,
  TRACE,
  FAVICON_FORMATS,
  buildProvenance,
} from './04_the-brand-family-problem-vectorcraft-image-trace-to-non-destructive-logo-system.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', 'output');
const BRAND_DIR = resolve(OUT, 'brand');
const FAVICONS = resolve(BRAND_DIR, 'favicons');

process.chdir(HERE);
mkdirSync(BRAND_DIR, { recursive: true });
for (const stale of ['brand', 'inspect-before.json', 'inspect-after.json', 'run-log.json']) {
  rmSync(resolve(OUT, stale), { recursive: true, force: true });
}
mkdirSync(BRAND_DIR, { recursive: true });

const transcript: string[] = [];
const say = (line: string): void => {
  transcript.push(line);
  console.log(line);
};

let checks = 0;
const failures: string[] = [];
const check = (label: string, condition: boolean, detail = ''): void => {
  checks += 1;
  if (!condition) failures.push(label);
  say(`${condition ? ' ok ' : 'FAIL'} ${label.padEnd(50)}${detail}`);
};
const equal = (label: string, actual: unknown, expected: unknown): void =>
  check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);

// ── MCP plumbing ─────────────────────────────────────────────────────────────
const mcp = new Client({ name: 'cap1-exercise4', version: '1.0.0' }, { capabilities: {} });
await mcp.connect(new StdioClientTransport({
  command: process.env.VECTORCRAFT_BIN ?? 'vectorcraft-cli',
  args: ['mcp', '--automation-read-root', HERE, '--automation-write-root', OUT],
}));

type ToolResult = { isError?: boolean; text?: string; data: any; images: any[] };

const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
  const result: any = await mcp.callTool({ name, arguments: args });
  const text = result.content?.find((c: any) => c.type === 'text')?.text;
  const images = result.content?.filter((c: any) => c.type === 'image') ?? [];
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { isError: result.isError, text, data, images };
};
const rc = (command: string, params: Record<string, unknown> = {}): Promise<ToolResult> =>
  call('run_command', { command, params });

const inspect = async (): Promise<any> =>
  (await call('doc_inspect', { depth: 4 })).data;

const flatten = (nodes: any[] | undefined): any[] =>
  (nodes ?? []).flatMap((node: any) => [node, ...flatten(node?.children)]);
const byId = (tree: any, id: number | undefined): any =>
  flatten(tree?.layers).find((node: any) => node?.id === id);

const steps: { label: string; ok: boolean; error: unknown }[] = [];
const record = (label: string, result: ToolResult): void => {
  const error = result.isError ? result.text : result.data?.error;
  steps.push({ label, ok: !error, error: error ?? null });
  check(label, !error, error ? String(error).slice(0, 120) : '');
};
const quirks: string[] = [];

try {
  // ── PHASE A — canvas + trace source ────────────────────────────────────────
  record('A file.new 512x512', await rc('file.new', { ...CANVAS }));
  const placed = await rc('file.place', {
    path: 'brand/logo-flat-512.png', link: false, at: [256, 256], rect: [36, 36, 440, 440],
  });
  record('A file.place trace source', placed);
  const sourceId = placed.data?.ids?.[0];
  check('A source layer id', Number.isInteger(sourceId), `id ${sourceId}`);
  record('A rename _trace-source', await rc('layer.setProps', { ids: [sourceId], name: '_trace-source' }));

  // ── PHASE B — trace, clean, unite in one undo group ────────────────────────
  record('B undoGroup.begin', await rc('edit.undoGroup.begin', { label: 'Trace mark' }));
  let traced = await rc('imageTrace.makeAndExpand', { id: sourceId, ...TRACE });
  if (traced.isError) {
    quirks.push('imageTrace.makeAndExpand rejected the preset params; retried with the preset only');
    traced = await rc('imageTrace.makeAndExpand', { id: sourceId, preset: TRACE.preset });
  }
  record('B imageTrace.makeAndExpand', traced);
  const tracedIds: number[] = traced.data?.ids ?? (traced.data?.id !== undefined ? [traced.data.id] : []);
  check('B trace produced paths', tracedIds.length > 0, `paths=${traced.data?.paths} anchors=${traced.data?.anchors}`);

  const unite = await call('pathfinder', { operation: 'unite', ids: tracedIds });
  quirks.push('object.pathfinder.unite is selection-only in the registry; the MCP `pathfinder` tool takes ids');
  const markId = unite.data?.ids?.[0] ?? unite.data?.id;
  check('B pathfinder unite', Number.isInteger(markId), `mark ${markId}`);

  record('B object.path.cleanUp', await rc('object.path.cleanUp', { strayPoints: true, unpaintedObjects: true }));
  record('B undoGroup.end', await rc('edit.undoGroup.end', {}));

  // ── PHASE C — global swatches + mark paint ─────────────────────────────────
  record('C swatch.new Brand/Primary',
    await rc('swatch.new', { name: BRAND.primarySwatch, color: BRAND.primaryHex, global: true }));
  record('C swatch.new Brand/Inverse',
    await rc('swatch.new', { name: BRAND.inverseSwatch, color: BRAND.inverseHex, global: true }));
  record('C mark <- Brand/Primary',
    await rc('paint.setFill', { swatch: BRAND.primarySwatch, ids: [markId] }));

  // ── PHASE D — live wordmark, linked to the same swatch ─────────────────────
  const wordmark = await rc('text.create', {
    x: 256, y: 430, text: BRAND.wordmarkText,
    font: BRAND.fontFamily, style: BRAND.fontStyle, size: 96,
    color: BRAND.primaryHex, charAlign: 'romanBaseline',
  });
  record('D text.create wordmark', wordmark);
  const wordmarkId = wordmark.data?.id;
  check('D wordmark id', Number.isInteger(wordmarkId), `id ${wordmarkId}`);
  record('D centre the wordmark', await rc('text.setStyle', { id: wordmarkId, justify: 'center' }));
  // The book's Phase D passes a hex colour, but its analysis promises the
  // wordmark follows Brand/Primary. A swatch-backed paint is what makes that
  // true; text.setStyle rejects a swatch link, so paint.setFill is used.
  record('D wordmark <- Brand/Primary',
    await rc('paint.setFill', { swatch: BRAND.primarySwatch, ids: [wordmarkId] }));

  // ── PHASE E — inverted variant ─────────────────────────────────────────────
  const duplicate = await rc('artboard.duplicate', { index: 0, art: true });
  record('E artboard.duplicate', duplicate);
  const dupIds: number[] = duplicate.data?.ids ?? [];
  check('E duplicate returned art ids', dupIds.length >= 2, JSON.stringify(dupIds));

  const midDuplicate = await inspect();
  const typeIds = new Set(
    flatten(midDuplicate?.layers).filter((node: any) => node?.kind === 'Type').map((node: any) => node.id),
  );
  const duplicateWordmark = dupIds.find((id) => typeIds.has(id));
  const duplicateMark = dupIds.find((id) => !typeIds.has(id));
  check('E identified duplicated mark', Number.isInteger(duplicateMark), `id ${duplicateMark}`);
  check('E identified duplicated wordmark', Number.isInteger(duplicateWordmark), `id ${duplicateWordmark}`);

  record('E graphicStyle.new Logo/Mark',
    await rc('graphicStyle.new', { name: BRAND.graphicStyle, id: markId }));
  // `graphicStyle.new` builds the style from the master but does not link it
  // (linked comes back empty); applying the style to both marks is what
  // registers the two-way link.
  record('E graphicStyle.apply to master mark',
    await rc('graphicStyle.apply', { name: BRAND.graphicStyle, ids: [markId] }));
  record('E graphicStyle.apply to inverse mark',
    await rc('graphicStyle.apply', { name: BRAND.graphicStyle, ids: [duplicateMark] }));
  quirks.push('graphicStyle.new does not link its source object; the style is applied to both marks to link them');
  record('E inverse mark <- Brand/Inverse',
    await rc('paint.setFill', { swatch: BRAND.inverseSwatch, ids: [duplicateMark] }));
  record('E inverse wordmark <- Brand/Inverse',
    await rc('paint.setFill', { swatch: BRAND.inverseSwatch, ids: [duplicateWordmark] }));

  // ── PHASE F — drop the trace source ────────────────────────────────────────
  const midTree = await inspect();
  const sourceStillThere = flatten(midTree?.layers).some((node: any) =>
    node?.id === sourceId || node?.name === '_trace-source');
  if (sourceStillThere) {
    record('F layer.delete _trace-source', await rc('layer.delete', { ids: [sourceId] }));
  } else {
    quirks.push('imageTrace.makeAndExpand consumed the placed raster, so no source layer was left to delete');
    check('F trace source already consumed', true);
  }

  // ── Assert the assembled master (before the rebrand) ───────────────────────
  const before = await inspect();
  writeFileSync(resolve(OUT, 'inspect-before.json'), JSON.stringify(before, null, 2));
  const flatBefore = flatten(before?.layers);
  const beforeIds = flatBefore.map((node: any) => node.id).sort((a: number, b: number) => a - b);

  equal('before: two artboards', before?.artboards?.length, 2);
  equal('before: two live wordmarks', flatBefore.filter((node: any) => node.kind === 'Type').length, 2);
  equal('before: two traced marks', flatBefore.filter((node: any) => node.kind === 'Path').length, 2);
  equal('before: no raster survives', flatBefore.filter((node: any) => node.kind === 'Image').length, 0);
  check('before: trace source layer is gone', !flatBefore.some((node: any) => node.name === '_trace-source'));

  equal('before: master mark fill', byId(before, markId)?.fill, `${BRAND.primarySwatch} (${BRAND.primaryHex})`);
  equal('before: master wordmark fill', byId(before, wordmarkId)?.fill, `${BRAND.primarySwatch} (${BRAND.primaryHex})`);
  equal('before: inverse mark fill', byId(before, duplicateMark)?.fill, `${BRAND.inverseSwatch} (${BRAND.inverseHex})`);
  equal('before: inverse wordmark fill', byId(before, duplicateWordmark)?.fill, `${BRAND.inverseSwatch} (${BRAND.inverseHex})`);

  const swatches = (await rc('swatch.list', {})).data?.swatches ?? [];
  const primarySwatch = swatches.find((swatch: any) => swatch.name === BRAND.primarySwatch);
  const inverseSwatch = swatches.find((swatch: any) => swatch.name === BRAND.inverseSwatch);
  equal('before: Brand/Primary is global', primarySwatch?.global, true);
  equal('before: Brand/Primary colour', primarySwatch?.hex, BRAND.primaryHex);
  equal('before: Brand/Inverse is global', inverseSwatch?.global, true);
  equal('before: Brand/Inverse colour', inverseSwatch?.hex, BRAND.inverseHex);

  const styles = (await rc('graphicStyle.list', {})).data?.styles ?? [];
  const logoStyle = styles.find((style: any) => style.name === BRAND.graphicStyle);
  check('before: Logo/Mark style exists', Boolean(logoStyle), BRAND.graphicStyle);
  check('before: Logo/Mark links the master mark',
    (logoStyle?.linked ?? []).includes(markId), JSON.stringify(logoStyle?.linked));
  // The engine unlinks an object when a fill override changes its appearance,
  // so recolouring the duplicate with Brand/Inverse drops its style link. The
  // payload still applies the style first (as the exercise asks); the variant
  // stays tied to the rebrand through its swatch, which is the propagating
  // link that matters here.
  check('before: inverse mark is swatch-linked, not style-linked',
    !(logoStyle?.linked ?? []).includes(duplicateMark), JSON.stringify(logoStyle?.linked));
  quirks.push('a paint override on a graphic-style object unlinks it (Illustrator-style override); the inverse mark stays linked to Brand/Inverse instead');

  const svgBefore = await rc('document.export', {
    path: resolve(BRAND_DIR, 'logo-master-primary.svg'),
    format: 'svg', outlineText: false, useArtboards: false, artboard: 0,
  });
  record('G export SVG before rebrand', svgBefore);
  const primarySvg = existsSync(resolve(BRAND_DIR, 'logo-master-primary.svg'))
    ? readFileSync(resolve(BRAND_DIR, 'logo-master-primary.svg'), 'utf8') : '';
  check('before: SVG keeps <text> live', /<text[\s>]/.test(primarySvg));
  check('before: SVG paints the primary hex', primarySvg.includes(BRAND.primaryHex), BRAND.primaryHex);

  // ── Rebrand: one swatch.edit ───────────────────────────────────────────────
  const rebrand = await rc('swatch.edit', { name: BRAND.primarySwatch, color: BRAND.rebrandHex });
  record('rebrand: swatch.edit Brand/Primary', rebrand);
  const relinked: number = rebrand.data?.relinked ?? 0;
  check('rebrand: paints were relinked', relinked >= 2, `${relinked} paint(s)`);

  const after = await inspect();
  writeFileSync(resolve(OUT, 'inspect-after.json'), JSON.stringify(after, null, 2));
  const flatAfter = flatten(after?.layers);
  const afterIds = flatAfter.map((node: any) => node.id).sort((a: number, b: number) => a - b);

  equal('after: master mark follows the new swatch', byId(after, markId)?.fill,
    `${BRAND.primarySwatch} (${BRAND.rebrandHex})`);
  equal('after: master wordmark follows the new swatch', byId(after, wordmarkId)?.fill,
    `${BRAND.primarySwatch} (${BRAND.rebrandHex})`);
  equal('after: inverse mark stays inverse', byId(after, duplicateMark)?.fill,
    `${BRAND.inverseSwatch} (${BRAND.inverseHex})`);
  equal('after: inverse wordmark stays inverse', byId(after, duplicateWordmark)?.fill,
    `${BRAND.inverseSwatch} (${BRAND.inverseHex})`);

  equal('after: same node ids (nothing retraced)', afterIds.join(','), beforeIds.join(','));
  equal('after: still two marks', flatAfter.filter((node: any) => node.kind === 'Path').length, 2);
  equal('after: still two live wordmarks', flatAfter.filter((node: any) => node.kind === 'Type').length, 2);
  equal('after: words unchanged', flatAfter.filter((node: any) => node.kind === 'Type').map((node: any) => node.name).join('|'),
    `${BRAND.wordmarkText}|${BRAND.wordmarkText}`);

  const historyAfter = after?.history ?? [];
  check('after: the rebrand is one swatch edit',
    (Array.isArray(historyAfter) ? historyAfter : []).slice(-1).some((entry: any) => /swatch/i.test(String(entry))),
    JSON.stringify(historyAfter.slice(-3)));
  check('after: no trace after the rebrand',
    !(Array.isArray(historyAfter) ? historyAfter : []).slice(-1).some((entry: any) => /trace/i.test(String(entry))));

  // ── Re-export: the SVG reads the current document ──────────────────────────
  const svgAfter = await rc('document.export', {
    path: resolve(BRAND_DIR, 'logo-master.svg'),
    format: 'svg', outlineText: false, useArtboards: false, artboard: 0,
  });
  record('G re-export SVG after rebrand', svgAfter);
  const rebrandedSvg = existsSync(resolve(BRAND_DIR, 'logo-master.svg'))
    ? readFileSync(resolve(BRAND_DIR, 'logo-master.svg'), 'utf8') : '';
  check('after: SVG still keeps <text> live', /<text[\s>]/.test(rebrandedSvg));
  check('after: SVG carries the rebrand hex', rebrandedSvg.includes(BRAND.rebrandHex), BRAND.rebrandHex);
  check('after: SVG dropped the old primary hex', !rebrandedSvg.includes(BRAND.primaryHex));
  check('after: wordmark text is in the SVG', rebrandedSvg.includes(BRAND.wordmarkText));

  // ── Favicons: one call, deterministic sizes ────────────────────────────────
  const screens = await rc('document.exportForScreens', {
    folder: FAVICONS,
    prefix: 'acme',
    formats: FAVICON_FORMATS.map((format) => ({ ...format })),
    settings: { png: { antiAlias: 'art', background: 'transparent' } },
  });
  record('G exportForScreens favicons', screens);
  const files: string[] = screens.data?.files ?? [];
  equal('favicons: 2 artboards x 4 sizes', files.length, FAVICON_FORMATS.length * 2);
  check('favicons: every file exists', files.every((file) => existsSync(file)));

  const pngSize = (path: string): { width: number; height: number } => {
    const bytes = readFileSync(path);
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  };
  for (const format of FAVICON_FORMATS) {
    const matching = files.filter((file) => file.endsWith(`${format.suffix}.png`));
    equal(`favicons: two ${format.width}px files`, matching.length, 2);
    check(`favicons: ${format.width}px pixels match`,
      matching.every((file) => {
        const size = pngSize(file);
        return size.width === format.width && size.height === format.height;
      }),
      matching.map((file) => `${pngSize(file).width}x${pngSize(file).height}`).join(', '));
  }

  // ── Native master + provenance ─────────────────────────────────────────────
  record('G save native master', await rc('document.save', {
    path: resolve(BRAND_DIR, 'logo-master.vectorcraft'), format: 'vectorcraft', preview: true,
  }));
  check('native master exists', existsSync(resolve(BRAND_DIR, 'logo-master.vectorcraft')));

  const sourcePath = resolve(HERE, 'brand/logo-flat-512.png');
  const sourceSha256 = createHash('sha256').update(readFileSync(sourcePath)).digest('hex');
  const provenance = buildProvenance(sourceSha256, relinked);
  writeFileSync(resolve(BRAND_DIR, 'logo-master.provenance.json'), JSON.stringify(provenance, null, 2));
  const stored = JSON.parse(readFileSync(resolve(BRAND_DIR, 'logo-master.provenance.json'), 'utf8'));
  equal('provenance: source hash matches the PNG', stored.source_asset_sha256, sourceSha256);
  equal('provenance: no retrace', stored.rebrand?.retraced, false);
  equal('provenance: rebrand colour recorded', stored.rebrand?.to, BRAND.rebrandHex);

  // ── Previews ───────────────────────────────────────────────────────────────
  for (const artboard of [0, 1]) {
    const preview = await call('render_preview', { max_side: 1024, artboard });
    if (preview.images[0]) {
      writeFileSync(resolve(BRAND_DIR, `artboard-${artboard}.png`),
        Buffer.from(preview.images[0].data, 'base64'));
    }
    check(`preview artboard ${artboard}`, Boolean(preview.images[0]));
  }

  const failedSteps = steps.filter((step) => !step.ok);
  equal('no failed engine step', failedSteps.length, 0);

  writeFileSync(resolve(OUT, 'run-log.json'), JSON.stringify({ checks, failures, quirks, steps }, null, 2));
  say('');
  say(`${checks} checks, ${failures.length} failing; ${quirks.length} engine quirk(s); artifacts in ${OUT}`);
  writeFileSync(resolve(OUT, 'run_ex4.log'), `${transcript.join('\n')}\n`);
  if (failures.length > 0) process.exitCode = 1;
} catch (error) {
  say(`FAIL harness crashed: ${error instanceof Error ? error.stack : String(error)}`);
  writeFileSync(resolve(OUT, 'run_ex4.log'), `${transcript.join('\n')}\n`);
  process.exitCode = 1;
} finally {
  await mcp.close();
}
