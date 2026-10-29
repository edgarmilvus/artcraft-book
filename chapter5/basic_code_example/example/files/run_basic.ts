/**
 * Harness for the chapter's basic example.
 *
 * Plays the role of the coding agent: spawns `src/bridge.ts` over stdio,
 * lists the composite tool, calls it, and checks the PNG lands under the
 * bridge's write root. Also exercises schema validation, the handler's
 * error path and teardown.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { strict as assert } from "node:assert";
import { existsSync, readFileSync, rmSync, mkdirSync } from "node:fs";
import * as path from "node:path";

const HERE = import.meta.dirname;
const OUT = path.join(HERE, "out");
const TSX = path.join(HERE, "node_modules", ".bin", "tsx");

let passed = 0;
let failed = 0;
async function check(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.log(`FAIL ${name}: ${err instanceof Error ? err.message : err}`);
  }
}

function pngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  assert.equal(buf.subarray(1, 4).toString("ascii"), "PNG", "not a PNG");
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function startBridge(env: Record<string, string | undefined>) {
  const transport = new StdioClientTransport({
    command: TSX,
    args: [path.join(HERE, "src", "bridge.ts")],
    cwd: HERE,
    env: Object.fromEntries(
      Object.entries(env).filter(([, v]) => v !== undefined),
    ) as Record<string, string>,
    stderr: "pipe",
  });
  const client = new Client({ name: "agent", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const { client, transport } = await startBridge({
  ...process.env,
  ARTCRAFT_WORKSPACE: OUT,
});

const { tools } = await client.listTools();
const bridgePid = transport.pid;

console.log("connected to bridge\n");

await check("tool surface", () => {
  assert.equal(tools.length, 1, `expected 1 tool, got ${tools.length}`);
  assert.equal(tools[0]?.name, "hello_world_banner");
  const props = Object.keys((tools[0]?.inputSchema as { properties?: object }).properties ?? {});
  assert.deepEqual(props.sort(), ["greeting", "output"]);
});

await check("defaults produce out/hello.png", async () => {
  const reply = await client.callTool({ name: "hello_world_banner", arguments: {} });
  assert.ok(!reply.isError, JSON.stringify(reply));
  const text = (reply.content as Array<{ text: string }>)[0]!.text;
  assert.match(text, /Wrote hello\.png \(800x400 PNG\)/);
  assert.deepEqual(pngSize(path.join(OUT, "hello.png")), { width: 800, height: 400 });
});

await check("custom greeting and filename", async () => {
  const reply = await client.callTool({
    name: "hello_world_banner",
    arguments: { greeting: "Chapter Five", output: "chapter5.png" },
  });
  assert.ok(!reply.isError, JSON.stringify(reply));
  assert.deepEqual(pngSize(path.join(OUT, "chapter5.png")), { width: 800, height: 400 });
});

await check("schema rejects a path instead of a bare filename", async () => {
  const reply = await client.callTool({
    name: "hello_world_banner",
    arguments: { output: "sub/evil.png" },
  });
  assert.equal(reply.isError, true);
  const text = (reply.content as Array<{ text: string }>)[0]!.text;
  assert.match(text, /Invalid arguments for tool hello_world_banner/);
  assert.match(text, /must be a bare \*\.png filename/);
  assert.equal(existsSync(path.join(OUT, "sub")), false);
});

await check("schema rejects a 90-character greeting", async () => {
  const reply = await client.callTool({
    name: "hello_world_banner",
    arguments: { greeting: "x".repeat(90) },
  });
  assert.equal(reply.isError, true);
});

await check("bridge exits when the agent disconnects", async () => {
  assert.ok(bridgePid, "transport exposes the child pid");
  await client.close();
  await new Promise((r) => setTimeout(r, 500));
  let alive = true;
  try {
    process.kill(bridgePid!, 0);
  } catch {
    alive = false;
  }
  assert.equal(alive, false, `bridge pid ${bridgePid} still alive`);
});

// A second bridge whose PATH resolves `photocraft-cli` to a shim that exits
// immediately: the handler's catch block has to turn the failed handshake
// into a well-formed MCP error instead of an unhandled rejection.
const noEngine = await startBridge({
  ...process.env,
  PATH: `${path.join(HERE, "_shim")}:${process.env.PATH}`,
  ARTCRAFT_WORKSPACE: OUT,
});

await check("missing engine becomes a handler-level MCP error", async () => {
  const reply = await noEngine.client.callTool({
    name: "hello_world_banner",
    arguments: { output: "nope.png" },
  });
  assert.equal(reply.isError, true);
  const text = (reply.content as Array<{ text: string }>)[0]!.text;
  assert.match(text, /hello_world_banner failed:/);
});

await noEngine.client.close();

console.log(`\n${passed}/${passed + failed} checks passed`);
process.exit(failed === 0 ? 0 : 1);
