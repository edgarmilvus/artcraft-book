// ---------------------------------------------------------------------------
// session.ts — a narrow, typed façade over the EffectCraft MCP server.
// ---------------------------------------------------------------------------
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Every MCP tool reply is a list of content parts; we only ever see two. */
type ToolContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

/**
 * Type guard for the text arm of {@link ToolContent}.
 *
 * A type guard is any expression that performs a runtime check and, in doing
 * so, narrows the static type inside the guarded scope. Without this, every
 * consumer of a tool reply would have to cast, and a silent change in the
 * MCP envelope shape would surface as `undefined` deep inside the compiler
 * instead of as a clear failure at the boundary.
 */
function isTextContent(c: ToolContent): c is { type: "text"; text: string } {
  return c.type === "text";
}

export interface EffectCraftSessionOptions {
  /** Absolute path to the effectcraft-cli binary. */
  binaryPath: string;
  /** Extra CLI flags, e.g. automation read/write roots for sandboxing. */
  extraArgs?: string[];
  /** Per-call ceiling. Renders are long; keep this generous. */
  callTimeoutMs?: number;
  /** How many times to retry a transport failure before giving up. */
  maxTransportRetries?: number;
}

/** Shape of a `command_list` / `list_commands` entry. */
interface CommandDescriptor {
  id: string;
  label: string;
  menu?: string[] | null;
  shortcut?: string | null;
  params?: string | null;
  enabled: boolean;
  disabledReason?: string | null;
}

/** One node of the property tree returned by `get_layer`. */
export interface LayerPropertyNode {
  path: string;
  uid: number;
  matchId: string;
  name: string;
  type: string;
  value: unknown;
  keyframes?: Array<{ time: number; value: unknown }>;
  expression?: string | null;
  children?: LayerPropertyNode[];
}

export class EffectCraftError extends Error {
  constructor(
    message: string,
    readonly tool: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = "EffectCraftError";
  }
}

/**
 * A single, long-lived MCP connection to one `effectcraft-cli mcp` process.
 *
 * Lifecycle: construct → `connect()` → many `runCommand` / `addKeyframe` /
 * `renderFrame` calls → `close()`. The session is *not* re-entrant with
 * respect to document mutation: two concurrent calls that both edit the
 * active composition will interleave their undo steps. Serialize at the
 * worker level, or open one session per concurrent compile.
 */
export class EffectCraftSession {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private readonly callTimeoutMs: number;
  private readonly maxTransportRetries: number;
  private connected = false;

  constructor(private readonly opts: EffectCraftSessionOptions) {
    this.callTimeoutMs = opts.callTimeoutMs ?? 120_000;
    this.maxTransportRetries = opts.maxTransportRetries ?? 3;

    this.transport = new StdioClientTransport({
      command: opts.binaryPath,
      args: ["mcp", ...(opts.extraArgs ?? [])],
    });

    this.client = new Client(
      { name: "artcraft-motion-service", version: "3.1.0" },
      { capabilities: {} },
    );
  }

  /** Spawns the child process and completes the MCP initialize handshake. */
  public async connect(): Promise<void> {
    if (this.connected) return;
    await this.client.connect(this.transport);
    this.connected = true;
  }

  /** Terminates the child process; safe to call more than once. */
  public async close(): Promise<void> {
    if (!this.connected) return;
    this.connected = false;
    await this.client.close();
  }

  /**
   * Unwraps the MCP tool-result envelope into typed JSON.
   *
   * EffectCraft's meta-tools return JSON *as text* inside a single content
   * part. This is deliberate on the server side — it keeps the envelope
   * uniform across tools whose payloads are wildly different shapes — but it
   * means every consumer needs exactly one place that knows how to peel it.
   */
  private unwrap<T>(tool: string, result: { content: ToolContent[]; isError?: boolean }): T {
    const textPart = result.content.find(isTextContent);
    if (!textPart) {
      throw new EffectCraftError(`Tool '${tool}' returned no text content`, tool, result);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(textPart.text);
    } catch (cause) {
      // The engine answers a rejected command with a plain-text diagnostic
      // rather than with JSON, so the text is the error message.
      throw new EffectCraftError(
        `Tool '${tool}' failed: ${textPart.text}`,
        tool,
        { text: textPart.text, cause },
      );
    }
    if (result.isError) {
      throw new EffectCraftError(`Tool '${tool}' failed`, tool, parsed);
    }
    return parsed as T;
  }

