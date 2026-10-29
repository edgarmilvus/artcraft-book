/**
 * Runs the chapter's end-to-end "Q3 launch" workflow against PhotoCraft:
 * one gradient fill layer and two type layers, applied as a single
 * `command_batch` call, then saved as a 1920x1080 PNG.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { strict as assert } from 'node:assert';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import * as path from 'node:path';

const HERE = import.meta.dirname;
const ROOT = path.join(HERE, 'out', 'workflow');
const READ = path.join(ROOT, 'read');
const WRITE = path.join(ROOT, 'write');

rmSync(ROOT, { recursive: true, force: true });
mkdirSync(READ, { recursive: true });
mkdirSync(WRITE, { recursive: true });

const steps = JSON.parse(readFileSync(path.join(HERE, '07_end_to_end_workflow_the_acme_q3.json'), 'utf8')) as {
  steps: Array<{ id: string; params: Record<string, unknown> }>;
  stop_on_error: boolean;
};

const transport = new StdioClientTransport({
  command: 'photocraft-cli',
  args: ['mcp', '--automation-read-root', READ, '--automation-write-root', WRITE],
});
const client = new Client({ name: 'workflow-harness', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

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

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

await client.callTool({
  name: 'doc_new',
  arguments: { width: 1920, height: 1080, mode: 'rgb', background: 'white', name: 'Q3' },
});

const batch = await client.callTool({
  name: 'command_batch',
  arguments: { steps: steps.steps, stop_on_error: steps.stop_on_error },
});

await client.callTool({
  name: 'doc_save',
  arguments: { path: 'q3-launch.png', format: 'png' },
});

console.log('workflow executed\n');

await check('all three workflow steps succeeded', () => {
  const payload = JSON.parse(text(batch)) as { results?: unknown[]; ok?: boolean };
  assert.ok(!(batch as { isError?: boolean }).isError, text(batch));
  assert.ok(payload.results?.length === 3 || payload.ok === true, text(batch));
});

await check('saved PNG is 1920x1080', () => {
  const buf = readFileSync(path.join(WRITE, 'q3-launch.png'));
  assert.equal(buf.subarray(1, 4).toString('ascii'), 'PNG');
  assert.deepEqual({ w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) }, { w: 1920, h: 1080 });
});

await check('document carries gradient + two type layers', async () => {
  const info = await client.callTool({ name: 'doc_inspect', arguments: {} });
  const tree = text(info);
  assert.match(tree, /Q3 LAUNCH/);
  assert.match(tree, /Shipping September 15/);
  assert.equal((tree.match(/Gradient/gi) ?? []).length >= 1, true, tree.slice(0, 400));
});

await client.close();
console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
