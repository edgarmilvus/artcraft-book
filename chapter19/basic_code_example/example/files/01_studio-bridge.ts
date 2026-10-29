/**
 * @file studio-bridge.ts
 * @package examples/studio-bridge
 * @summary Minimal governed MCP bridge for an ArtCraft / Storytold studio.
 *
 * This module is the "Hello World" of Chapter 19.  It demonstrates the three
 * runtime pillars that the chapter names explicitly:
 *
 *   1. ECMAScript Modules (ESM) — every dependency is a static `import`,
 *      tree-shakeable, and analyzable by the IDE and by the bundler that
 *      ships the same code to Cursor, Claude Code, and OpenCode.
 *
 *   2. The Node.js Event Loop — the program performs no blocking waits of
 *      its own.  Every I/O operation (`readFile`, `client.connect`,
 *      `client.callTool`) suspends the enclosing async frame and returns
 *      control to the loop, so a single process can host dozens of studios
 *      at once.
 *
 *   3. WebAssembly (WASM) — the ArtCraft engine cores (PhotoCraft, VectorCraft,
 *      FilmCraft, …) are Rust binaries.  A portion of their surface is compiled
 *      to WASM so the same governed command ids run identically in a browser,
 *      a headless CI runner, and the desktop app.  This bridge never touches
 *      the WASM directly, but it depends on that parity: `command_run` is
 *      stable precisely because the underlying engine is stable.
 *
 * Run it with:  node --experimental-strip-types studio-bridge.ts
 * (or compile to JavaScript with any ESM-capable bundler)
 */

// ---------------------------------------------------------------------------
// 1) ESM imports.  Every binding below is a static, resolved import — no
//    `require()`, no dynamic loading, no hidden globals.  This is what lets
//    Cursor's TypeScript server, Claude Code's language model, and OpenCode's
//    linter all reason about the program from the source alone.
// ---------------------------------------------------------------------------
import { readFile } from "node:fs/promises";         // Promise-based fs (Event-Loop friendly)
import { fileURLToPath } from "node:url";            // ESM ships `import.meta.url`, not `__dirname`
import { dirname, isAbsolute, resolve } from "node:path";  // Pure-Path helpers (no I/O)
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";                             // Runtime schema validation

// ---------------------------------------------------------------------------
// 2) The shared studio-config contract.  `.cursor/mcp.json`, Claude Code's
//    settings file, and OpenCode's `mcp.json` all feed the same schema.  The
//    chapter's whole governance point is that this JSON shape is the single
//    source of truth — so the runtime validator and the compile-time type
//    must come from the same declaration.  Zod gives us both from one write.
// ---------------------------------------------------------------------------
const McpServerEntry = z.object({
  command: z.string().min(1),                        // e.g. "photocraft-cli"
  args:    z.array(z.string()).default([]),          // e.g. ["mcp", "--automation-write-root", "."]
  env:     z.record(z.string(), z.string()).default({}),
});

const StudioConfig = z.object({
  mcpServers: z.record(z.string(), McpServerEntry),
});

type StudioConfig = z.infer<typeof StudioConfig>;
type McpServerEntry = z.infer<typeof McpServerEntry>;

