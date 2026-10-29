/**
 * Runs the chapter's one-line shell recipe exactly as written: the script
 * pins PhotoCraft to a session sandbox and speaks MCP over stdio. The
 * harness creates the sandbox the script expects and performs the
 * initialize handshake, then asserts the server advertises its tools.
 */
import { spawn } from 'node:child_process';
import { strict as assert } from 'node:assert';
import { mkdirSync } from 'node:fs';
import * as path from 'node:path';

const SCRIPT = path.join(import.meta.dirname, '06_end_to_end_workflow_the_acme_q3.sh');
const SANDBOX = '/tmp/creativeforge/tenant-42-abc123';
mkdirSync(path.join(SANDBOX, 'read'), { recursive: true });
mkdirSync(path.join(SANDBOX, 'write'), { recursive: true });

const child = spawn('sh', [SCRIPT], { stdio: ['pipe', 'pipe', 'pipe'] });

const lines: string[] = [];
let buffer = '';
child.stdout.on('data', (chunk: Buffer) => {
  buffer += chunk.toString('utf8');
  const parts = buffer.split('\n');
  buffer = parts.pop() ?? '';
  lines.push(...parts.filter(Boolean));
});
let stderr = '';
child.stderr.on('data', (c: Buffer) => (stderr += c.toString('utf8')));

const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + '\n');
send({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'shell-harness', version: '1.0.0' },
  },
});
send({ jsonrpc: '2.0', method: 'notifications/initialized' });
send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });

const deadline = Date.now() + 15_000;
while (!lines.some((l) => l.includes('"id":2')) && Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 100));
}
child.stdin.end();
child.kill();

const frames = lines.map((l) => JSON.parse(l) as { id?: number; result?: { serverInfo?: { name: string }; tools?: Array<{ name: string }> } });

let passed = 0;
let failed = 0;
function check(name: string, fn: () => void) {
  try {
    fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

console.log('shell recipe\n');

check('the script starts an MCP server on stdio', () => {
  assert.equal(frames.length >= 2, true, `frames=${frames.length} stderr=${stderr.slice(0, 300)}`);
  assert.ok(frames.find((f) => f.id === 1)?.result?.serverInfo, JSON.stringify(frames[0]));
});

check('the server advertises its tool surface', () => {
  const tools = frames.find((f) => f.id === 2)?.result?.tools ?? [];
  assert.equal(tools.length, 25, `got ${tools.length}`);
  assert.ok(tools.some((t) => t.name === 'doc_new'));
  assert.ok(tools.some((t) => t.name === 'command_run'));
});

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
