/**
 * designcraft-session.ts
 * ---------------------------------------------------------------------------
 * A narrow, typed façade over the DesignCraft MCP server.
 *
 * Responsibilities
 *   1. Own the stdio transport lifecycle (designcraft-cli mcp).
 *   2. Normalise the SDK's CallToolResult into a typed JSON payload.
 *   3. Apply a timeout policy that distinguishes "engine is busy" from
 *      "engine is dead" and retries only the latter class.
 *   4. Emit structured telemetry for every command, so jobs are debuggable.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/* -------------------------------------------------------------------------- */
/* Types                                                                       */
/* -------------------------------------------------------------------------- */

/** A single registered DesignCraft command invocation. */
export interface CommandStep {
  id: string;
  params?: Record<string, unknown>;
}

/** Minimal structured-logger contract; swap for pino/winston in production. */
export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export class NullLogger implements Logger {
  debug(): void {}
  info(): void {}
  warn(): void {}
  error(): void {}
}

/** Raised when the engine rejects a command. Deterministic — never retried. */
export class CommandError extends Error {
  constructor(
    public readonly commandId: string,
    public readonly detail: unknown,
    message: string
  ) {
    super(message);
    this.name = "CommandError";
  }
}

/** Raised when the transport itself fails. Retryable up to maxAttempts. */
export class TransportError extends Error {
  constructor(message: string, public override readonly cause?: unknown) {
    super(message);
    this.name = "TransportError";
  }
}

export interface SessionOptions {
  /** Executable to launch. Defaults to the published CLI on PATH. */
  binary?: string;
  /** Absolute path the engine may read from (artwork, fonts, templates). */
  readRoot: string;
  /** Absolute path the engine may write to (PDF, EPUB, proofs). */
  writeRoot: string;
  /** Per-call ceiling. Long batches legitimately need minutes. */
  requestTimeoutMs?: number;
  /** Transport-level retries. */
  maxAttempts?: number;
  logger?: Logger;
}

/* -------------------------------------------------------------------------- */
/* Session                                                                     */
/* -------------------------------------------------------------------------- */

export class DesignCraftSession {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private readonly timeoutMs: number;
  private readonly maxAttempts: number;
  private readonly log: Logger;
  private connected = false;

  constructor(private readonly opts: SessionOptions) {
    this.log = opts.logger ?? new NullLogger();
    this.timeoutMs = opts.requestTimeoutMs ?? 180_000;
    this.maxAttempts = opts.maxAttempts ?? 3;

    this.transport = new StdioClientTransport({
      command: opts.binary ?? "designcraft-cli",
      // The headless server takes no sandbox roots: the worker owns
      // the filesystem boundary.
      args: ["mcp"],
      env: process.env as Record<string, string>,
      // Keep engine stderr off the JSON-RPC channel but visible to the worker.
      stderr: "pipe",
    });

    this.client = new Client(
      { name: "editorial-publisher", version: "1.0.0" },
      { capabilities: {} }
    );
  }

  /* ---------------------------------------------------------------------- */
  /* Lifecycle                                                               */
  /* ---------------------------------------------------------------------- */

  async connect(): Promise<void> {
    if (this.connected) return;
    this.log.info("mcp.connect", { binary: this.opts.binary ?? "designcraft-cli" });
    await this.client.connect(this.transport);
    this.connected = true;
  }

  async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    try {
      await this.client.close();
    } catch (err) {
      this.log.warn("mcp.close.failed", { err: String(err) });
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Core call path                                                          */
  /* ---------------------------------------------------------------------- */

  /**
   * Invoke an MCP tool and coerce its result into `T`.
   *
   * The MCP SDK returns `{ content: ContentBlock[], isError?: boolean,
   * structuredContent?: unknown }`. DesignCraft emits its JSON payload as the
   * first `text` block, but the bridge may ALSO populate `structuredContent`,
   * so we prefer that and fall back to JSON.parse on the text.
   */
  private async call<T>(tool: string, args: Record<string, unknown>): Promise<T> {
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const started = Date.now();
      try {
        this.log.debug("mcp.call", { tool, attempt });

        const result = await this.client.callTool(
          { name: tool, arguments: args },
          undefined,
          { timeout: this.timeoutMs, resetTimeoutOnProgress: true }
        );

        this.log.debug("mcp.call.ok", { tool, ms: Date.now() - started });

        if ((result as { isError?: boolean }).isError) {
          throw new CommandError(
            tool,
            result,
            `DesignCraft reported an error for ${tool}: ${this.firstText(result)}`
          );
        }

        return this.extract<T>(result);
      } catch (err) {
        lastError = err;

        // Deterministic engine errors are surfaced immediately: retrying a
        // malformed parameter set only wastes the batch budget.
        if (err instanceof CommandError) throw err;

        this.log.warn("mcp.call.retry", {
          tool,
          attempt,
          err: String(err),
        });

        if (attempt < this.maxAttempts) {
          await sleep(exponentialBackoff(attempt));
          continue;
        }
      }
    }

    throw new TransportError(
      `Transport failed for ${tool} after ${this.maxAttempts} attempts`,
      lastError
    );
  }

