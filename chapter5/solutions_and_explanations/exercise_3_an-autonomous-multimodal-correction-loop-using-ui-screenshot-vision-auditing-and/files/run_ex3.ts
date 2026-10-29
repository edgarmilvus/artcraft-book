/**
 * Acceptance harness for Chapter 5 Exercise 3.
 *
 * Drives the worked correction loop against a real PhotoCraft worker with a
 * scripted vision model. The run keeps the master, the corrected PNG, every
 * audited render and a replayable trajectory under ../output/.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type OpenAI from 'openai';
import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as path from 'node:path';
import { CaptureRouter, runCorrection, validateCurve } from './03_an-autonomous-multimodal-correction-loop-using-ui-screenshot-vision-auditing-and-curves.js';

const HERE = import.meta.dirname;
const OUT = path.join(HERE, '..', 'output');
const WORK = path.join(OUT, 'workspace');
const READ = path.join(WORK, 'read');
const WRITE = path.join(WORK, 'write');
const AUDIT = path.join(OUT, 'audit');
const TRAJECTORY = path.join(OUT, 'trajectory');

for (const directory of [WORK, AUDIT, TRAJECTORY]) {
  rmSync(directory, { recursive: true, force: true });
}
mkdirSync(READ, { recursive: true });
mkdirSync(WRITE, { recursive: true });
mkdirSync(AUDIT, { recursive: true });
mkdirSync(TRAJECTORY, { recursive: true });

const sha256 = (file: string): string =>
  createHash('sha256').update(readFileSync(file)).digest('hex');

function pngSize(buffer: Buffer): { width: number; height: number } {
  assert.equal(buffer.subarray(1, 4).toString('ascii'), 'PNG', 'not a PNG');
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

const mcp = new Client({ name: 'ex3-solution-harness', version: '1.0.0' }, { capabilities: {} });
await mcp.connect(
  new StdioClientTransport({
    command: 'photocraft-cli',
    args: ['mcp', '--automation-read-root', READ, '--automation-write-root', WRITE],
  }),
);

type ToolReply = { content?: Array<{ text?: string }> };

// A master image the loop can open, fork and grade.
const masterPath = path.join(WRITE, 'master.png');
await mcp.callTool({ name: 'doc_new', arguments: { width: 320, height: 200, background: '#3a3a3a' } });
await mcp.callTool({
  name: 'command_run',
  arguments: {
    id: 'gradient.fill.create',
    params: { from: [0, 0], to: [320, 200], style: 'linear', stops: [[0, '#101010'], [1, '#f0f0f0']] },
  },
});
await mcp.callTool({ name: 'doc_save', arguments: { index: 0, path: masterPath } });
await mcp.callTool({ name: 'doc_close', arguments: { index: 0 } });
copyFileSync(masterPath, path.join(READ, 'master.png'));
const masterHashBefore = sha256(path.join(READ, 'master.png'));

const VERDICTS = [
  {
    status: 'low_contrast',
    suggested_curve: [[0, 0], [64, 50], [192, 205], [255, 255]],
    confidence: 0.91,
    notes: 'midtones compressed',
  },
  { status: 'ok', confidence: 0.95, notes: 'contrast inside the target band' },
];

class ScriptedVision {
  public calls = 0;
  public readonly chat = {
    completions: {
      create: async () => {
        const verdict = VERDICTS[Math.min(this.calls, VERDICTS.length - 1)];
        this.calls += 1;
        return { choices: [{ message: { content: JSON.stringify(verdict) } }] };
      },
    },
  };
}

class RecordingCapture {
  public calls = 0;
  constructor(private readonly router: CaptureRouter) {}

  async capture(mode: 'bridge' | 'headless', docIndex: number | null, maxSide: number) {
    const result = await this.router.capture(mode, docIndex, maxSide);
    this.calls += 1;
    const destination = path.join(AUDIT, `iteration-${this.calls}.png`);
    writeFileSync(destination, Buffer.from(result.pngBase64, 'base64'));
    return result;
  }
}

const vision = new ScriptedVision();
const capture = new RecordingCapture(new CaptureRouter(mcp, 'headless'));
const events: Array<Record<string, unknown>> = [];

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

console.log('auditing…\n');

const outcome = await runCorrection(
  {
    mcp,
    vision: vision as unknown as OpenAI,
    openaiModel: 'gpt-4o',
    capture: capture as unknown as CaptureRouter,
    snapshotPrefix: 'tone',
    log: (evt) => events.push(evt),
  },
  path.join(READ, 'master.png'),
  path.join(WRITE, 'corrected.png'),
  4,
);

const correctedPath = path.join(WRITE, 'corrected.png');
const masterReadPath = path.join(READ, 'master.png');
const masterWritePath = path.join(WRITE, 'master.png');

await check('loop converged with exit code 0', () => {
  assert.equal(outcome.code, 0);
});

await check('trajectory is the bootstrap state plus one state per audit', () => {
  assert.equal(outcome.trajectory.length, 3);
  assert.deepEqual(outcome.trajectory.map((s) => s.iteration), [0, 1, 2]);
  assert.equal(outcome.trajectory[0]!.verdict, null);
  assert.equal(outcome.trajectory[1]!.verdict?.status, 'low_contrast');
  assert.equal(outcome.trajectory[2]!.verdict?.status, 'ok');
  assert.notEqual(outcome.trajectory[1]!.lastRenderHash, '');
});

await check('vision model was asked twice, one render each', () => {
  assert.equal(vision.calls, 2);
  assert.equal(capture.calls, 2);
});

await check('every iteration logged a snapshot and a render hash', () => {
  assert.equal(events.length, 2);
  for (const evt of events) {
    assert.match(String(evt.snapshot), /^tone_iter_\d$/);
    assert.match(String(evt.renderHash), /^[0-9a-f]{64}$/);
  }
});

await check('audited renders are distinct, real PNG files', () => {
  const frames = [1, 2].map((n) => path.join(AUDIT, `iteration-${n}.png`));
  for (const frame of frames) {
    assert.ok(existsSync(frame), `${frame} missing`);
    const buffer = readFileSync(frame);
    const { width, height } = pngSize(buffer);
    assert.equal(width, 320);
    assert.equal(height, 200);
    assert.ok(buffer.length > 1000, `${frame} is only ${buffer.length} bytes`);
  }
  const hashes = frames.map(sha256);
  assert.notEqual(hashes[0], hashes[1], 'the two audits rendered identical pixels');
});

await check('corrected PNG was written and the master left untouched', () => {
  assert.ok(existsSync(correctedPath), 'corrected.png missing');
  assert.ok(readFileSync(correctedPath).length > 1000);
  assert.equal(sha256(masterReadPath), masterHashBefore, 'the read-root master changed');
  assert.equal(sha256(masterWritePath), masterHashBefore, 'the original master changed');
  assert.notEqual(sha256(correctedPath), masterHashBefore, 'corrected copy is unchanged');
});

await check('validator rejects malformed curves and accepts the valid one', () => {
  assert.equal(validateCurve([[0, 0], [64, 40], [255, 255]]).ok, false);
  assert.equal(validateCurve([[0, 0], [200, 40], [64, 200], [255, 255]]).ok, false);
  assert.equal(validateCurve([[0, 0], [64, 90], [192, 40], [255, 255]]).ok, false);
  assert.equal(validateCurve([[0, 0], [64, 40], [192, 215], [255, 255]]).ok, true);
});

await check('trajectory and event log were written for replay', () => {
  writeFileSync(
    path.join(TRAJECTORY, 'events.jsonl'),
    events.map((evt) => JSON.stringify(evt)).join('\n') + '\n',
  );
  writeFileSync(
    path.join(TRAJECTORY, 'trajectory.json'),
    JSON.stringify({ code: outcome.code, trajectory: outcome.trajectory }, null, 2) + '\n',
  );
  assert.ok(existsSync(path.join(TRAJECTORY, 'events.jsonl')));
  assert.equal(readFileSync(path.join(TRAJECTORY, 'events.jsonl'), 'utf8').trim().split('\n').length, 2);
});

// Make the headline assets easy to inspect without descending into workspace/.
copyFileSync(masterPath, path.join(OUT, 'master.png'));
copyFileSync(correctedPath, path.join(OUT, 'corrected.png'));

await mcp.close();

const report = {
  exercise: 3,
  checks: passed + failed,
  passed,
  failed,
  results,
  exitCode: outcome.code,
  visionCalls: vision.calls,
  renderCalls: capture.calls,
  masterSha256: masterHashBefore,
  correctedSha256: existsSync(correctedPath) ? sha256(correctedPath) : null,
  trajectoryStates: outcome.trajectory.length,
  artifacts: [
    'master.png',
    'corrected.png',
    'audit/iteration-1.png',
    'audit/iteration-2.png',
    'trajectory/events.jsonl',
    'trajectory/trajectory.json',
    'report.json',
  ],
};
writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2) + '\n');

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
