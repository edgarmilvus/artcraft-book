/**
 * hello-artcraft-arch.ts
 * ──────────────────────────────────────────────────────────────────────────
 * A minimal end-to-end walkthrough of the ArtCraft / Storytold runtime.
 *
 * This file demonstrates — in one self-contained TypeScript program — the
 * four pillars of the architecture described in Chapter 2:
 *
 *   1. COMMAND REGISTRY DISPATCH.
 *      Every user-visible action across PhotoCraft, VectorCraft, FilmCraft,
 *      DesignCraft, LightCraft, PdfCraft, WordCraft, ... is an instance of a
 *      strongly-typed Command ID whose JSON schema is registered at runtime.
 *      Agents address commands by id through the single MCP meta-tool
 *      `command_run`.
 *
 *   2. ATOMIC-LOOKING BATCHES.
 *      `command_batch` executes several registry steps under one JSON-RPC
 *      round-trip. In PhotoCraft, each step still becomes its own undo step
 *      (the spec is explicit) — the batch forbids intermediate responses
 *      from racing the agent, but it is NOT a database transaction. We
 *      demonstrate the pattern so the reader knows the difference.
 *
 *   3. SPARSE 256² TILES.
 *      The document is stored as a quadtree-like sparse grid of 256×256
 *      copy-on-write tiles. A 100×100 fill lands inside exactly one tile
 *      (index (0,0) on a 1024² canvas). We probe the compositor with
 *      `document.pixel` inside and outside the touched tile to prove that
 *      the composite is correct without flattening the whole document.
 *
 *   4. DUAL COMPOSITORS.
 *      The CPU SIMD reference oracle and the wgpu pipeline must produce
 *      pixel-identical output. `doc_render_preview` (headless) reads the
 *      CPU path; on the desktop shell the same meta-tool proxies to
 *      `ui_screenshot` so the agent sees the live GPU frame.
 *
 * The program spawns `photocraft-cli mcp` over stdio, drives the server
 * through JSON-RPC 2.0 (line-delimited), and tears the transport down
 * cleanly. No GUI is required.
 *
 * Run:
 *     npx tsx hello-artcraft-arch.ts
 *
 * Environment:
 *     PHOTOCRAFT_CLI   override the binary path (default: `photocraft-cli`)
 *     OUT_DIR          where previews / exports land (default: `./out`)
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

/* ─── 0.  The document envelope we hand to the CLI ──────────────────── */

/** Absolute path the CLI is allowed to write beneath. */
const OUT_DIR = resolve(process.env.OUT_DIR ?? "./out");
mkdirSync(OUT_DIR, { recursive: true });

/** Binary override so the snippet runs under any package layout. */
const CLI = process.env.PHOTOCRAFT_CLI ?? "photocraft-cli";

/* ─── 1.  Spawn the MCP server over stdio ───────────────────────────── */

/**
 * The StdioClientTransport speaks line-delimited JSON-RPC 2.0 to the
 * child process's stdin and reads framed replies from its stdout.
 *
 * `--automation-write-root` and `--automation-read-root` install the
 * filesystem sandbox described in the governance spec: `doc_save` and
 * `doc_export` will refuse any path outside these roots, even if the
 * agent is running with full user privileges.
 */
const transport = new StdioClientTransport({
  command: CLI,
  args: [
    "mcp",
    "--automation-write-root", OUT_DIR,
    "--automation-read-root", OUT_DIR,
  ],
});

/** A fully-qualified MCP client; the capability object is intentionally bare. */
const client = new Client(
  { name: "hello-artcraft-arch", version: "1.0.0" },
  { capabilities: {} },
);

/**
 * Connect the client to the transport. `new Client()` only builds the
 * object: without `connect()` every `callTool` rejects with "Not connected"
 * because the JSON-RPC `initialize` handshake has not happened yet.
 */
await client.connect(transport);

/* ─── 2.  Boot the session and create a 1024² document ──────────────── */

/**
 * `doc_new` is one of the "native" MCP meta-tools (not a registry
 * command). It bypasses the command bus because it needs to allocate
 * the physical tile store before any layer or story entity exists.
 *
 * A 1024×1024 canvas is decomposed into ceil(1024/256)² = 16 sparse
 * tiles. Only tiles that actually carry ink are materialised; the
 * others share a single immutable "all-white" page until first write.
 */
const created = await client.callTool({
  name: "doc_new",
  arguments: {
    width: 1024,
    height: 1024,
    mode: "rgb",
    depth: 8,
    background: "white",
    name: "Hello-Architecture",
  },
});
log("doc_new", created);

/* ─── 3.  Add a named pixel layer via the command registry ──────────── */

/**
 * There is no bespoke `layer.create`-style MCP tool. Instead we address
 * the registry directly: `layer.new.layer` is the same Command ID the
 * PhotoCraft menus emit when a user chooses Layer ▸ New ▸ Layer….
 *
 * The registry is the single source of truth — over 500 ids, each with
 * a strict JSON schema validated before the command reaches the engine.
 */
const layerRes = await client.callTool({
  name: "command_run",
  arguments: {
    id: "layer.new.layer",
    params: { name: "Blueprint", mode: "Normal", opacity: 1.0 },
  },
});
log("command_run layer.new.layer", layerRes);

/* ─── 4.  Touch exactly ONE 256² tile ──────────────────────────────── */

