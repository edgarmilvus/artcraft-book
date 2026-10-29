// src/03_craft-client.ts
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";

/**
 * Every ArtCraft binary speaks MCP over stdio, but the *meta-tools* they
 * expose are not the same. PhotoCraft runs a registry command through
 * `command_run { id, params }`; DesignCraft and WordCraft use
 * `execute { command, params }`; EffectCraft uses
 * `execute_command { command, params }`. The batch key is `steps` in some
 * dialects and `commands` in others, the discovery key is `enabled_only` in
 * some and `enabledOnly` in others, and only PhotoCraft has a `doc_new`
 * meta-tool at all — VectorCraft creates a document by running the
 * `file.new` *command*.
 *
 * So the transport is generic and the *dialect* is the part that knows the
 * names. A dialect is a small, declarative table; the client is the one
 * place that knows how to turn a semantic call ("run this registry
 * command") into the right tool name and argument shape for the binary
 * underneath.
 *
 * The sandbox story differs too, and the difference matters:
 *
 * | dialect      | boundary                                             |
 * | ------------ | ---------------------------------------------------- |
 * | photocraft   | engine: `--automation-read-root` / `--automation-write-root` |
 * | vectorcraft  | engine: `--automation-read-root` / `--automation-write-root` |
 * | pdfcraft     | engine: `--root DIR` (one directory for reads and writes) |
 * | effectcraft  | none — the client confines every path itself          |
 * | designcraft  | none — the client confines every path itself          |
 * | wordcraft    | none — the client confines every path itself          |
 *
 * The three engines that have no boundary of their own are the reason this
 * client resolves paths instead of trusting them.
 */

/** The ArtCraft dialects the studio can drive. */
export type CraftDialect =
  | "photocraft"
  | "vectorcraft"
  | "effectcraft"
  | "designcraft"
  | "wordcraft"
  | "pdfcraft";

/** The key a dialect uses for the command id inside a run/batch payload. */
export type CommandKey = "id" | "command";

/** The key a dialect uses for the list of steps inside a batch payload. */
export type StepsKey = "steps" | "commands";

/** How a dialect is told which directories it may touch. */
export type SandboxKind = "automation-roots" | "single-root" | "client-confined";

export interface CraftDialectSpec {
  /** The executable, resolved on `PATH`. */
  readonly binary: string;
  /** Arguments the `mcp` subcommand always takes. */
  readonly baseArgs: readonly string[];
  /** Where the filesystem boundary comes from. */
  readonly sandbox: SandboxKind;
  /** The meta-tool that runs one registry command. */
  readonly run: { readonly tool: string; readonly commandKey: CommandKey };
  /** The meta-tool that runs many registry commands, when there is one. */
  readonly batch?: {
    readonly tool: string;
    readonly stepsKey: StepsKey;
    readonly stepCommandKey: CommandKey;
  };
  /** The meta-tool that lists the command registry. */
  readonly list: {
    readonly tool: string;
    readonly filterKey: string;
    readonly enabledOnlyKey: string;
  };
  /** How a new document is created, when the dialect can create one. */
  readonly create?:
    | { readonly kind: "meta"; readonly tool: string }
    | { readonly kind: "command"; readonly commandId: string };
  /** The meta-tool that saves the active document. */
  readonly save?: {
    readonly tool: string;
    readonly pathKey: string;
    readonly formatKey?: string;
  };
  /** The meta-tool that renders a preview of the active document. */
  readonly render?: { readonly tool: string; readonly maxSideKey: string };
}

/**
 * The per-binary table. This is the only place in the codebase that knows
 * that PhotoCraft says `id` where EffectCraft says `command`.
 */
