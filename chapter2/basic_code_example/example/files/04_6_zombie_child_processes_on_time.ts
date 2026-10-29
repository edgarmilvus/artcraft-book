// ── Pitfall 6, corrected ────────────────────────────────────────────────
// The book's snippet uses `args: [...]` as a placeholder and leaves `CLI`
// undefined, so it cannot be compiled or run as written. This version is
// self-contained: it connects, does one call, and closes the child process
// on every path. Run it with `tsx 04_6_zombie_child_processes_on_time.ts`
// and check that the process exits (no orphaned photocraft-cli).
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import * as path from "node:path";

const CLI = "photocraft-cli";
const ROOT = process.env.WRITE_ROOT ?? path.resolve(new URL("../output/", import.meta.url).pathname);

const transport = new StdioClientTransport({
  command: CLI,
  args: ["mcp", "--automation-read-root", ROOT, "--automation-write-root", ROOT],
});
const client = new Client({ name: "agent", version: "1.0.0" }, { capabilities: {} });
try {
  await client.connect(transport);
  // ... session work ...
  const reply = await client.callTool({ name: "session_list", arguments: {} });
  const text = (reply as any).content?.find((b: any) => b.type === "text")?.text;
  console.log("session_list:", text);
} finally {
  // `close()` kills the child; without it the parent exits and leaves a
  // zombie holding a pipe open.
  await client.close().catch(() => {});
}
