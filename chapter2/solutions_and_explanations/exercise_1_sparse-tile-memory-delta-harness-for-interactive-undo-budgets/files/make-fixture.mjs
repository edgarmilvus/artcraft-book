// make-fixture.mjs — the retouch target the exercise assumes exists.
// The book points at /work/project/retouch/FW26_hero_048.tif, a container path
// with no asset shipped. This builds an equivalent 8000x6000 TIFF.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";

const out = fileURLToPath(new URL("../output/", import.meta.url));
const t = new StdioClientTransport({ command: "photocraft-cli", args: ["mcp","--automation-read-root",out,"--automation-write-root",out] });
const c = new Client({ name: "fixture", version: "1" }, { capabilities: {} });
await c.connect(t);
const t0 = Date.now();
console.log(await c.callTool({ name: "doc_new", arguments: { width: 8000, height: 6000, mode: "rgb", depth: 8, background: "#e8e2d6", name: "FW26_hero_048" } }));
console.log("new doc ms:", Date.now() - t0);
// A neutral base so multiply strokes read on the preview.
console.log(await c.callTool({ name: "command_run", arguments: { id: "edit.fill", params: { contents: "color", color: "#cfc6b4", opacity: 100 } } }));
console.log(await c.callTool({ name: "doc_save", arguments: { path: "retouch/FW26_hero_048.tif" } }));
await c.close();
