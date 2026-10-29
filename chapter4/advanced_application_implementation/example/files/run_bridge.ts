/**
 * Drives the MCP bridge the way an agent host would: spawn the entry point
 * as a child process, speak MCP over its stdio, and call tools through the
 * one shared engine session.
 *
 *   tsx run_bridge.ts
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const tsx = resolve(here, '../../../../node_modules/.bin/tsx');

const ok = (label: string, cond: boolean, detail = ''): boolean => {
  console.log(`${cond ? 'PASS' : 'FAIL'} ${label.padEnd(38)}${detail}`);
  return cond;
};

const env: Record<string, string> = {};
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) env[k] = v;
env.RUN_PORT = process.env.RUN_PORT ?? '7902';

async function main(): Promise<void> {
  const transport = new StdioClientTransport({
    command: tsx,
    args: [resolve(here, 'bridge-entry.ts')],
    env,
    cwd: here,
    stderr: 'inherit',
  });

  const client = new Client({ name: 'bridge-harness', version: '1.0.0' });
  await client.connect(transport);

  const checks: boolean[] = [];

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  checks.push(ok('tools advertised', names.length >= 3, names.join(', ')));
  checks.push(ok('tool: command_run', names.includes('command_run')));
  checks.push(ok('tool: command_batch', names.includes('command_batch')));

  const one = await client.callTool({ name: 'command_run', arguments: { id: 'doc.inspect', params: {} } });
  const oneText = (one.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
  checks.push(ok('command_run doc.inspect', oneText.includes('1920'), oneText.slice(0, 60)));

  const two = await client.callTool({
    name: 'command_batch',
    arguments: {
      steps: [
        { id: 'layer.new.layer', params: { name: 'Type' } },
        { id: 'layer.new.layer', params: { name: 'Badge' } },
      ],
    },
  });
  const twoText = (two.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
  checks.push(ok('command_batch through bridge', twoText.includes('applied'), twoText.slice(0, 60)));

  const ins = await client.callTool({ name: 'doc_inspect', arguments: {} });
  const insText = (ins.content as Array<{ type: string; text?: string }>)[0]?.text ?? '';
  checks.push(ok('tool: doc_inspect', insText.includes('1920'), insText.slice(0, 50)));

  await client.close();

  const failed = checks.filter((c) => !c).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
