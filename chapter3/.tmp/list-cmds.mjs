import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const [bin, ...args] = process.argv.slice(2);
const t = new StdioClientTransport({ command: bin, args: ["mcp", ...args], stderr: "pipe" });
t.stderr?.on("data", () => {});
const c = new Client({ name: "list", version: "1" }, { capabilities: {} });
await c.connect(t);
const names = (await c.listTools()).tools.map(t=>t.name);
for (const tool of ["command_list","list_commands"]) {
 if (!names.includes(tool)) continue;
 const r = await c.callTool({ name: tool, arguments: {} });
 const b = r.content.find(x=>x.type==="text");
 const p = JSON.parse(b.text);
 const arr = Array.isArray(p)?p:(p.commands||[]);
 console.log(JSON.stringify(arr.map(x=>({id:x.id, enabled:x.enabled, params:x.params||x.parameters})), null, 1));
}
await c.close();
