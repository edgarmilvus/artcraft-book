// ---------------------------------------------------------------------------
// @file creative-factory/session.ts
//
// Low-level MCP session wrapper. One instance == one child process == one
// isolated document workspace. The SaaS layer pools these; the pooling policy
// is out of scope here but the lifecycle hooks are exposed for it.
// ---------------------------------------------------------------------------

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { EventEmitter } from "node:events";

/**
 * The set of apps we are allowed to spawn. Each maps 1:1 to a `*-cli mcp`
 * binary that speaks line-delimited JSON-RPC 2.0 over stdio. We keep the
 * read/write roots narrow: every automation request outside them is refused
 * by the engine's filesystem sandbox, which is a hard guarantee we rely on
 * when running untrusted tenant briefs.
 */
export type CraftBinary =
  | "photocraft-cli"
  | "vectorcraft-cli"
  | "filmcraft-cli"
  | "effectcraft-cli"
  | "designcraft-cli"
  | "lightcraft-cli"
  | "pdfcraft-cli";

/**
 * Options for opening a single MCP session. `readRoot`/`writeRoot` are the
 * only directories the child process may touch; they are passed as
 * `--automation-read-root` / `--automation-write-root` exactly as the
 * architecture spec requires.
 */
export interface SessionOptions {
  binary: CraftBinary;
  readRoot: string;
  writeRoot: string;
  /** Extra CLI flags, e.g. `["--seed", "42"]` for reproducible runs. */
  extraArgs?: string[];
  /** Environment overrides; useful for CI to pin a specific GPU backend. */
  env?: Record<string, string>;
}

/**
 * Thin, typed wrapper around an MCP `Client` bound to one ArtCraft binary.
 *
 * Why a wrapper at all? Three reasons:
 *   1. Lifecycle. The `Client` needs `connect()`/`close()` bracketed, and if a
 *      background render job is still alive when we close, we leak a socket.
 *      The wrapper intercepts close and drains jobs first.
 *   2. Ergonomic invoke. `client.callTool({name, arguments})` is verbose; we
 *      expose `run`, `batch`, `newDoc`, etc. as first-class methods so the
 *      workers never construct MCP envelopes by hand.
 *   3. Telemetry. Every call emits a structured event with the round-trip time,
 *      which we forward to the platform's observability sink. This is how the
 *      Chapter-2 dual-compositor drift metric is measured in production.
 */
export class ArtCraftSession extends EventEmitter {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private closed = false;

