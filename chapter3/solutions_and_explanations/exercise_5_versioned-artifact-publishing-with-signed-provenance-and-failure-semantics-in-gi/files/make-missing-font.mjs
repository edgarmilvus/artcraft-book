// make-missing-font.mjs — a layout that references an uninstalled font.
// The collector's font.list must report missing=true so the CI job blocks.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
const root = process.argv[2] ?? process.cwd();
const t = new StdioClientTransport({ command: "designcraft-cli", args: ["mcp"], cwd: root, stderr: "pipe" });
t.stderr?.on("data", () => undefined);
const c = new Client({ name: "mk-missing-font", version: "1" }, { capabilities: {} });
await c.connect(t);
const unwrap = (r) => { const b = r.content?.find((x) => x.type === "text"); try { return JSON.parse(b.text); } catch { return b.text; } };
const call = async (n, a = {}) => { const r = await c.callTool({ name: n, arguments: a }); if (r.isError) throw new Error(`${n}: ${JSON.stringify(r)}`); return unwrap(r); };
const text = "Missing font text";
await call("new_document", { width: 612, height: 792, pages: 1, margins: 72, title: "Missing Font" });
const frame = await call("execute", {
  command: "frame.create",
  params: { rect: [72, 72, 468, 120], content: "text", text },
});
await call("execute", {
  command: "style.character.create",
  params: { name: "Bogus", chars: { fontFamily: "NoSuchFont", fontStyle: "Regular" } },
});
await call("execute", {
  command: "text.select",
  params: { story: frame.story, anchor: 0, focus: text.length },
});
await call("execute", { command: "style.character.apply", params: { name: "Bogus" } });
console.log(JSON.stringify(await call("save_document", { path: "missing-font.designcraft" })));
await c.close();
