// gfx-factory/mcp-client.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface McpToolResult {
  ok: boolean;
  job?: number;
  [key: string]: unknown;
}

/**
 * A thin, resilient facade over PhotoCraft's MCP meta-tools. The
 * class exists so that a worker can spawn one client per process
 * and share it — the underlying StdioClientTransport is stateful
 * (one long-lived child), so we must not open one per request.
 */
export class PhotoCraftMcpClient {
  private client: Client | null = null;
  private transport: StdioClientTransport | null = null;
  private readonly binary: string;
  private readonly readRoot: string;
  private readonly writeRoot: string;
  private connectPromise: Promise<void> | null = null;

  constructor(opts: { binary?: string; readRoot: string; writeRoot: string }) {
    this.binary = opts.binary ?? "photocraft-cli";
    this.readRoot = opts.readRoot;
    this.writeRoot = opts.writeRoot;
  }

  /** Idempotent connect; safe to call from many concurrent callers. */
  async ensureConnected(): Promise<void> {
    if (this.client && this.transport) return;
    if (this.connectPromise) return this.connectPromise;

    this.connectPromise = (async () => {
      this.transport = new StdioClientTransport({
        command: this.binary,
        args: [
          "mcp",
          "--automation-read-root",
          this.readRoot,
          "--automation-write-root",
          this.writeRoot,
        ],
      });
      const client = new Client(
        { name: "gfx-factory", version: "1.0.0" },
        { capabilities: {} }
      );
      await client.connect(this.transport);
      this.client = client;
    })().finally(() => {
      this.connectPromise = null;
    });

    return this.connectPromise;
  }

  /** Hard reset — used after an engine crash. */
  private async reset(): Promise<void> {
    try {
      await this.transport?.close();
    } catch {
      /* swallow: we are already broken */
    }
    this.client = null;
    this.transport = null;
  }

  /**
   * Invoke any PhotoCraft MCP tool by name. The `retryOnCrash` flag
   * distinguishes *engine died before doing work* (safe to retry)
   * from *engine replied with an error* (do not blind-retry writes).
   */
  async tool<T extends McpToolResult = McpToolResult>(
    name: string,
    args: Record<string, unknown>,
    opts: { retryOnCrash?: boolean } = {}
  ): Promise<T> {
    await this.ensureConnected();
    const attempts = opts.retryOnCrash === false ? 1 : 2;
    let lastErr: unknown;
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await this.client!.callTool({ name, arguments: args });
        return res as unknown as T;
      } catch (err) {
        lastErr = err;
        await this.reset();
        if (i + 1 < attempts) await this.ensureConnected();
      }
    }
    throw lastErr;
  }

  /** Convenience wrapper for the fundamental `command_run` meta-tool. */
  async run(
    id: string,
    params: Record<string, unknown> = {},
    opts: { wait?: boolean; retryOnCrash?: boolean } = {}
  ): Promise<McpToolResult> {
    return this.tool(
      "command_run",
      { id, params, wait: opts.wait ?? true },
      { retryOnCrash: opts.retryOnCrash }
    );
  }

  /** Batch several commands into one round-trip. */
  async batch(
    steps: Array<{ id: string; params?: Record<string, unknown>; wait?: boolean }>,
    opts: { stopOnError?: boolean } = {}
  ): Promise<McpToolResult> {
    return this.tool("command_batch", {
      steps,
      stop_on_error: opts.stopOnError ?? true,
    });
  }

  /** Create a fresh scene. Delegates to the native `doc_new` tool. */
  async newDoc(args: {
    width: number;
    height: number;
    background?: "white" | "black" | "transparent" | `#${string}`;
    mode?: "rgb" | "gray" | "cmyk" | "lab";
    name?: string;
  }): Promise<McpToolResult> {
    return this.tool("doc_new", {
      width: args.width,
      height: args.height,
      background: args.background ?? "white",
      mode: args.mode ?? "rgb",
      name: args.name ?? "banner",
    });
  }

  /** Place a raster into the current scene as a smart-object layer. */
  async place(args: {
    path: string;
    scale?: number;
    fit?: boolean;
    center?: [number, number];
  }): Promise<McpToolResult> {
    return this.tool("doc_place", args);
  }

  /** Persist the active document. */
  async save(args: {
    path?: string;
    format?: string;
    quality?: number;
  }): Promise<McpToolResult> {
    return this.tool("doc_save", args);
  }

  /** Flattened PNG of the active document, base64-embedded. */
  async preview(args: { maxSide?: number } = {}): Promise<unknown> {
    return this.tool("doc_render_preview", {
      max_side: args.maxSide ?? 1024,
    });
  }

  async close(): Promise<void> {
    await this.reset();
  }
}
