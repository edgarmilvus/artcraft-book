// run_ex3.ts — acceptance harness for Chapter 1, Exercise 3.
//
// Drives the payloads in
// `03_the-undoable-grade-filmcraft-timeline-ripple-with-live-lumetri-layers.ts`
// against a real `filmcraft-cli mcp` session, then asserts on the sequence the
// engine actually produced: the 3-shot layout, the live per-clip Lumetri
// grades, the V2 warm adjustment layer, the ripple delete, and undo/redo.
//
//   npx tsx run_ex3.ts
//
// Engine behaviour this harness works around (all verified against the real
// server):
//   * `lut.import` resolves a relative path against the process cwd, so the
//     harness chdirs to the exercise directory first.
//   * `timeline.place` wants numeric ticks; a stringified tick count is
//     ignored and the clip falls back to its natural media duration.
//   * the `clip` returned by `timeline.place` is not the id later edits use;
//     every edit targets a clip id read back from `sequence_inspect`.
//   * V2 is sync-locked and blocks a ripple delete, so the batch unlocks it,
//     ripples, and relocks it.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LAYOUT,
  LUTS,
  SEQUENCE,
  TICKS_PER_SECOND,
  IMPORT_STEPS,
  placeSteps,
  gradeSteps,
  adjustmentSteps,
  warmGradeStep,
  rippleSteps,
  expectedRipple,
  type EngineStep,
} from './03_the-undoable-grade-filmcraft-timeline-ripple-with-live-lumetri-layers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', 'output');
const FRAMES = resolve(OUT, 'frames');
const PROJECT = resolve(OUT, 'skincare-30s.fcproj');

