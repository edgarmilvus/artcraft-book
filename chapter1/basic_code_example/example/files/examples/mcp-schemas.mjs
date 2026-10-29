// examples/mcp-schemas.mjs — dump the real input schemas for doc_new etc.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const transport = new StdioClientTransport({
  command: process.env.PHOTOCRAFT_BIN ?? 'photocraft-cli',
  args: ['mcp', '--automation-read-root', root, '--automation-write-root', root],
});
const mcp = new Client({ name: 'cap1-schemas', version: '1.0.0' }, { capabilities: {} });
await mcp.connect(transport);
try {
  const { tools } = await mcp.listTools();
  for (const t of tools) {
    if (['doc_new', 'doc_save', 'doc_export', 'command_run', 'command_batch', 'doc_render_preview'].includes(t.name)) {
      console.log(`### ${t.name}`);
      console.log(JSON.stringify(t.inputSchema));
      console.log();
    }
  }
} finally {
  await mcp.close();
}
