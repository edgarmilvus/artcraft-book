// build-manuscript.mjs — WordCraft fixture with three tracked changes:
//   * an editor insert (the policy accepts it),
//   * an editor delete (the policy rejects it, so the text stays),
//   * an author insert (the policy leaves it tracked for the author to finish).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync } from "node:fs";

const root = process.argv[2] ?? process.cwd();
mkdirSync(`${root}/in`, { recursive: true });
const transport = new StdioClientTransport({ command: "wordcraft-cli", args: ["mcp"], cwd: root, stderr: "pipe" });
transport.stderr?.on("data", () => undefined);
const client = new Client({ name: "make-manuscript", version: "1" }, { capabilities: {} });
await client.connect(transport);
const text = (r) => {
  const block = r.content?.find((c) => c.type === "text");
  try { return JSON.parse(block.text); } catch { return block.text; }
};
const call = async (name, args = {}) => {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(result)}`);
  return text(result);
};
const ex = async (command, params = {}) => {
  const result = await call("execute", { command, params });
  if (result && result.ok === false) throw new Error(`${command}: ${JSON.stringify(result)}`);
  return result;
};

await call("new_document", { width: 612, height: 792 });
// WordCraft's blank document ships a subset of the Word styles. Create the
// missing author-style vocabulary so the fixture exercises the style map.
const listed = await ex("styles.list", {});
const existing = new Set(listed.flatMap((s) => [s.id, s.name]));
for (const style of ["Title", "Heading1", "Heading2", "BodyText", "Quote"]) {
  if (!existing.has(style)) await ex("styles.create", { name: style, basedOn: "Normal" });
}
await ex("file.setAuthor", { name: "Author" });
const para = async (style, value) => {
  if (value) await ex("text.insert", { text: value });
  if (style) await ex("para.style", { style });
  await ex("text.newParagraph", {});
};

await para("Title", "Journal of Applied Materials Science");
await para("Heading1", "1. Introduction");
await para("BodyText", "This manuscript studies layered composites under cyclic loading over twelve months. ");
await ex("text.insert", { text: "PREFLIGHT-TARGET: this sentence is deleted by the editor." });
await ex("text.newParagraph", {});
await para("Heading1", "2. Methods");
await para("BodyText", "Samples were conditioned at 23 C and 50% relative humidity for 48 hours. ");

await ex("review.trackChanges", {});
await ex("file.setAuthor", { name: "Editor" });
await ex("text.insert", { text: "EDITOR-INSERT: methods section approved for production. " });
await ex("text.newParagraph", {});
await ex("select.text", { text: "PREFLIGHT-TARGET: this sentence is deleted by the editor." });
await ex("text.delete", {});

await ex("review.trackChanges", {});
await ex("file.setAuthor", { name: "Author" });
await ex("review.trackChanges", {});
await ex("text.insert", { text: "AUTHOR-TRACKED: final approval pending." });
await ex("text.newParagraph", {});
await ex("review.trackChanges", {});

const saved = await call("save_document", { path: "in/JAMS-2026-0089.docx" });
console.log(JSON.stringify({ saved, changes: await ex("review.changes", {}) }));
await client.close();
