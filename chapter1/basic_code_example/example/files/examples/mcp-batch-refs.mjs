// examples/mcp-batch-refs.mjs — does the real command_batch resolve `$N.…` refs?
// The Chapter 1 exercises/solutions rely on cross-step references like `$0.layer`
// and `$0.path` emitted by earlier steps.
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
const mcp = new Client({ name: 'cap1-batch-refs', version: '1.0.0' }, { capabilities: {} });
await mcp.connect(transport);

const call = async (name, args) => {
  const r = await mcp.callTool({ name, arguments: args ?? {} });
  const text = r.content?.find((c) => c.type === 'text')?.text;
  return text ? JSON.parse(text) : r.structuredContent;
};

try {
  await call('doc_new', { width: 400, height: 300, mode: 'rgb', depth: 8, background: '#101820', name: 'refs' });

  // step0 makes a rect -> emits { layer }.  step1 deletes the layer from step0.
  const batch = await call('command_batch', {
    steps: [
      { id: 'shape.create', params: { kind: 'rect', rect: [20, 20, 180, 180], fill: '#f2aa4c', name: 'keep' } },
      { id: 'shape.create', params: { kind: 'ellipse', rect: [200, 20, 380, 180], fill: '#e5484d', name: 'drop' } },
      { id: 'layer.delete', params: { layer: '$1.layer' } },
    ],
  });
  console.log('batch ok:', batch.completed, 'failed:', batch.failed);
  console.log('step results:', JSON.stringify(batch.results.map((r) => ({ ok: r.ok, layer: r.result?.layer, error: r.error }))));

  const inspect = await call('doc_inspect');
  const names = (inspect.layers ?? []).map?.((l) => l.name) ?? inspect.layers;
  console.log('layers after batch:', JSON.stringify(names));
} finally {
  await mcp.close();
}