export const CRAFT_DIALECTS: Readonly<Record<CraftDialect, CraftDialectSpec>> = {
  photocraft: {
    binary: "photocraft-cli",
    baseArgs: [],
    sandbox: "automation-roots",
    run: { tool: "command_run", commandKey: "id" },
    batch: { tool: "command_batch", stepsKey: "steps", stepCommandKey: "id" },
    list: { tool: "command_list", filterKey: "filter", enabledOnlyKey: "enabled_only" },
    create: { kind: "meta", tool: "doc_new" },
    save: { tool: "doc_save", pathKey: "path", formatKey: "format" },
    render: { tool: "doc_render_preview", maxSideKey: "max_side" },
  },
  vectorcraft: {
    binary: "vectorcraft-cli",
    baseArgs: ["--headless"],
    sandbox: "automation-roots",
    run: { tool: "command_run", commandKey: "id" },
    batch: { tool: "command_batch", stepsKey: "steps", stepCommandKey: "id" },
    list: { tool: "command_list", filterKey: "filter", enabledOnlyKey: "enabled_only" },
    // No `doc_new` meta-tool: a document is the `file.new` *command*.
    create: { kind: "command", commandId: "file.new" },
    save: { tool: "save_file", pathKey: "path" },
    render: { tool: "render_preview", maxSideKey: "max_side" },
  },
  effectcraft: {
    binary: "effectcraft-cli",
    baseArgs: [],
    sandbox: "client-confined",
    run: { tool: "execute_command", commandKey: "command" },
    batch: { tool: "batch", stepsKey: "steps", stepCommandKey: "command" },
    list: { tool: "list_commands", filterKey: "filter", enabledOnlyKey: "enabled_only" },
    save: { tool: "save_project", pathKey: "path" },
  },
  designcraft: {
    binary: "designcraft-cli",
    baseArgs: [],
    sandbox: "client-confined",
    run: { tool: "execute", commandKey: "command" },
    batch: { tool: "batch", stepsKey: "commands", stepCommandKey: "command" },
    list: { tool: "list_commands", filterKey: "filter", enabledOnlyKey: "enabledOnly" },
    create: { kind: "meta", tool: "new_document" },
    save: { tool: "save_document", pathKey: "path" },
  },
  wordcraft: {
    binary: "wordcraft-cli",
    baseArgs: [],
    sandbox: "client-confined",
    run: { tool: "execute", commandKey: "command" },
    batch: { tool: "batch", stepsKey: "commands", stepCommandKey: "command" },
    list: { tool: "list_commands", filterKey: "query", enabledOnlyKey: "enabledOnly" },
    create: { kind: "meta", tool: "new_document" },
    save: { tool: "save_document", pathKey: "path" },
  },
  pdfcraft: {
    binary: "pdfcraft-cli",
    baseArgs: [],
    sandbox: "single-root",
    run: { tool: "command_run", commandKey: "id" },
    batch: { tool: "command_batch", stepsKey: "steps", stepCommandKey: "id" },
    list: { tool: "command_list", filterKey: "filter", enabledOnlyKey: "enabled_only" },
  },
};

/** A single registry command, as the agents express it. */
export interface CommandStep {
  /** The registry command id, e.g. `"type.create"`. */
  readonly id: string;
  /** The command's parameters. */
  readonly params?: Record<string, unknown>;
}

/** A text block in an MCP tool result. */
export interface McpTextBlock {
  readonly type: "text";
  readonly text: string;
}

/** An image block in an MCP tool result. */
export interface McpImageBlock {
  readonly type: "image";
  /** Base64-encoded image bytes. */
  readonly data: string;
  readonly mimeType: string;
}

export type McpBlock = McpTextBlock | McpImageBlock;

/** The decoded result of one `tools/call`. */
export interface McpToolResult {
  readonly blocks: readonly McpBlock[];
  readonly isError: boolean;
}

/** Thrown when an engine reports a tool-level failure. */
export class CraftToolError extends Error {
  public constructor(
    public readonly tool: string,
    public readonly detail: string,
    public readonly stderr: readonly string[] = [],
  ) {
    super(`${tool} failed: ${detail}`);
    this.name = "CraftToolError";
  }
}

/** Thrown when a path would escape the client's confinement boundary. */
export class CraftPathError extends Error {
  public constructor(
    public readonly path: string,
    public readonly root: string,
  ) {
    super(`path "${path}" is outside the campaign boundary "${root}"`);
    this.name = "CraftPathError";
  }
}

/** Thrown when the transport itself fails (spawn, handshake, timeout). */
export class CraftTransportError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "CraftTransportError";
  }
}