/**
 * The directory this module lives in. ESM ships `import.meta.url`, not
 * `__dirname`, and the difference is not cosmetic: a bundle that is loaded
 * from somewhere else entirely still has to know where it came from.
 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// 3) Load the workspace's `.cursor/mcp.json`.  This is the literal file that
//    Cursor reads, and the file that the chapter's cross-agent integration
//    standardizes so every client points at the same servers with the same
//    capabilities.  Reading it here — rather than hardcoding paths — is what
//    makes the studio reproducible across IDEs and headless runners.
// ---------------------------------------------------------------------------
async function loadStudioConfig(
  workspaceRoot: string = MODULE_DIR,
): Promise<StudioConfig> {
  //    A relative workspace root is resolved against the *process's*
  //    working directory — the studio checkout the client was started in —
  //    and never against this module's directory, which is wherever the
  //    bundler happened to put it.
  const root = isAbsolute(workspaceRoot)
    ? workspaceRoot
    : resolve(process.cwd(), workspaceRoot);
  const configPath = resolve(root, ".cursor", "mcp.json");

  //    `readFile` returns a promise.  Awaiting it yields the event loop.
  const raw = await readFile(configPath, "utf8");

  //    JSON.parse is CPU-bound and synchronous by design; keep the input small.
  const parsed: unknown = JSON.parse(raw);

  //    Zod's `.parse` throws a typed `ZodError` if the JSON drifts from the
  //    contract.  Never trust a config file blindly: another IDE may have
  //    written it, or a model may have hallucinated an extra field.
  return StudioConfig.parse(parsed);
}

// ---------------------------------------------------------------------------
// 4) Open a governed MCP session against one ArtCraft binary.  The transport
//    is stdio, so the child process inherits the parent's filesystem sandbox:
//    the `--automation-read-root` and `--automation-write-root` flags declared
//    in `.cursor/mcp.json` are what restrict every subsequent file operation.
// ---------------------------------------------------------------------------
async function openGovernedSession(entry: McpServerEntry): Promise<Client> {
  const transport = new StdioClientTransport({
    command: entry.command,
    args:    entry.args,
    //    Merge the caller's environment with the entry's overrides.  The
    //    studio's shared secret (PHOTOCRAFT_TOKEN, LIGHTCRAFT_TOKEN, …) is
    //    normally injected here by the CI runner or by the user's shell.
    env: { ...process.env, ...entry.env } as Record<string, string>,
  });

  const client = new Client(
    { name: "studio-bridge", version: "1.0.0" },
    { capabilities: {} },
  );

  //    The handshake is asynchronous.  While we wait, the event loop is free
  //    to service other studios' bridges in the same Node process.
  await client.connect(transport);
  return client;
}

// ---------------------------------------------------------------------------
// 5) The main routine.  Every `await` below yields control; none of them
//    blocks the thread.  This is the Event Loop pattern the chapter calls
//    out explicitly: concurrency without threads, scalability without pools.
// ---------------------------------------------------------------------------
async function main(): Promise<void> {
  // 5.a — Load the shared contract.  If `.cursor/mcp.json` is missing or
  //       malformed, this throws before any server is spawned.
  const config = await loadStudioConfig(process.cwd());

  // 5.b — Look up the PhotoCraft entry by name.  The name is the key the
  //       three clients agree on (`photocraft`, `vectorcraft`, `filmcraft`…).
  const photocraft = config.mcpServers.photocraft;
  if (!photocraft) {
    throw new Error(
      "photocraft is not declared in .cursor/mcp.json — refusing to proceed",
    );
  }

  // 5.c — Spawn the engine.  The returned client is our governed handle.
  const client = await openGovernedSession(photocraft);

  try {
    // 5.1 — Create a 1920×1080 RGB document via the official meta-tool.
    //        `doc_new` is the same tool Claude Code, Cursor, and OpenCode
    //        call when their models decide to "start a new canvas".
    const newDoc = await client.callTool({
      name: "doc_new",
      arguments: { width: 1920, height: 1080, mode: "rgb", depth: 8 },
    });
    console.log("doc_new →", newDoc);

    // 5.2 — Run a registered engine command by id.  `command_run` is the
    //        single governed entry point every ArtCraft app exposes; the id
    //        (`type.create`) is the same string that appears in the app's
    //        command registry and in the COMPILED RUNTIME SCHEMAS block.
    const created = await client.callTool({
      name: "command_run",
      arguments: {
        id: "type.create",
        params: {
          text:   "Hello, governed studio.",
          font:   "Inter-Bold",
          size:   120,
          color:  "#111111",
          x:      160,
          y:      540,
        },
      },
    });
    console.log("command_run →", created);

    // 5.3 — Persist the artifact.  The path is resolved *inside* the write
    //        root declared in `.cursor/mcp.json`; the engine refuses to
    //        escape it, no matter what the model asked for.
    const saved = await client.callTool({
      name: "doc_save",
      arguments: { path: "hello.psd" },
    });
    console.log("doc_save →", saved);
  } finally {
    // 5.4 — Always shut the transport down.  The child process owns real OS
    //        resources; Node will not drain the event loop until it exits.
    await client.close();
  }
}

// ---------------------------------------------------------------------------
// 6) Entry point.  Top-level `await` is legal in ESM, so no IIFE is needed.
//    We still catch rejections explicitly so CI pipelines fail loudly rather
//    than hanging on a zombie promise the loop never services.
// ---------------------------------------------------------------------------
await main().catch((err: unknown) => {
  console.error("[studio-bridge] fatal:", err);
  process.exitCode = 1;
});
