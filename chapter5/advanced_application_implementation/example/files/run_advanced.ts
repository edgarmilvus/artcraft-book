/**
 * Harness for the chapter's advanced example.
 *
 * Drives the full CreativeForge pipeline — catalog, router, pool, real
 * PhotoCraft worker — with a scripted model, so no API key is needed and
 * the sequence of tool calls is deterministic.
 */
import Anthropic from '@anthropic-ai/sdk';
import { runBrief, type LlmClient } from './src/agent-loop.js';
import { strict as assert } from 'node:assert';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import * as path from 'node:path';

const HERE = import.meta.dirname;
const TMP = path.join(HERE, 'out', 'tmp');

type Step =
  | { text: string }
  | { tools: Array<{ name: string; input: Record<string, unknown> }> };

const SCRIPT: Step[] = [
  {
    tools: [
      { name: 'photocraft__doc_new', input: { width: 1200, height: 600, background: 'white', name: 'Brief' } },
    ],
  },
  {
    tools: [
      {
        name: 'photocraft__command_run',
        input: {
          id: 'type.create',
          params: { text: 'Q3 LAUNCH', font: 'Inter-Bold', size: 120, color: '#0b3d2e', x: 120, y: 280 },
        },
      },
    ],
  },
  { tools: [{ name: 'photocraft__doc_save', input: { path: 'brief.png', format: 'png' } }] },
  { text: 'Saved brief.png, a 1200x600 launch banner.' },
];

/** Records what the loop sent and replays SCRIPT one turn at a time. */
class ScriptedModel implements LlmClient {
  public offered: string[][] = [];
  public toolResults: string[] = [];

  public readonly messages = {
    create: async (body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> => {
      this.offered.push((body.tools ?? []).map((t) => t.name));

      // Only the newest user turn carries fresh results.
      this.toolResults = [];
      for (const m of body.messages) {
        if (m.role !== 'user' || typeof m.content === 'string') continue;
        for (const block of m.content) {
          if (block.type === 'tool_result') {
            this.toolResults.push(String(block.content));
          }
        }
      }

      const turn = body.messages.filter((m) => m.role === 'assistant').length;
      const step = SCRIPT[turn] ?? { text: 'done' };
      const content =
        'text' in step
          ? [{ type: 'text' as const, text: step.text }]
          : step.tools.map((t, i) => ({
              type: 'tool_use' as const,
              id: `toolu_${turn}_${i}`,
              name: t.name,
              input: t.input,
            }));

      return {
        id: `msg_${turn}`,
        type: 'message',
        role: 'assistant',
        model: body.model,
        content,
        stop_reason: 'text' in step ? 'end_turn' : 'tool_use',
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      } as unknown as Anthropic.Message;
    },
  };
}

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

function pngSize(file: string) {
  const buf = readFileSync(file);
  assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

rmSync(path.join(HERE, 'out'), { recursive: true, force: true });
process.env.TMPDIR = TMP;

const model = new ScriptedModel();
const outcome = await runBrief(
  'tenant-42',
  'Design a 1200x600 launch banner with the headline Q3 LAUNCH and save it as brief.png.',
  ['photocraft'],
  false,
  model,
);

const sandbox = path.join(TMP, 'creativeforge');
const sessionDir = readdirSync(sandbox).find((d) => d.startsWith('tenant-42-'));
const png = path.join(sandbox, sessionDir!, 'write', 'brief.png');

console.log('brief complete\n');

await check('catalog is the worker registry intersected with META', () => {
  assert.equal(model.offered.length, SCRIPT.length);
  const first = model.offered[0]!;
  assert.equal(first.length, 6, `expected 6 tools, got ${first.length}: ${first.join(', ')}`);
  assert.ok(first.every((n) => n.startsWith('photocraft__')), first.join(', '));
  assert.ok(first.includes('photocraft__command_run'));
});

await check('loop runs one turn per scripted step', () => {
  assert.equal(outcome.turns, SCRIPT.length);
  assert.match(outcome.finalMessage, /Saved brief\.png/);
});

await check('doc_save is recorded in the tenant output list', () => {
  assert.deepEqual(outcome.outputs, ['brief.png']);
});

await check('engine wrote an 1200x600 PNG under the session write root', () => {
  assert.ok(existsSync(png), png);
  assert.deepEqual(pngSize(png), { width: 1200, height: 600 });
});

await check('every tool result came back without an error', () => {
  assert.equal(model.toolResults.length, 3);
  for (const r of model.toolResults) {
    assert.ok(!/^error:/.test(r), r.slice(0, 200));
  }
});

await check('billing is derived from audited worker time', () => {
  assert.ok(outcome.costCents > 0, `costCents=${outcome.costCents}`);
});

await check('session sandbox is disposed of its workers', async () => {
  // A second brief must get its own sandbox, never reuse the first one.
  const again = await runBrief('tenant-42', 'noop', ['photocraft'], false, {
    messages: {
      create: async () =>
        ({
          content: [{ type: 'text', text: 'nothing to do' }],
          role: 'assistant',
        }) as unknown as Anthropic.Message,
    },
  });
  assert.notEqual(again.sessionId, outcome.sessionId);
});

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