export interface CraftClientOptions {
  /** Which binary and meta-tool surface to speak. */
  readonly dialect: CraftDialect;
  /** The absolute directory the engine may read from. */
  readonly readRoot: string;
  /** The absolute directory the engine may write to. */
  readonly writeRoot: string;
  /** Extra environment variables layered on top of `process.env`. */
  readonly env?: Readonly<Record<string, string>>;
  /** A hard timeout per tool call, in milliseconds (default 120s). */
  readonly requestTimeoutMs?: number;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseBlocks(value: unknown): McpBlock[] {
  if (!Array.isArray(value)) return [];
  const blocks: McpBlock[] = [];
  for (const raw of value) {
    if (!isRecord(raw)) continue;
    if (raw.type === "text" && typeof raw.text === "string") {
      blocks.push({ type: "text", text: raw.text });
    } else if (raw.type === "image" && typeof raw.data === "string") {
      blocks.push({
        type: "image",
        data: raw.data,
        mimeType: typeof raw.mimeType === "string" ? raw.mimeType : "image/png",
      });
    }
  }
  return blocks;
}

/**
 * A serialized, dialect-aware MCP client for one ArtCraft binary.
 *
 * Design notes
 * ------------
 * • **Serialized calls.** `call()` chains onto an internal promise tail, so
 *   two agents that both target the same document can never interleave
 *   partial writes onto the stdio pipe. This is the "single-writer per
 *   binary" invariant — the same property a desktop app's event loop
 *   provides when a human is driving the UI.
 *
 * • **Dialect dispatch.** The caller says *what* it means ("run this
 *   registry command", "list the registry", "save the document"); the
 *   dialect says *how* the binary is told. Nothing above this class knows
 *   that EffectCraft spells a command id `command`.
 *
 * • **Content unwrapping.** ArtCraft answers every meta-tool with the MCP
 *   `content: [{ type: "text", text: "<json>" }]` envelope. It is parsed
 *   once, here, so every agent above sees a typed object rather than a
 *   string.
 *
 * • **Confinement.** For the three engines that ship no filesystem
 *   boundary of their own, `writePath()` and `readPath()` refuse any path
 *   that leaves the campaign directory. The client is the sandbox for
 *   exactly the engines that are not.
 */
export class CraftClient {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private stdoutBuffer = "";
  private callTail: Promise<unknown> = Promise.resolve();
  private readonly pending = new Map<number, PendingRequest>();
  private readonly stderrLines: string[] = [];

  public constructor(private readonly options: CraftClientOptions) {
    const spec = CRAFT_DIALECTS[options.dialect];
    if (spec.sandbox === "single-root" && options.readRoot !== options.writeRoot) {
      throw new CraftTransportError(
        `${options.dialect} confines reads and writes to one directory; ` +
          "readRoot and writeRoot must be the same path",
      );
    }
  }

  /** The dialect this client speaks. */
  public get dialect(): CraftDialect {
    return this.options.dialect;
  }

  /** The sandbox strategy the underlying binary implements. */
  public get sandbox(): SandboxKind {
    return CRAFT_DIALECTS[this.options.dialect].sandbox;
  }

