// verify-pitfalls.mjs — proves the corrected rollback of Pitfall 2, and that
// the original snippet could never have run.
//
//   node verify-pitfalls.mjs
//
// Mirrors 02_2_treating_commandbatch_as_a_tra.ts against the real engine.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const OUT = new URL("../output/", import.meta.url).pathname;
const transport = new StdioClientTransport({
  command: "photocraft-cli",
  args: ["mcp", "--automation-read-root", OUT, "--automation-write-root", OUT],
});
const client = new Client({ name: "verify-pitfalls", version: "1.0.0" }, { capabilities: {} });
await client.connect(transport);

const text = (r) => r.content?.find((b) => b.type === "text")?.text ?? "";
const layers = async () =>
  JSON.parse(text(await client.callTool({ name: "doc_inspect", arguments: {} }))).layers.map((l) => l.name);

await client.callTool({ name: "doc_new", arguments: { width: 512, height: 512, mode: "rgb", depth: 8, background: "white", name: "pitfalls" } });
console.log("layers at start:", await layers());

const steps = [
  { id: "layer.new.layer", params: { name: "step-ok-1" } },
  { id: "layer.new.layer", params: { name: "step-ok-2" } },
  { id: "this.command.does.not.exist", params: {} },
  { id: "layer.new.layer", params: { name: "step-after-failure" } },
];

const reply = (await client.callTool({ name: "command_batch", arguments: { steps, stop_on_error: true } }));
const batch = JSON.parse(text(reply));
console.log("batch reply:", JSON.stringify({ completed: batch.completed, failed: batch.failed, results: batch.results.map((r) => r.ok) }));
console.log("layers after batch (committed, NOT rolled back):", await layers());

// What the original snippet did: read `res.failed` off the CallToolResult.
console.log("original  (res as any).failed  =", reply.failed, "→ rollback loop runs 0 times");

// The corrected snippet: read the payload, then undo the applied prefix.
if (batch.failed > 0) {
  const firstFailure = batch.results.findIndex((step) => !step.ok);
  const applied = firstFailure === -1 ? batch.results.length : firstFailure;
  console.log("corrected: undoing", applied, "applied step(s)");
  for (let i = 0; i < applied; i++) {
    await client.callTool({ name: "command_run", arguments: { id: "edit.undo" } });
  }
}
const after = await layers();
console.log("layers after rollback:", after);
console.log(after.length === 1 && after[0] === "Background" ? "PASS: rollback restored the document" : "FAIL: rollback left residue");

await client.close();