  constructor(private readonly opts: SessionOptions) {
    super();
    this.transport = new StdioClientTransport({
      command: opts.binary,
      args: [
        "mcp",
        "--automation-read-root",
        opts.readRoot,
        "--automation-write-root",
        opts.writeRoot,
        ...(opts.extraArgs ?? []),
      ],
      // `process.env` is `Record<string, string | undefined>`; a spawned child
      // cannot receive `undefined` values, so drop them before handing the bag
      // to the transport.
      env: Object.fromEntries(
        Object.entries({ ...process.env, ...(opts.env ?? {}) }).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
    });

    this.client = new Client(
      { name: "brand-compliance-factory", version: "1.4.0" },
      { capabilities: {} },
    );
  }

  /** Connect the pipe. Must be awaited before any `run*` call. */
  async connect(): Promise<void> {
    await this.client.connect(this.transport);
  }

  /**
   * Execute one registry command.
   * @param id  the command id, e.g. `layer.newAdjustmentLayer.curves`
   * @param params  a JSON object matching the command's schema
   * @param wait  for long commands (filters, Photomerge) whether to block;
   *              `false` returns `{ job: id }` which must be polled.
   */
  async run<T = unknown>(
    id: string,
    params: Record<string, unknown> = {},
    wait = true,
  ): Promise<T> {
    const t0 = performance.now();
    const res = await this.client.callTool({
      name: "command_run",
      // PhotoCraft dispatches through `command_run { id, params }`. Other apps
      // in the suite expose the same registry under their own meta-tool name
      // (`execute` in DesignCraft), so a multi-app deployment maps the binary
      // to the meta-tool before calling `run()`.
      arguments: { id, params, wait },
    });
    this.emit("call", { id, wait, ms: performance.now() - t0 });
    return this.unwrap<T>(res);
  }

  /**
   * Execute several commands in one JSON-RPC round-trip.
   *
   * `command_batch` is **not** a transaction in PhotoCraft: every step is its
   * own undo entry, and `stop_on_error: true` only stops the *remaining*
   * steps. PhotoCraft's schema accepts exactly `{ steps, stop_on_error }` —
   * there is no `atomic` flag and no `label` (VectorCraft has an atomic batch,
   * PhotoCraft does not). If you need all-or-nothing semantics here, count the
   * applied steps and dispatch `edit.undo` for each one.
   */
  async batch<T = unknown>(
    steps: Array<{ id: string; params?: Record<string, unknown> }>,
  ): Promise<T[]> {
    const t0 = performance.now();
    const res = await this.client.callTool({
      name: "command_batch",
      arguments: {
        steps: steps.map((s) => ({ id: s.id, params: s.params ?? {} })),
        stop_on_error: true,
      },
    });
    this.emit("batch", { steps: steps.length, ms: performance.now() - t0 });
    const payload = this.unwrap<{
      completed: number;
      failed: number;
      results: Array<{ ok: boolean; result?: T; error?: string }>;
    }>(res);
    if (payload.failed > 0) {
      const failed = payload.results.find((r) => !r.ok);
      throw new Error(
        `batch stopped after ${payload.completed} applied step(s): ` +
          `${failed?.error ?? "unknown error"}`,
      );
    }
    return payload.results.map((r) => r.result as T);
  }

  /** Create a document via the native `doc_new` meta-tool. */
  async newDoc(spec: {
    width: number;
    height: number;
    mode?: "rgb" | "gray" | "cmyk" | "lab";
    depth?: 8 | 16 | 32;
    background?: string;
  }): Promise<void> {
    await this.client.callTool({ name: "doc_new", arguments: spec });
  }

  /**
   * Deterministic export. This drives the **reference compositor**; the
   * returned bytes are the certification-grade artefact.
   */
  async save(
    path: string,
    format: string,
    quality?: number,
  ): Promise<{ warnings: string[] }> {
    const res = await this.client.callTool({
      name: "doc_save",
      arguments: { path, format, quality, tiffLayers: false },
    });
    return this.unwrap<{ warnings: string[] }>(res);
  }

  /**
   * Snapshot the *accelerated* compositor output as an inline PNG. Used for
   * the customer-facing preview, never for the signed export.
   */
  async preview(maxSide = 1024): Promise<Uint8Array> {
    const res = await this.client.callTool({
      name: "doc_render_preview",
      arguments: { max_side: maxSide },
    });
    return this.unwrapImage(res);
  }

  /** Full document tree, including per-layer tile statistics. */
  async inspect<T = unknown>(): Promise<T> {
    const res = await this.client.callTool({ name: "doc_inspect", arguments: {} });
    return this.unwrap<T>(res);
  }

  /** Names of the meta-tools this binary exposes (MCP `tools/list`). */
  async listTools(): Promise<string[]> {
    const { tools } = await this.client.listTools();
    return tools.map((tool) => tool.name);
  }

  /**
   * Call a meta-tool by name and unwrap its JSON text payload. This is the
   * escape hatch for the tools that are not registry commands — `command_list`,
   * `jobs_list`, `session_list`, `doc_inspect`, …
   */
  async rawCall<T = unknown>(
    name: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const res = await this.client.callTool({ name, arguments: args });
    return this.unwrap<T>(res);
  }

  /**
   * Version reported by the server in the MCP `initialize` handshake, e.g.
   * `photocraft-cli@0.8.2`. There is no version field in `command_list`.
   */
  serverVersion(): string {
    const info = this.client.getServerVersion();
    return info ? `${info.name}@${info.version}` : "unknown";
  }

  /**
   * Graceful shutdown: waits for background jobs (`wait: false` filters) to
   * finish, then closes the pipe. Bounded to 10 s so a stuck job cannot hang
   * the process; cancel it explicitly with `jobs_cancel` if that happens.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const list = await this.rawCall<{ jobs?: Array<{ state?: string }> }>(
        "jobs_list",
        {},
      ).catch(() => ({ jobs: [] as Array<{ state?: string }> }));
      const running = (list.jobs ?? []).filter((job) => job.state === "running");
      if (running.length === 0) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    await this.client.close();
  }

  // -- internals -----------------------------------------------------------

  private unwrap<T>(res: unknown): T {
    // All ArtCraft meta-tools return `{ content: [{type:"text", text}], isError? }`.
    // The text body is JSON. We centralise the unpacking here.
    const r = res as {
      isError?: boolean;
      content?: Array<{ type: string; text?: string }>;
    };
    if (r.isError) throw new Error(`[${this.opts.binary}] ${r.content?.[0]?.text}`);
    const first = r.content?.find((c) => c.type === "text");
    return first?.text ? (JSON.parse(first.text) as T) : (undefined as T);
  }

  private unwrapImage(res: unknown): Uint8Array {
    const r = res as {
      content?: Array<{ type: string; data?: string; mimeType?: string }>;
    };
    // The headless preview returns an `image` block (mimeType image/png) plus
    // a short text block describing the flatten. Do not require the mimeType:
    // the bridge path can omit it.
    const img = r.content?.find((c) => c.type === "image" && c.data);
    if (!img?.data) throw new Error("no PNG in preview response");
    return Buffer.from(img.data, "base64");
  }
}