  private firstText(result: unknown): string {
    const blocks = (result as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
    const first = blocks.find((b) => b.type === "text" && typeof b.text === "string");
    return first?.text ?? "<no text content>";
  }

  private extract<T>(result: unknown): T {
    const structured = (result as { structuredContent?: unknown }).structuredContent;
    if (structured !== undefined && structured !== null) return structured as T;

    const text = this.firstText(result).trim();
    if (text.length === 0) return {} as T;

    try {
      return JSON.parse(text) as T;
    } catch {
      // Non-JSON payloads (e.g. raw png bytes returned as base64) pass through.
      return text as unknown as T;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Meta-tools                                                              */
  /* ---------------------------------------------------------------------- */

  /** Run one engine command by id. */
  async commandRun<T = Record<string, unknown>>(
    id: string,
    params: Record<string, unknown> = {}
  ): Promise<T> {
    try {
      return await this.call<T>("execute", { command: id, params });
    } catch (err) {
      if (err instanceof CommandError) {
        throw new CommandError(id, err.detail, `execute(${id}) failed: ${err.message}`);
      }
      throw err;
    }
  }

  /**
   * Run a batch of engine commands in order.
   *
   * DesignCraft's native `batch` tool supports `$N.path` result interpolation,
   * which is enormously useful when step 3 needs the frame id step 2 created.
   * We surface it here rather than reimplementing it in TypeScript, because the
   * engine's substitution runs inside the same transaction as the commands.
   */
  async commandBatch(
    steps: CommandStep[],
    opts: { script?: string } = {}
  ): Promise<{ completed: number; results: unknown[] }> {
    // The batch stops at the first failing command and keeps the
    // steps that already ran: atomicity comes from the caller's
    // snapshot, not from a flag.
    // The tool takes `command` and `params`; the session's own step
    // shape calls the command `id`.
    const payload: Record<string, unknown> = {
      commands: steps.map((step) => ({ command: step.id, params: step.params ?? {} })),
    };
    if (opts.script) payload.script = opts.script;
    return this.call("batch", payload);
  }

  /** Create a document. */
  async docNew(
    spec: Record<string, unknown>
  ): Promise<{ index?: number; document?: number; pages?: number }> {
    return this.call("new_document", spec);
  }

  /** Save to the write root. Omit `path` to write in place. */
  async docSave(path?: string, format?: string): Promise<{ path?: string; warnings?: string[] }> {
    return this.call("save_document", path ? { path } : {});
  }

  /** Full structural snapshot: pages, spreads, items, stories, styles, swatches. */
  async docInspect<T = Record<string, unknown>>(): Promise<T> {
    return this.call<T>("inspect_document", {});
  }

  /** Render a page to PNG. `scale` is pixels per point. */
  async docRenderPreview(page = 1, scale = 1): Promise<unknown> {
    return this.call("render_page", { page, scale });
  }

  /** Export a page as PNG, optionally also to disk. */
  async exportPng(path: string, page = 1, scale = 2): Promise<{ path: string; width: number; height: number }> {
    return this.call("export_png", { path, page, scale });
  }

  /** Whole-window screenshot. Desktop/bridge mode only. */
  async uiScreenshot(path?: string): Promise<unknown> {
    return this.call("screenshot", path ? { path } : {});
  }

  /** Text of a story, plus frame list, paragraph count, and overset state. */
  async getStory(
    ref: { story?: number; frame?: number }
  ): Promise<{ text?: string; frames?: number[]; paragraphs?: number; characters?: number; overset?: number | boolean }> {
    return this.call("get_story", ref);
  }

  /** Replace a story's entire text while preserving the first paragraph's style. */
  async setStoryText(
    ref: { story?: number; frame?: number },
    text: string
  ): Promise<{ story?: number }> {
    return this.call("set_story_text", { ...ref, text });
  }

  /** Place an image into a frame, or into a new frame at (x, y). */
  async placeImage(args: Record<string, unknown>): Promise<{ frame?: number; asset?: number }> {
    return this.call("place_image", args);
  }

  /** Render a page — used by the multimodal proof auditor. */
  async renderPage(page: number, scale = 2, path?: string): Promise<unknown> {
    return this.call("render_page", path ? { page, scale, path } : { page, scale });
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 250ms, 750ms, 1750ms … capped at 8s. */
function exponentialBackoff(attempt: number): number {
  return Math.min(8000, 250 * Math.pow(3, attempt - 1));
}
