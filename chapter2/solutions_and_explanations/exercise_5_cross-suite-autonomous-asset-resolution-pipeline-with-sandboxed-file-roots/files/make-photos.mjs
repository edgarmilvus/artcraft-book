import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
const out = process.argv[2];
await mkdir(join(out, "imports"), { recursive: true });
const t = new StdioClientTransport({ command: "photocraft-cli", args: ["mcp","--automation-read-root",out,"--automation-write-root",out] });
const c = new Client({ name: "mk", version: "1" }, { capabilities: {} });
await c.connect(t);
const colors = { ochre: "#b8751f", walnut: "#5b3a1e", sage: "#6b7f5a" };
for (const [name, color] of Object.entries(colors)) {
  await c.callTool({ name: "doc_new", arguments: { width: 2400, height: 1600, mode: "rgb", depth: 8, background: color } });
  await c.callTool({ name: "command_run", arguments: { id: "layer.newFillLayer.gradient", params: { from: color, to: "#f2e6d0", angle: 45, style: "linear" } } });
  await c.callTool({ name: "command_run", arguments: { id: "layer.newAdjustmentLayer.curves", params: { points: [[0,0],[64,55],[192,205],[255,255]] } } });
  const r = await c.callTool({ name: "doc_save", arguments: { path: `imports/velvet_${name}.jpg`, format: "jpg", quality: 90 } });
  console.log(name, r.isError ? r.content[0].text : "saved");
  await c.callTool({ name: "doc_close", arguments: {} });
}
await c.close();