  /**
   * Invokes any MCP tool by name with a timeout and transport-level retry.
   *
   * Retry policy: we retry only when the *transport* throws, never when the
   * server returns a structured error. A structured error means the command
   * itself was rejected (bad params, disabled command, invalid document
   * state) and replaying it will produce the identical failure — retrying
   * would inflate latency and mask the real bug.
   */
  private async callTool<T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.maxTransportRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.callTimeoutMs);
      try {
        const raw = await this.client.callTool(
          { name, arguments: args },
          undefined,
          { signal: controller.signal },
        );
        return this.unwrap<T>(name, raw as { content: ToolContent[]; isError?: boolean });
      } catch (err) {
        lastError = err;
        if (err instanceof EffectCraftError) throw err; // semantic: do not retry
        await new Promise((r) => setTimeout(r, 150 * 2 ** attempt));
      } finally {
        clearTimeout(timer);
      }
    }
    throw new EffectCraftError(
      `Transport failed after ${this.maxTransportRetries + 1} attempts on '${name}'`,
      name,
      lastError,
    );
  }

  /**
   * Like {@link callTool}, but hands back the raw content list.
   *
   * `render_frame` answers with an image block next to its metadata, and
   * the unwrapping helper would throw the picture away.
   */
  private async callToolRaw<T>(
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.callTimeoutMs);
    try {
      const raw = await this.client.callTool(
        { name, arguments: args },
        undefined,
        { signal: controller.signal },
      );
      return raw as T;
    } finally {
      clearTimeout(timer);
    }
  }

  // ---- Meta-tool wrappers, one per shape the runtime actually exposes ----

  /** `list_commands` — discover what is runnable *right now*. */
  public listCommands(filter?: string) {
    return this.callTool<CommandDescriptor[]>("list_commands", filter ? { filter } : {});
  }

  /** `describe_command` — the authoritative JSON Schema for one command. */
  public describeCommand(command: string) {
    return this.callTool<Record<string, unknown>>("describe_command", { command });
  }

  /**
   * `execute_command` — run any registry command by id.
   *
   * This is the single most important wrapper in the module: every
   * higher-level builder ultimately funnels through here, which means there
   * is exactly one place to add telemetry, one place to enforce policy, and
   * one place to reason about the undo stack.
   */
  public runCommand<T = unknown>(
    command: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    return this.callTool<T>("execute_command", { command, params });
  }

  /**
   * `batch` — several commands as ONE undo step.
   *
   * `atomic: true` (the default) rolls the whole batch back if any step
   * fails. Later steps may reference earlier results through the `$N.key`
   * interpolation syntax, which is what lets us create a layer and then
   * address it without a second round trip.
   */
  public batch<T = unknown>(
    steps: Array<{ command: string; params?: Record<string, unknown> }>,
    label?: string,
    atomic = true,
  ): Promise<{ steps: number; results: T[] }> {
    return this.callTool("batch", { steps, label, atomic });
  }

  /** Convenience wrapper for the engine's own `engine.batch` command. */
  public engineBatch<T = unknown>(
    steps: Array<{ command: string; params?: Record<string, unknown> }>,
    label: string,
  ): Promise<{ steps: number; results: T[] }> {
    return this.runCommand("engine.batch", { steps, label, atomic: true });
  }

  /** `add_keyframe` — one key or many, with an optional global easing. */
  public addKeyframe(params: {
    layer: number | string;
    path: string;
    time?: number;
    value?: unknown;
    keys?: Array<{ time: number; value?: unknown }>;
    interpolation?: "linear" | "bezier" | "hold" | "easyEase" | "easyEaseIn" | "easyEaseOut";
    comp?: number | string;
  }) {
    return this.callTool<LayerPropertyNode>("add_keyframe", params as Record<string, unknown>);
  }

  /** `get_layer` — the property tree, each node carrying a usable `path`. */
  public getLayer(params: {
    layer: number | string;
    comp?: number | string;
    time?: number;
    depth?: number;
    flat?: boolean;
  }) {
    return this.callTool<LayerPropertyNode>("get_layer", params as Record<string, unknown>);
  }

  /** `get_property` — read one property, including its keyframes. */
  public getProperty(params: { layer: number | string; path: string; time?: number }) {
    return this.callTool<LayerPropertyNode>("get_property", params as Record<string, unknown>);
  }

  /** `set_property` — static value, keyed value, or expression. */
  public setProperty(params: {
    layer: number | string;
    path: string;
    value?: unknown;
    time?: number;
    expression?: string;
    comp?: number | string;
  }) {
    return this.callTool<LayerPropertyNode>("set_property", params as Record<string, unknown>);
  }

  /**
   * `render_frame` — one PNG frame, inline or written to disk.
   *
   * The tool answers with two content parts: a text block carrying the
   * frame's metadata and an image block carrying the PNG. The image block
   * is the payload, so this wrapper returns the raw content list instead
   * of the unwrapped text.
   */
  public renderFrame(params: {
    comp?: number | string;
    time?: number;
    maxSide?: number;
    path?: string;
    inline?: boolean;
    transparent?: boolean;
  }): Promise<{ content: ToolContent[] }> {
    return this.callToolRaw<{ content: ToolContent[] }>(
      "render_frame",
      params as Record<string, unknown>,
    );
  }
}
