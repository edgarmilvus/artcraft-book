#!/usr/bin/env -S npx tsx
// master_mcp_server.ts — a single MCP server that fronts every ArtCraft CLI.
//
// Fixes over the first draft:
//   * `z.record(z.any())` is not valid in zod v4 (needs a key type) -> TS2554.
//   * `cwd` was hard-coded to "/work" (Docker-only); now resolves from the
//     ARTCRAFT_ROOT env var, falling back to the process cwd, so it also runs
//     natively on macOS.
//   * no `error` handler on `spawn`: a missing binary made the call hang
//     forever. Added, so failures reject with a clear message.
//   * `run` needs a document source: the tool now takes either `document`
//     (an existing file) or `new` (a canvas object). Without one it creates a
//     default 1920x1080 RGB canvas, instead of silently failing.
//
// Env:
//   ARTCRAFT_ROOT        working dir + automation read/write root (default: cwd)
//   ARTCRAFT_READ_ROOT   override the read root
//   ARTCRAFT_WRITE_ROOT  override the write root

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { spawn } from "node:child_process";
import { z } from "zod";

const APP_BINARIES: Record<string, string> = {
  photocraft: "photocraft-cli",
  vectorcraft: "vectorcraft-cli",
  designcraft: "designcraft-cli",
  filmcraft: "filmcraft-cli",
  effectcraft: "effectcraft-cli",
  lightcraft: "lightcraft-cli",
  wordcraft: "wordcraft-cli",
  pdfcraft: "pdfcraft-cli",
};

const ROOT = process.env.ARTCRAFT_ROOT ?? process.cwd();
const READ_ROOT = process.env.ARTCRAFT_READ_ROOT ?? ROOT;
const WRITE_ROOT = process.env.ARTCRAFT_WRITE_ROOT ?? ROOT;

const server = new Server(
  { name: "artcraft-master", version: "1.1.0" },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "artcraft_run",
      description:
        "Run one ArtCraft registry command with an optional document source and export. " +
        "Wraps `<app>-cli run (<file> | --new <json>) --cmd <id> [--params <json>] [--out <file>]`.",
      inputSchema: {
        type: "object",
        properties: {
          app: { type: "string", enum: Object.keys(APP_BINARIES), default: "photocraft" },
          id: { type: "string", description: "Registry command id, e.g. `file.new`, `layer.newAdjustmentLayer.curves`." },
          params: { type: "object", additionalProperties: true, default: {} },
          document: { type: "string", description: "Existing document to open (beneath the read root)." },
          new: { type: "object", additionalProperties: true, description: "Canvas for a new document (file.new params)." },
          out: { type: "string", description: "Export path beneath the write root." },
          format: { type: "string", description: "Export format extension, e.g. png." },
        },
        required: ["id"],
        additionalProperties: false,
      },
    },
  ],
}));

const RunArgs = z.object({
  app: z.enum(Object.keys(APP_BINARIES) as [string, ...string[]]).default("photocraft"),
  id: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
  document: z.string().optional(),
  new: z.record(z.string(), z.unknown()).optional(),
  out: z.string().optional(),
  format: z.string().optional(),
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  if (request.params.name !== "artcraft_run") {
    throw new Error(`unknown tool: ${request.params.name}`);
  }
  const args = RunArgs.parse(request.params.arguments ?? {});
  const binary = APP_BINARIES[args.app];

  // `run` requires a document source: an existing file or a new canvas.
  const canvas = args.new ?? (args.document ? undefined : { width: 1920, height: 1080, mode: "rgb", depth: 8, background: "white" });
  const argv = [
    "run",
    ...(args.document ? [args.document] : ["--new", JSON.stringify(canvas)]),
    "--cmd", args.id,
    "--params", JSON.stringify(args.params),
    ...(args.out ? ["--out", args.out] : []),
    ...(args.format ? ["--format", args.format] : []),
  ];

  const stdout = await new Promise<string>((resolve, reject) => {
    const child = spawn(binary, argv, {
      cwd: WRITE_ROOT,
      env: { ...process.env, ARTCRAFT_READ_ROOT: READ_ROOT, ARTCRAFT_WRITE_ROOT: WRITE_ROOT },
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    // Without this, a missing binary would never settle the promise.
    child.on("error", (e) => reject(new Error(`failed to spawn ${binary}: ${e.message}`)));
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`${binary} exited ${code}: ${err || out}`));
      else resolve(out.trim() || "ok");
    });
  });

  return { content: [{ type: "text", text: stdout }] };
});

async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`ArtCraft master MCP ready (root=${ROOT}).`);
}

run().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