process.chdir(HERE);
mkdirSync(FRAMES, { recursive: true });
for (const stale of [
  'frames',
  'skincare-30s.fcproj',
  'sequence-before.json',
  'sequence-after.json',
  'sequence-undo.json',
  'sequence-redo.json',
  'run-log.json',
]) {
  rmSync(resolve(OUT, stale), { recursive: true, force: true });
}
mkdirSync(FRAMES, { recursive: true });

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
  say(`${condition ? ' ok ' : 'FAIL'} ${label.padEnd(48)}${detail}`);
};
const equal = (label: string, actual: unknown, expected: unknown): void =>
  check(label, Object.is(actual, expected), `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
const near = (label: string, actual: number, expected: number, eps = 1e-6): void =>
  check(label, Math.abs(actual - expected) <= eps, `expected ${expected}, got ${actual}`);

// ── MCP plumbing ─────────────────────────────────────────────────────────────
const transport = new StdioClientTransport({
  command: process.env.FILMCRAFT_BIN ?? 'filmcraft-cli',
  args: ['mcp', '--automation-read-root', HERE, '--automation-write-root', OUT],
});
const mcp = new Client({ name: 'cap1-exercise3', version: '1.0.0' }, { capabilities: {} });
await mcp.connect(transport);

type ToolResult = { isError?: boolean; text?: string; data: any; images: any[] };

const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolResult> => {
  const result: any = await mcp.callTool({ name, arguments: args });
  const text = result.content?.find((c: any) => c.type === 'text')?.text;
  const images = result.content?.filter((c: any) => c.type === 'image') ?? [];
  let data: any;
  try { data = JSON.parse(text); } catch { data = text; }
  return { isError: result.isError, text, data, images };
};
const run = (id: string, params: Record<string, unknown> = {}): Promise<ToolResult> =>
  call('command_run', { id, params });
const batch = (steps: EngineStep[]): Promise<ToolResult> =>
  call('command_batch', { steps });

const inspect = async (): Promise<any> => (await call('sequence_inspect')).data;
const track = (seq: any, name: string): any =>
  (seq?.video ?? []).find((candidate: any) => candidate?.name === name);
const itemsOf = (seq: any, name: string): any[] =>
  [...(track(seq, name)?.items ?? [])].sort((a: any, b: any) => a.start - b.start);
const lumetriOf = (item: any): any =>
  (item?.effects ?? []).find((effect: any) => effect?.effect === 'lumetri');
const lutOf = (item: any): string | null => {
  const raw = lumetriOf(item)?.params?.input_lut?.value;
  const match = /^Text\("(.+)"\)$/.exec(String(raw));
  return match?.[1] ?? null;
};
const render = async (name: string, seconds: number): Promise<boolean> => {
  const result = await call('render_preview', { max_side: 1024, seconds });
  if (result.images[0]) {
    writeFileSync(resolve(FRAMES, name), Buffer.from(result.images[0].data, 'base64'));
  }
  return Boolean(result.images[0]);
};

const steps: { label: string; ok: boolean; error: unknown }[] = [];
const record = (label: string, result: ToolResult): void => {
  const error = result.isError ? result.text : result.data?.error;
  steps.push({ label, ok: !error, error: error ?? null });
  check(label, !error, error ? String(error).slice(0, 120) : '');
};

try {
  // ── LUTs and sequence ──────────────────────────────────────────────────────
  const neutralImport = await run('lut.import', { path: LUTS.neutral });
  record('lut.import neutral', neutralImport);
  const warmImport = await run('lut.import', { path: LUTS.warm });
  record('lut.import warm', warmImport);
  const neutralRef: string = neutralImport.data?.ref;
  const warmRef: string = warmImport.data?.ref;
  check('neutral LUT is registered', /^lib:/.test(neutralRef ?? ''), neutralRef ?? '');
  check('warm LUT is registered', /^lib:/.test(warmRef ?? ''), warmRef ?? '');
  check('the two LUTs are distinct', neutralRef !== warmRef, `${neutralRef} / ${warmRef}`);

  const created = await run('file.newSequence', { ...SEQUENCE });
  record('file.newSequence', created);

  const imports = await batch(IMPORT_STEPS);
  record('import demo footage (batch)', imports);
  equal('import batch completed', imports.data?.completed, IMPORT_STEPS.length);
  const itemIds: number[] = (imports.data?.results ?? []).map(
    (result: any) => result?.result?.items?.[0],
  );
  check('three linked source items', itemIds.length === 3 && itemIds.every(Number.isInteger),
    JSON.stringify(itemIds));

  const placements = await batch(placeSteps(itemIds));
  record('place three V1 clips (batch)', placements);
  equal('placement batch completed', placements.data?.completed, 3);

  let seq = await inspect();
  let v1 = itemsOf(seq, 'Video 1');
  const beforeClips = v1.map((item: any) => item.clip);
  equal('before: three V1 clips', v1.length, 3);
  equal('before: shot names', v1.map((item: any) => item.name).join(' | '),
    'Ocean_Sunset.mp4 | Aurora_Timelapse.mp4 | City_Night_Drive.mp4');
  equal('before: shot starts', v1.map((item: any) => item.start).join(','),
    [LAYOUT.shot1.start, LAYOUT.shot2.start, LAYOUT.shot3.start].map(Number).join(','));
  const gap = v1[2].start - (v1[1].start + v1[1].duration);
  check('before: 0.5 s gap kept before shot 3', gap > 0 && gap < Number(TICKS_PER_SECOND),
    `${(gap / Number(TICKS_PER_SECOND)).toFixed(3)} s`);

  // ── Per-clip grade + sequence-wide adjustment layer ────────────────────────
  const grading = await batch(gradeSteps(beforeClips));
  record('grade every V1 clip (batch)', grading);
  equal('grade batch completed', grading.data?.completed, 6);

  const adjustment = await run('file.newAdjustmentLayer', { seconds: 20 });
  record('file.newAdjustmentLayer', adjustment);
  const adjustmentItem = adjustment.data?.items?.[0] ?? adjustment.data?.item;
  check('adjustment item created', Number.isInteger(adjustmentItem), `item ${adjustmentItem}`);

  const placedAdjustment = await run('timeline.place', adjustmentSteps(adjustmentItem)[0].params);
  record('place adjustment on V2', placedAdjustment);

  seq = await inspect();
  const adjustmentClip = itemsOf(seq, 'Video 2')[0]?.clip;
  check('adjustment clip placed', Number.isInteger(adjustmentClip), `clip ${adjustmentClip}`);
  record('warm LUT on adjustment', await run(warmGradeStep(adjustmentClip).id, warmGradeStep(adjustmentClip).params));

  // ── Save + assert the built sequence ───────────────────────────────────────
  record('save project', await run('file.save', { path: PROJECT }));
  check('before preview rendered', await render('before-8s.png', 8));

  seq = await inspect();
  v1 = itemsOf(seq, 'Video 1');
  const v2 = itemsOf(seq, 'Video 2');
  const shot1 = v1[0];
  const shot2 = v1[1];
  const shot3 = v1[2];
  const adjustmentItemBefore = v2[0];
  writeFileSync(resolve(OUT, 'sequence-before.json'), JSON.stringify(seq, null, 2));

  equal('before: sequence is 1920x1080', `${seq?.settings?.width}x${seq?.settings?.height}`, '1920x1080');
  near('before: 23.976 fps', seq?.settings?.frame_rate?.num / seq?.settings?.frame_rate?.den, 24000 / 1001);
  equal('before: two video tracks', seq?.video?.length, 2);

  equal('before: V1 clip ids are distinct', new Set(v1.map((i: any) => i.clip)).size, 3);
  for (const [index, item] of v1.entries()) {
    equal(`before: V1[${index}] Lumetri is live`, lumetriOf(item)?.enabled, true);
    equal(`before: V1[${index}] carries the neutral LUT`, lutOf(item), neutralRef);
  }
  check('before: no V1 clip carries the warm LUT', v1.every((item: any) => lutOf(item) !== warmRef));

  equal('before: one V2 clip', v2.length, 1);
  equal('before: V2 is an adjustment layer', adjustmentItemBefore?.name, 'Adjustment Layer');
  equal('before: V2 starts at 0', adjustmentItemBefore?.start, 0);
  check('before: V2 covers the whole sequence',
    adjustmentItemBefore?.duration >= shot3.start + shot3.duration,
    `${(adjustmentItemBefore?.duration / Number(TICKS_PER_SECOND)).toFixed(2)} s`);
  equal('before: V2 Lumetri is live', lumetriOf(adjustmentItemBefore)?.enabled, true);
  equal('before: V2 carries the warm LUT', lutOf(adjustmentItemBefore), warmRef);

  // ── Ripple delete shot 2 ───────────────────────────────────────────────────
  const ripple = await batch(rippleSteps(shot2.clip, LAYOUT.shot3.start));
  record('razor + ripple delete shot 2 (batch)', ripple);
  equal('ripple batch completed', ripple.data?.completed, 4);

  const after = await inspect();
  const afterV1 = itemsOf(after, 'Video 1');
  const afterV2 = itemsOf(after, 'Video 2');
  writeFileSync(resolve(OUT, 'sequence-after.json'), JSON.stringify(after, null, 2));

  equal('after: two V1 clips remain', afterV1.length, 2);
  equal('after: surviving clips are shot 1 and shot 3',
    afterV1.map((item: any) => item.clip).join(','), [shot1.clip, shot3.clip].join(','));
  equal('after: shot 1 still starts at 0', afterV1[0].start, 0);
  equal('after: shot 3 shifted by the deleted clip duration', afterV1[1].start,
    expectedRipple(shot3.start, shot2.duration));
  equal('after: shot 1 duration intact', afterV1[0].duration, shot1.duration);
  equal('after: shot 3 duration intact', afterV1[1].duration, shot3.duration);
  check('after: surviving clips do not overlap',
    afterV1[0].start + afterV1[0].duration <= afterV1[1].start);

  for (const [index, item] of afterV1.entries()) {
    equal(`after: V1[${index}] still has live Lumetri`, lumetriOf(item)?.enabled, true);
    equal(`after: V1[${index}] still uses the neutral LUT`, lutOf(item), neutralRef);
  }
  equal('after: V2 adjustment layer survived', afterV2.length, 1);
  equal('after: V2 clip id unchanged', afterV2[0]?.clip, adjustmentItemBefore?.clip);
  equal('after: V2 still starts at 0', afterV2[0]?.start, 0);
  equal('after: V2 duration unchanged', afterV2[0]?.duration, adjustmentItemBefore?.duration);
  equal('after: V2 still carries the warm LUT', lutOf(afterV2[0]), warmRef);
  check('after preview rendered', await render('after-8s.png', 8));

  const historyAfter = (await run('history.list')).data;
  check('history records the ripple delete',
    (historyAfter?.undo ?? []).some((entry: string) => /ripple/i.test(entry)),
    JSON.stringify(historyAfter?.undo?.slice(-4)));

  // ── Undo / redo: the edit is non-destructive ───────────────────────────────
  // The ripple batch also wrote "Track Settings" history entries for the V2
  // sync lock, so undo until the deleted clip is actually back instead of
  // assuming a single step.
  let undoneV1 = itemsOf(await inspect(), 'Video 1');
  let undoCount = 0;
  while (undoneV1.length < 3 && undoCount < 8) {
    undoCount += 1;
    record(`edit.undo #${undoCount}`, await run('edit.undo'));
    undoneV1 = itemsOf(await inspect(), 'Video 1');
  }
  const undone = await inspect();
  writeFileSync(resolve(OUT, 'sequence-undo.json'), JSON.stringify(undone, null, 2));
  equal('undo: three V1 clips restored', undoneV1.length, 3);
  equal('undo: original starts restored', undoneV1.map((item: any) => item.start).join(','),
    [shot1.start, shot2.start, shot3.start].join(','));
  equal('undo: original clip ids restored', undoneV1.map((item: any) => item.clip).join(','),
    [shot1.clip, shot2.clip, shot3.clip].join(','));
  equal('undo: V2 still carries the warm LUT', lutOf(itemsOf(undone, 'Video 2')[0]), warmRef);
  check('undo: reached the pre-ripple state', undoneV1.length === 3, `${undoCount} undo step(s)`);

  for (let index = 1; index <= undoCount; index += 1) {
    record(`edit.redo #${index}`, await run('edit.redo'));
  }
  const redone = await inspect();
  const redoneV1 = itemsOf(redone, 'Video 1');
  writeFileSync(resolve(OUT, 'sequence-redo.json'), JSON.stringify(redone, null, 2));
  equal('redo: two V1 clips again', redoneV1.length, 2);
  equal('redo: shot 3 back at the shifted start', redoneV1[1]?.start,
    expectedRipple(shot3.start, shot2.duration));
  equal('redo: neutral LUT still live', lutOf(redoneV1[0]), neutralRef);

  // ── Final artefacts ────────────────────────────────────────────────────────
  record('save final project', await run('file.save', { path: PROJECT }));
  check('project file exists', existsSync(PROJECT));
  check('project file is non-trivial', existsSync(PROJECT) && statSync(PROJECT).size > 10_000,
    existsSync(PROJECT) ? `${statSync(PROJECT).size} bytes` : 'missing');
  check('before frame exists', existsSync(resolve(FRAMES, 'before-8s.png')));
  check('after frame exists', existsSync(resolve(FRAMES, 'after-8s.png')));

  const failedSteps = steps.filter((step) => !step.ok);
  equal('no failed engine step', failedSteps.length, 0);

  writeFileSync(resolve(OUT, 'run-log.json'), JSON.stringify({ checks, failures, steps }, null, 2));
  say('');
  say(`${checks} checks, ${failures.length} failing; artifacts in ${OUT}`);
  writeFileSync(resolve(OUT, 'run_ex3.log'), `${transcript.join('\n')}\n`);
  if (failures.length > 0) process.exitCode = 1;
} catch (error) {
  say(`FAIL harness crashed: ${error instanceof Error ? error.stack : String(error)}`);
  writeFileSync(resolve(OUT, 'run_ex3.log'), `${transcript.join('\n')}\n`);
  process.exitCode = 1;
} finally {
  await mcp.close();
}
