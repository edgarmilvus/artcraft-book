// examples/mcp-probe.mjs — proves the MCP stdio bridge works against the real
// engine, mirroring the Chapter 1 "Basic Code Example" pattern.
//
//   PATH="../../../../tools/craft-cli/bin:$PATH" node examples/mcp-probe.mjs
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = process.env.RUN_OUTPUT ?? resolve(root, '..', 'output');
await mkdir(outDir, { recursive: true });
const bin = process.env.PHOTOCRAFT_BIN ?? 'photocraft-cli';

const transport = new StdioClientTransport({
  command: bin,
  args: ['mcp', '--automation-read-root', root, '--automation-write-root', outDir],
});

const mcp = new Client({ name: 'cap1-mcp-probe', version: '1.0.0' }, { capabilities: {} });
await mcp.connect(transport);

try {
  const tools = await mcp.listTools();
  console.log('tools:', tools.tools.map((t) => t.name).join(', '));

  const created = await mcp.callTool({
    name: 'doc_new',
    arguments: { width: 640, height: 360, mode: 'rgb', depth: 8, background: '#101820', name: 'probe' },
  });
  console.log('doc_new ->', JSON.stringify(created.structuredContent ?? created.content));

  const batch = await mcp.callTool({
    name: 'command_batch',
    arguments: {
      steps: [
        { id: 'shape.create', params: { kind: 'rect', rect: [24, 24, 592, 312], fill: '#f2aa4c', name: 'panel' } },
        { id: 'type.create', params: { x: 60, y: 300, text: 'Layered, not flat', font: 'Inter', size: 48, color: '#101820', name: 'headline' } },
      ],
    },
  });
  console.log('command_batch ->', JSON.stringify(batch.structuredContent ?? batch.content).slice(0, 400));

  const exported = await mcp.callTool({
    name: 'doc_export',
    arguments: { path: 'probe.png' },
  });
  console.log('doc_export ->', JSON.stringify(exported.structuredContent ?? exported.content).slice(0, 300));
} finally {
  await mcp.close();
}
