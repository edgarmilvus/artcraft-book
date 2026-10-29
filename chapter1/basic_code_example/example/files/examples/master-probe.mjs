// examples/master-probe.mjs — spawn the master MCP server and run one command
// through it, end to end (tool -> `<app>-cli run` -> exported file).
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..');
const outDir = process.env.RUN_OUTPUT ?? resolve(root, '..', 'output');
await mkdir(outDir, { recursive: true });

// The master server lives at the repository root, outside the chapter folder.
// Resolve it from ARTCRAFT_MASTER first, then the shipped locations.
const server =
  process.env.ARTCRAFT_MASTER ??
  [
    resolve(root, '_master_mcp_server.ts'),
    resolve(root, 'master_mcp_server.ts'),
    resolve(root, '..', '..', '..', '..', 'master_mcp_server.ts'),
  ].find((candidate) => existsSync(candidate));
if (!server) {
  console.error('master_mcp_server.ts not found; set ARTCRAFT_MASTER to its path');
  process.exit(1);
}

// tsx is a root dev dependency, not one of this project's; the local install
// exists for next/react and does not carry it.
const tsxBin =
  process.env.TSX_BIN ??
  [
    resolve(root, 'node_modules/.bin/tsx'),
    resolve(root, '..', '..', '..', '..', 'node_modules/.bin/tsx'),
  ].find((candidate) => existsSync(candidate));
if (!tsxBin) {
  console.error('tsx not found; run "npm install" at the repository root');
  process.exit(1);
}

const transport = new StdioClientTransport({
  command: tsxBin,
  args: [server],
  cwd: root,
  env: { ...process.env, ARTCRAFT_ROOT: root, ARTCRAFT_WRITE_ROOT: outDir },
});
const mcp = new Client({ name: 'master-probe', version: '1.0.0' }, { capabilities: {} });
await mcp.connect(transport);

try {
  const { tools } = await mcp.listTools();
  console.log('master tools:', tools.map((t) => t.name).join(', '));

  const r = await mcp.callTool({
    name: 'artcraft_run',
    arguments: {
      app: 'photocraft',
      id: 'shape.create',
      params: { kind: 'rect', rect: [10, 10, 300, 180], fill: '#f2aa4c', name: 'master-rect' },
      out: 'master.png',
      format: 'png',
    },
  });
  const text = r.content?.find((c) => c.type === 'text')?.text ?? '';
  console.log('artcraft_run ->', text.slice(0, 220));
  console.log('isError:', r.isError === true);
} finally {
  await mcp.close();
}