  /** Spawn the MCP server subprocess and complete the initialize handshake. */
  public async connect(): Promise<void> {
    if (this.child) return;

    const spec = CRAFT_DIALECTS[this.options.dialect];
    const args = ["mcp", ...spec.baseArgs, ...this.sandboxArgs()];

    const child = spawn(spec.binary, args, {
      cwd: this.options.writeRoot,
      env: { ...process.env, ...(this.options.env ?? {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child = child;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => this.onStderr(chunk));
    child.on("exit", (code) => this.onExit(code));

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "autonomous-creative-studio", version: "1.0.0" },
    });
    this.notify("notifications/initialized", {});
  }

  /**
   * Call a meta-tool and return its decoded payload. Calls are serialized
   * through an internal promise chain so concurrent agents cannot corrupt
   * the stdio stream.
   */
  public call<T = unknown>(
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    return this.serialize(() => this.executeCall<T>(tool, args));
  }

  /** Call a meta-tool and return the raw content blocks, image included. */
  public callRaw(
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<McpToolResult> {
    return this.serialize(() => this.executeRawCall(tool, args));
  }

  /**
   * Run one registry command, in whichever dialect this client speaks.
   */
  public async runCommand<T = unknown>(
    id: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    const spec = CRAFT_DIALECTS[this.options.dialect];
    const args: Record<string, unknown> = {};
    args[spec.run.commandKey] = id;
    args.params = params;
    return this.call<T>(spec.run.tool, args);
  }

  /**
   * Run a batch of registry commands, in whichever dialect this client
   * speaks.
   */
  public async runBatch<T = unknown>(steps: readonly CommandStep[]): Promise<T> {
    const spec = CRAFT_DIALECTS[this.options.dialect];
    const batch = spec.batch;
    if (!batch) {
      throw new CraftTransportError(
        `${this.options.dialect} exposes no batch meta-tool`,
      );
    }
    const args: Record<string, unknown> = {};
    args[batch.stepsKey] = steps.map((step) => {
      const encoded: Record<string, unknown> = {};
      encoded[batch.stepCommandKey] = step.id;
      encoded.params = step.params ?? {};
      return encoded;
    });
    return this.call<T>(batch.tool, args);
  }

  /** List the command registry, optionally filtered by a substring. */
  public async listCommands(filter?: string): Promise<unknown> {
    const spec = CRAFT_DIALECTS[this.options.dialect];
    const args: Record<string, unknown> = {};
    if (filter !== undefined) args[spec.list.filterKey] = filter;
    return this.call(spec.list.tool, args);
  }

  /** List the meta-tools the binary exposes, by name. */
  public async listTools(): Promise<readonly string[]> {
    const result = await this.serialize(() => this.request("tools/list", {}));
    if (!isRecord(result)) return [];
    const tools = result.tools;
    if (!Array.isArray(tools)) return [];
    const names: string[] = [];
    for (const tool of tools) {
      if (isRecord(tool) && typeof tool.name === "string") names.push(tool.name);
    }
    return names;
  }

  /**
   * Create a document. PhotoCraft and DesignCraft have a meta-tool for it;
   * VectorCraft does not, and a document there is the `file.new` command.
   */
  public async createDocument<T = unknown>(
    args: Record<string, unknown> = {},
  ): Promise<T> {
    const create = CRAFT_DIALECTS[this.options.dialect].create;
    if (!create) {
      throw new CraftTransportError(
        `${this.options.dialect} has no document-creation meta-tool`,
      );
    }
    if (create.kind === "command") {
      return this.runCommand<T>(create.commandId, args);
    }
    return this.call<T>(create.tool, args);
  }

  /**
   * Save the active document. PdfCraft is absent on purpose: its `doc_save`
   * takes a document id as well as a path, so it has no single-document
   * shorthand and the publisher calls it directly.
   */
  public async saveDocument<T = unknown>(
    path: string,
    format?: string,
  ): Promise<T> {
    const save = CRAFT_DIALECTS[this.options.dialect].save;
    if (!save) {
      throw new CraftTransportError(
        `${this.options.dialect} exposes no document-saving meta-tool`,
      );
    }
    const args: Record<string, unknown> = {};
    args[save.pathKey] = path;
    if (format !== undefined && save.formatKey) args[save.formatKey] = format;
    return this.call<T>(save.tool, args);
  }

  /**
   * Render a preview of the active document and return it as an image
   * block. Only PhotoCraft and VectorCraft have a preview meta-tool.
   */
  public async renderPreview(maxSide = 1024): Promise<McpImageBlock> {
    const render = CRAFT_DIALECTS[this.options.dialect].render;
    if (!render) {
      throw new CraftTransportError(
        `${this.options.dialect} exposes no preview meta-tool`,
      );
    }
    const args: Record<string, unknown> = {};
    args[render.maxSideKey] = maxSide;
    const result = await this.callRaw(render.tool, args);
    if (result.isError) {
      throw new CraftToolError(
        render.tool,
        this.firstText(result) ?? "the engine reported an error",
        this.stderrLines,
      );
    }
    const image = result.blocks.find(
      (block): block is McpImageBlock => block.type === "image",
    );
    if (!image) {
      throw new CraftToolError(
        render.tool,
        "the preview carried no image block",
        this.stderrLines,
      );
    }
    return image;
  }

  /**
   * Resolve a path the engine may write to. Engines that ship no boundary
   * of their own rely on this check.
   */
  public writePath(path: string): string {
    return this.confine(path, this.options.writeRoot);
  }

  /**
   * Resolve a path the engine may read from.
   */
  public readPath(path: string): string {
    return this.confine(path, this.options.readRoot);
  }

  /** Close cleanly, releasing the subprocess. */
  public async close(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) return;
    for (const [, request] of this.pending) {
      request.reject(new CraftTransportError("the engine was closed"));
    }
    this.pending.clear();
    await new Promise<void>((done) => {
      child.once("exit", () => done());
      child.kill("SIGTERM");
      setTimeout(() => {
        child.kill("SIGKILL");
        done();
      }, 2_000).unref();
    });
  }

  // ── internals ──────────────────────────────────────────────────────────

  /**
   * Queue a unit of work behind every other unit of work on this
   * connection. Nothing else may write to the engine's stdin, because two
   * interleaved frames would corrupt the stream.
   */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.callTail.then(work);
    // Keep the chain moving even if the work rejects; the rejection still
    // propagates to the caller of *this* invocation.
    this.callTail = next.catch(() => undefined);
    return next;
  }

