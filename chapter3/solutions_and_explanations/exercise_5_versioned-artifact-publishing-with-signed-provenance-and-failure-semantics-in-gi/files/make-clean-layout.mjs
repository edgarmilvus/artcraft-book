// make-clean-layout.mjs — a no-link layout for the positive release.
// The text uses DesignCraft's bundled Source Serif 4, so font.list is clean.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync } from "node:fs";
const root = process.argv[2] ?? process.cwd();
mkdirSync(`${root}/assets`, { recursive: true });
const t = new StdioClientTransport({ command: "designcraft-cli", args: ["mcp"], cwd: root, stderr: "pipe" });
t.stderr?.on("data", () => undefined);
const c = new Client({ name: "mk-clean", version: "1" }, { capabilities: {} });
await c.connect(t);
const unwrap = (r) => { const b = r.content?.find((x) => x.type === "text"); try { return JSON.parse(b.text); } catch { return b.text; } };
const call = async (n, a = {}) => { const r = await c.callTool({ name: n, arguments: a }); if (r.isError) throw new Error(`${n}: ${JSON.stringify(r)}`); return unwrap(r); };
await call("new_document", { width: 612, height: 792, pages: 1, margins: 72, title: "Clean Catalog" });
await call("execute", {
  command: "frame.create",
  params: { rect: [72, 72, 468, 120], content: "text", text: "Clean Catalog\nMonthly release" },
});
console.log(JSON.stringify(await call("save_document", { path: "clean-layout.designcraft" })));
await c.close();
