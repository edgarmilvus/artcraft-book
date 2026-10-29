// examples/mcp-place.mjs — check what kind of layer doc_place creates.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..'); // project dir (has assets/hero.png)
const transport = new StdioClientTransport({
  command: process.env.PHOTOCRAFT_BIN ?? 'photocraft-cli',
  args: ['mcp', '--automation-read-root', root, '--automation-write-root', root],
});
const mcp = new Client({ name: 'cap1-place', version: '1.0.0' }, { capabilities: {} });
await mcp.connect(transport);

const call = async (name, args) => {
  const r = await mcp.callTool({ name, arguments: args ?? {} });
  const t = r.content?.find((c) => c.type === 'text')?.text;
  return { isError: r.isError, out: t ? JSON.parse(t) : r.structuredContent };
};

try {
  await call('doc_new', { width: 1920, height: 1080, mode: 'rgb', depth: 8, background: '#101820', name: 'place' });
  const placed = await call('doc_place', { path: 'assets/hero.png', fit: false, center: [960, 540] });
  console.log('doc_place ->', JSON.stringify(placed).slice(0, 300));

  const insp = await call('doc_inspect');
  const layers = insp.out?.layers ?? insp.out?.result?.layers;
  console.log('layer ->', JSON.stringify((layers ?? []).map((l) => ({ id: l.id, name: l.name, kind: l.kind, hasSmart: l.smartObject ?? l.isSmartObject ?? null }))));
} finally {
  await mcp.close();
}
