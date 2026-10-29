import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync } from "node:fs";
const root = "/tmp/ex6probe";
mkdirSync(root, { recursive: true });
const bin = (n) => `tools/craft-cli/bin/${n}-cli`;
const unwrap = (r) => {
  const blocks = r.content ?? [];
  const text = blocks.find((b) => b.type === "text")?.text;
  const image = blocks.find((b) => b.type === "image");
  if (r.isError) throw new Error(text ?? "tool error");
  if (text !== undefined) { try { return JSON.parse(text); } catch { return text; } }
  if (image?.data !== undefined) return { pngBase64: image.data };
  return {};
};
const connect = async (cli, args = ["mcp"]) => {
  const t = new StdioClientTransport({ command: bin(cli), args, cwd: root, stderr: "pipe" });
  t.stderr?.on("data", () => {});
  const c = new Client({ name: "p", version: "1" }, { capabilities: {} });
  await c.connect(t);
  return c;
};
const call = async (c, n, a = {}) => unwrap(await c.callTool({ name: n, arguments: a }));
const ex = async (c, command, params = {}) => call(c, "execute", { command, params });

const dc = await connect("designcraft");
console.log("dc list", JSON.stringify(await call(dc, "list_commands", {})).slice(0, 200));
console.log("dc file.new", JSON.stringify(await ex(dc, "file.new", { preset: "Letter", pages: 1 })));
console.log("dc frame", JSON.stringify(await ex(dc, "frame.create", { rect: [72, 96, 540, 240], content: "text", text: "Quarterly" })));
console.log("dc style", JSON.stringify(await ex(dc, "style.paragraph.apply", { name: "[Basic Paragraph]" })));
const dci = await call(dc, "inspect_document", {});
console.log("dc inspect", JSON.stringify(dci).slice(0, 1500));
console.log("dc export", JSON.stringify(await ex(dc, "file.exportPdf", { path: "out.pdf", standard: "a2b" })));
await dc.close();

const pc = await connect("pdfcraft", ["mcp", "--root", root]);
const opened = await call(pc, "doc_open", { path: "out.pdf" });
console.log("pc open", JSON.stringify(opened));
const doc = opened.doc ?? 1;
const info = await call(pc, "doc_info", { doc });
console.log("pc info", JSON.stringify(info).slice(0, 1500));
const tx = await call(pc, "text_extract", { doc, pages: [1] });
console.log("pc text", JSON.stringify(tx).slice(0, 1000));
const pr = await call(pc, "page_render", { doc, page: 1, dpi: 150 });
console.log("pc render keys", Object.keys(pr), JSON.stringify(pr).slice(0, 200));
await pc.close();

const wc = await connect("wordcraft");
console.log("wc list", JSON.stringify(await call(wc, "list_commands", {})).slice(0, 150));
console.log("wc new", JSON.stringify(await call(wc, "new_document", { width: 612, height: 792 })));
console.log("wc insert", JSON.stringify(await ex(wc, "text.insert", { text: "Hello golden world" })));
const wci = await call(wc, "inspect_document", {});
console.log("wc inspect", JSON.stringify(wci).slice(0, 2000));
await wc.close();
