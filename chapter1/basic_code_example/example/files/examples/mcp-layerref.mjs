// examples/mcp-layerref.mjs — does the engine resolve symbolic {"$layer":"name"} refs?
// The Advanced project's compiler emits params like {"layer":{"$layer":"smoke/bg"}}.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const bin = process.env.PHOTOCRAFT_BIN ?? 'photocraft-cli';

const transport = new StdioClientTransport({
  command: bin,
  args: ['mcp', '--automation-read-root', root, '--automation-write-root', root],
});
const mcp = new Client({ name: 'cap1-layerref', version: '1.0.0' }, { capabilities: {} });
await mcp.connect(transport);

const call = async (name, args) => {
  const r = await mcp.callTool({ name, arguments: args ?? {} });
  const t = r.content?.find((c) => c.type === 'text')?.text;
  const out = t ? JSON.parse(t) : r.structuredContent;
  return { isError: r.isError, out };
};

try {
  await call('doc_new', { width: 400, height: 300, mode: 'rgb', depth: 8, background: '#101820', name: 'layerref' });
  console.log('shape.create  ->', JSON.stringify(await call('command_run', {
    id: 'shape.create',
    params: { kind: 'rect', rect: [10, 10, 200, 200], fill: '#f2aa4c', name: 'smoke/bg' },
  })).slice(0, 200));

  const renamed = await call('command_run', {
    id: 'layer.setProps',
    params: { layer: { $layer: 'smoke/bg' }, name: 'renamed-by-ref' },
  });
  console.log('layer.setProps($layer) ->', JSON.stringify(renamed).slice(0, 260));

  const insp = await call('doc_inspect');
  const layers = insp.out?.layers ?? insp.out?.result?.layers;
  console.log('layers now    ->', JSON.stringify(layers));
} finally {
  await mcp.close();
}
