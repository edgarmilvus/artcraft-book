/**
 * Minimal MCP bridge between a coding agent and the native
 * Photocraft MCP server. Exposes one composite tool,
 * `hello_world_banner`, that builds a PNG end-to-end.
 *
 * Transport in:  stdio (agent -> this process)
 * Transport out: stdio (this process -> photocraft-cli mcp)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Workspace directory that both roots of the sandbox are pinned to.
 * Photocraft will refuse any read or write outside of it.
 * @constant
 */
const WORKSPACE: string =
  process.env.ARTCRAFT_WORKSPACE ??
  path.join(os.tmpdir(), "artcraft-bridge");

/**
 * Downstream factory: spawn and connect to the native ArtCraft MCP server.
 *
 * Every invocation builds a *fresh* client + child process so that a
 * bridge request can never observe or corrupt the state of another.
 * The `--automation-read-root` / `--automation-write-root` flags are the
 * capability-scoping mechanism that limits the CLI to `WORKSPACE`.
 *
 * @returns {Promise<Client>} A connected MCP client bound to Photocraft.
 */
async function connectPhotoCraft(): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "photocraft-cli",
    args: [
      "mcp",
      "--automation-read-root", WORKSPACE,
      "--automation-write-root", WORKSPACE,
    ],
    env: { ...process.env, RUST_LOG: process.env.RUST_LOG ?? "warn" },
  });

  const client = new Client(
    { name: "artcraft-bridge", version: "0.1.0" },
    { capabilities: {} },
  );

  await client.connect(transport);
  return client;
}

/**
 * Upstream MCP server that the coding agent sees.
 * Tool names are the agent's vocabulary — keep them business-level.
 */
const server = new McpServer({
  name: "artcraft-bridge",
  version: "0.1.0",
});

/**
 * Composite tool: Hello World banner.
 *
 * Registers a single MCP tool whose implementation fans out into three
 * Photocraft commands (`doc_new`, `command_run`, `doc_save`). The
 * schema is validated by zod before any work begins; default values
 * keep the LLM's payloads small and unambiguous.
 */
server.registerTool(
  "hello_world_banner",
  {
    title: "Hello World Banner",
    description:
      "Creates a 800x400 PNG banner with a single line of text and saves it under the bridge's write root.",
    inputSchema: {
      greeting: z
        .string()
        .min(1)
        .max(80)
        .default("Hello, World!")
        .describe("The line of text to draw on the banner."),
      output: z
        .string()
        .regex(/^[A-Za-z0-9_.-]+\.png$/, "must be a bare *.png filename")
        .default("hello.png")
        .describe("Filename (relative to the write root) of the PNG to write."),
    },
  },
  async ({ greeting, output }) => {
    // Each request gets its own isolated Photocraft process. The client is
    // declared outside the `try` so the `finally` block can still close it,
    // and created inside so a failed handshake is reported through the
    // same `hello_world_banner failed:` contract as any other error.
    let pc: Client | undefined;

    try {
      pc = await connectPhotoCraft();

      // ── Step 1: create an 800x400 white RGB canvas ──────────────
      await pc.callTool({
        name: "doc_new",
        arguments: {
          width: 800,
          height: 400,
          mode: "rgb",
          depth: 8,
          background: "white",
          name: "HelloBanner",
        },
      });

      // ── Step 2: draw the greeting with a headline-sized face ─────
      // `type.create` is one of PhotoCraft's 892 registered commands;
      // we reach it through the generic `command_run` meta-tool.
      await pc.callTool({
        name: "command_run",
        arguments: {
          id: "type.create",
          params: {
            x: 80,
            y: 220,
            text: greeting,
            font: "Inter-Bold",
            size: 88,
            color: "#111111",
          },
        },
      });

      // ── Step 3: flatten and export to PNG ────────────────────────
      // `doc_save` infers the encoder from the extension and
      // performs an atomic write under the write root.
      const saved = await pc.callTool({
        name: "doc_save",
        arguments: { path: output, format: "png" },
      });

      // ── Step 4: return a compact textual summary to the agent ────
      return {
        content: [
          {
            type: "text" as const,
            text: `Wrote ${output} (800x400 PNG). Upstream result: ${JSON.stringify(
              saved,
            ).slice(0, 400)}`,
          },
        ],
      };
    } catch (err) {
      // Never let a child failure escape as an unhandled rejection —
      // MCP expects a well-formed CallToolResult with `isError`.
      const message = err instanceof Error ? err.message : String(err);
      return {
        isError: true,
        content: [
          {
            type: "text" as const,
            text: `hello_world_banner failed: ${message}`,
          },
        ],
      };
    } finally {
      // Deterministic teardown: the child exits even if we crashed.
      await pc?.close();
    }
  },
);

/**
 * Entry point. Stdio transport is one line on each side —
 * the SDK handles framing, request IDs and JSON-RPC envelopes.
 */
async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // `console.error` is safe here: it goes to stderr, which the host
  // surfaces as a log line, not as a protocol frame on stdout.
  console.error(`[bridge] ready — workspace=${WORKSPACE}`);
}

main().catch((err) => {
  console.error("[bridge] fatal:", err);
  process.exit(1);
});

/**
 * Last line of defence: a rejected promise that escaped every `await`
 * would otherwise leave the child Photocraft process running.
 */
process.on("unhandledRejection", (err) => {
  console.error("[bridge] unhandledRejection:", err);
  process.exit(1);
});