  private sandboxArgs(): string[] {
    const spec = CRAFT_DIALECTS[this.options.dialect];
    switch (spec.sandbox) {
      case "automation-roots":
        return [
          "--automation-read-root",
          this.options.readRoot,
          "--automation-write-root",
          this.options.writeRoot,
        ];
      case "single-root":
        return ["--root", this.options.readRoot];
      case "client-confined":
        return [];
    }
  }

  private confine(path: string, root: string): string {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(root, path);
    const rel = relative(root, absolute);
    if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`)) {
      throw new CraftPathError(path, root);
    }
    return absolute;
  }

  private async executeCall<T>(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const result = await this.executeRawCall(tool, args);
    if (result.isError) {
      throw new CraftToolError(
        tool,
        this.firstText(result) ?? "the engine reported an error",
        this.stderrLines,
      );
    }
    const text = this.firstText(result);
    if (text === null) {
      throw new CraftToolError(
        tool,
        "the engine returned no text payload",
        this.stderrLines,
      );
    }
    try {
      return JSON.parse(text) as T;
    } catch {
      return text as unknown as T;
    }
  }

  private async executeRawCall(
    tool: string,
    args: Record<string, unknown>,
  ): Promise<McpToolResult> {
    const raw = await this.request("tools/call", { name: tool, arguments: args });
    if (!isRecord(raw)) {
      return { blocks: [], isError: true };
    }
    return {
      blocks: parseBlocks(raw.content),
      isError: raw.isError === true,
    };
  }

  private firstText(result: McpToolResult): string | null {
    const block = result.blocks.find(
      (candidate): candidate is McpTextBlock => candidate.type === "text",
    );
    return block ? block.text : null;
  }

  private onStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    let newline = this.stdoutBuffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (line.length > 0) this.onLine(line);
      newline = this.stdoutBuffer.indexOf("\n");
    }
  }

  private onLine(line: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return;
    }
    if (!isRecord(parsed)) return;
    const id = parsed.id;
    if (typeof id !== "number") return; // a notification or a server request
    const request = this.pending.get(id);
    if (!request) return;
    this.pending.delete(id);
    const error = parsed.error;
    if (isRecord(error)) {
      request.reject(
        new CraftTransportError(
          `MCP error ${String(error.code)}: ${String(error.message)}`,
        ),
      );
      return;
    }
    request.resolve(parsed.result);
  }

  private onStderr(chunk: string): void {
    for (const line of chunk.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0) continue;
      this.stderrLines.push(trimmed);
      if (this.stderrLines.length > 40) this.stderrLines.shift();
    }
  }

  private onExit(code: number | null): void {
    for (const [, request] of this.pending) {
      request.reject(
        new CraftTransportError(`the engine exited with code ${String(code)}`),
      );
    }
    this.pending.clear();
  }

  private request(method: string, params: unknown): Promise<unknown> {
    const child = this.child;
    if (!child) {
      throw new CraftTransportError(
        `the ${this.options.dialect} client is not connected`,
      );
    }
    const id = this.nextId;
    this.nextId += 1;
    const frame = `${JSON.stringify({
      jsonrpc: "2.0",
      id,
      method,
      params,
    })}\n`;

    const timeoutMs = this.options.requestTimeoutMs ?? 120_000;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(
          new CraftTransportError(
            `${method} timed out after ${String(timeoutMs)}ms`,
          ),
        );
      }, timeoutMs);
      timer.unref();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      child.stdin.write(frame, (error) => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(
            new CraftTransportError(
              `could not write to the ${this.options.dialect} engine: ${error.message}`,
            ),
          );
        }
      });
    });
  }

  private notify(method: string, params: unknown): void {
    const child = this.child;
    if (!child) return;
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }
}