/**
 * We marquee-select the rectangle (16, 16, 100, 100). Because 100 < 256,
 * every pixel of the selection is contained in the single tile whose
 * origin is (0, 0).
 *
 * Under the hood the sparse tile store performs a copy-on-write
 * promotion: the shared "all-white" tile is split, the affected child
 * alone is cloned, and a new root pointer is installed on the undo
 * stack. That is why undo across arbitrarily large canvases is O(1)
 * in the number of *changed* tiles — not in document area.
 */
await client.callTool({
  name: "command_run",
  arguments: {
    id: "select.rect",
    params: { x: 16, y: 16, width: 100, height: 100, mode: "replace" },
  },
});

/** Fill the active selection with the accent colour. */
await client.callTool({
  name: "command_run",
  arguments: {
    id: "edit.fill",
    // NOTE: `edit.fill` takes opacity as a percentage (0..100), unlike
    // `layer.setProps`, whose opacity is 0..1. Passing 1.0 here fills at 1%.
    params: { contents: "color", color: "#1e88e5", opacity: 100 },
  },
});

/* ─── 5.  Atomic-looking multi-step edit via command_batch ──────────── */

/**
 * `command_batch` collapses several registry calls into one JSON-RPC
 * frame. THIS IS NOT A TRANSACTION — see the Common Pitfalls section
 * below. Each step becomes its own undo step. The batch simply lets us
 * describe intent declaratively; the app remains fully consistent
 * between steps so the user can undo exactly as far as they want.
 *
 * The step below adds a Curves adjustment layer above the Blueprint
 * layer and immediately sets its points — the same thing the UI does
 * when you drag the first control point.
 */
const batch = await client.callTool({
  name: "command_batch",
  arguments: {
    steps: [
      {
        id: "layer.newAdjustmentLayer.curves",
        params: { points: [[0, 0], [64, 40], [192, 215], [255, 255]] },
      },
      {
        id: "layer.setProps",
        params: { opacity: 0.85, blend: "Normal" },
      },
    ],
    stop_on_error: true,
  },
});
log("command_batch", batch);

/* ─── 6.  Probe the composite through the tile-aware pixel reader ───── */

/**
 * `document.pixel` reads the *composited* pixel at (x, y). Internally
 * the compositor walks only the tiles that cover the query — because
 * we have exactly one modified tile, this is a one-hop lookup.
 */
const inside = await client.callTool({
  name: "command_run",
  arguments: { id: "document.pixel", params: { x: 50, y: 50 } },
});
log("pixel inside stroke", inside);

/** Ask for a coordinate in an untouched tile; must be pure white. */
const outside = await client.callTool({
  name: "command_run",
  arguments: { id: "document.pixel", params: { x: 900, y: 900 } },
});
log("pixel outside stroke", outside);

/* ─── 7.  Dual-compositor proof: headless render ────────────────────── */

/**
 * `doc_render_preview` returns PNG bytes. In headless mode these come
 * from the CPU SIMD reference compositor — the deterministic oracle
 * used by CI. In the desktop shell the same meta-tool proxies to
 * `ui_screenshot` so the agent sees the exact GPU-composited frame the
 * human sees. The two paths are bit-identical by contract.
 */
const preview = await client.callTool({
  name: "doc_render_preview",
  arguments: { max_side: 512 },
});

/**
 * The MCP SDK surfaces binary content as content blocks; for a PNG we
 * look for the base64-encoded `image` block and persist it.
 */
const previewPath = join(OUT_DIR, "preview.png");
persistImageContent(preview, previewPath);
log("preview written", { path: previewPath });

/* ─── 8.  Export to disk; native format is incremental ──────────────── */

/**
 * A `.pcraft` save writes an incremental delta against the last full
 * snapshot: only the tiles whose hash changed are appended. That is
 * why saving a 30 000-pixel edit on a 60 MP canvas is measured in
 * kilobytes, not megabytes.
 */
await client.callTool({
  name: "doc_save",
  arguments: { path: "hello.pcraft" },
});

/** A flat PNG export forces the CPU compositor to flatten every dirty tile. */
await client.callTool({
  name: "doc_export",
  arguments: { path: "hello.png", format: "png", quality: 90 },
});

/* ─── 9.  Confirm session state, then tear down cleanly ─────────────── */

/**
 * `session_list` is a cheap structural read — it returns the open
 * documents with size and dirty flag. We use it as a final sanity
 * check that the MCP server and the engine agree on the world.
 */
const session = await client.callTool({
  name: "session_list",
  arguments: {},
});
log("session_list", session);

/* ─── 10.  Close the transport ──────────────────────────────────────── */

/**
 * If you skip this, the child process keeps the event loop alive and
 * your Node test runner hangs until the OS reaps it. Always close.
 */
await client.close();
console.log("\n✔ Hello, Architecture.\n");

/* ─── Helpers ───────────────────────────────────────────────────────── */

/** Tiny logger so the walkthrough trace is readable in isolation. */
function log(label: string, payload: unknown): void {
  const text = typeof payload === "string"
    ? payload
    : JSON.stringify(payload, null, 2);
  console.log(`\n── ${label} ─────────────────────────────────`);
  console.log(text.length > 1200 ? `${text.slice(0, 1200)}\n… (truncated)` : text);
}

/** Extract a PNG image block and write it to disk. */
function persistImageContent(result: any, path: string): void {
  const blocks = (result?.content ?? []) as Array<{ type: string; data?: string }>;
  const png = blocks.find((b) => b.type === "image" && b.data);
  if (!png?.data) throw new Error("No image content in tool reply");
  writeFileSync(path, Buffer.from(png.data, "base64"));
}
