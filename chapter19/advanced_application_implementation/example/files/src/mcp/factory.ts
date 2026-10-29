// src/mcp/factory.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { StudioPolicy, CraftBinding } from "../policy/schema.js";
import { PolicyEngine } from "../policy/engine.js";
import type { AuditLogger } from "../audit/logger.js";

/** A live, connected MCP session against one Craft binary. */
export interface CraftSession {
  readonly id: string;
  readonly client: Client;
  readonly transport: StdioClientTransport;
  close(): Promise<void>;
}

/**
 * Meta-tools the governor forwards to each session. We enumerate them here so
 * the compile step and the runtime share a single source of truth.
 */
export const META_TOOLS = [
  // PhotoCraft
  "command_run",
  "command_batch",
  "command_list",
  "doc_new",
  "doc_open",
  "doc_save",
  "doc_export",
  "doc_inspect",
  "doc_close",
  "doc_place",
  "doc_render_preview",
  "render_preview",
  "session_list",
  "ui_screenshot",
  "ui_pointer",
  "ui_set",
  "ui_menu_invoke",
  // VectorCraft
  "list_commands",
  "run_command",
  "inspect_document",
  "inspect_ui",
  "select_tool",
  "pointer_gesture",
  "draw_path",
  "draw_shape",
  "set_paint",
  "press_key",
  "type_text",
  "invoke_menu",
  "open_panel",
  "screenshot",
  "open_file",
  "save_file",
  "export",
  "add_text",
  "apply_effect",
  "pathfinder",
  "transform",
  "create_graph",
  "text_wrap",
  "undo",
  "redo",
  // DesignCraft
  "execute",
  "batch",
  "new_document",
  "open_document",
  "save_document",
  "place_image",
  "render_page",
  "export_png",
  "get_story",
  "set_story_text",
  "click",
  "drag",
  "menu_list",
  "dialog_set",
  "dialog_confirm",
  "dialog_cancel",
] as const;

export type MetaTool = (typeof META_TOOLS)[number];

/** A governance-aware MCP client: it wraps an underlying Client. */
export class GovernedClient {
  constructor(
    private readonly session: CraftSession,
    private readonly engine: PolicyEngine,
    private readonly audit: AuditLogger,
    private readonly agentId: string,
    private readonly roleName: string,
  ) {}

  /**
   * Invoke a meta-tool through the governance envelope.
   *
   * 1. Evaluate the policy engine (role, craft, command-id if applicable).
   * 2. Write an audit "ok"/"denied" entry with the canonical payload.
   * 3. Forward to the underlying MCP session.
   * 4. Write an audit "ok"/"error" entry with the result status.
   */
  async call<T = unknown>(tool: MetaTool, args: Record<string, unknown>): Promise<T> {
    const commandId = typeof args.id === "string" ? args.id : undefined;
    const isDesktop = tool === "ui_screenshot" || tool === "ui_pointer" || tool === "ui_set";

    const decision = isDesktop
      ? this.engine.authorizeDesktop(this.roleName, this.session.id)
      : commandId
        ? this.engine.authorizeCommand(this.roleName, this.session.id, commandId)
        : { allow: true as const };

    if (!decision.allow) {
      await this.audit.record({
        agent: this.agentId,
        craft: this.session.id,
        tool,
        payload: args,
        status: "denied",
        reason: decision.reason,
      });
      throw new PolicyDeniedError(this.agentId, this.session.id, tool, decision.reason);
    }

    await this.audit.record({
      agent: this.agentId,
      craft: this.session.id,
      tool,
      payload: args,
      status: "ok",
    });

    try {
      const result = await this.session.client.callTool({ name: tool, arguments: args });
      if (result.isError) {
        await this.audit.record({
          agent: this.agentId, craft: this.session.id, tool,
          payload: args, status: "error", reason: "mcp:isError",
        });
        throw new McpToolError(tool, result.content);
      }
      return result.content as T;
    } catch (err) {
      await this.audit.record({
        agent: this.agentId, craft: this.session.id, tool,
        payload: args, status: "error", reason: String(err),
      });
      throw err;
    }
  }

  close(): Promise<void> { return this.session.close(); }
}

/** Error type raised when the policy engine refuses a call. */
export class PolicyDeniedError extends Error {
  constructor(agent: string, craft: string, tool: string, reason: string) {
    super(`policy: agent="${agent}" craft="${craft}" tool="${tool}" → ${reason}`);
    this.name = "PolicyDeniedError";
  }
}

/** Error type raised when the Craft binary reports isError. */
export class McpToolError extends Error {
  constructor(tool: string, content: unknown) {
    super(`mcp: tool "${tool}" returned isError; content=${JSON.stringify(content)}`);
    this.name = "McpToolError";
  }
}

/**
 * The factory. It receives a policy, a decrypted secret map, the policy engine,
 * and the audit logger, and produces one GovernedClient per configured agent,
 * keyed by craft id.
 */
export class McpClientFactory {
  constructor(
    private readonly policy: StudioPolicy,
    private readonly secrets: Record<string, string>,
    private readonly engine: PolicyEngine,
    private readonly audit: AuditLogger,
  ) {}

  /** Spawn a connected MCP session for one Craft binding. */
  async connect(binding: CraftBinding): Promise<CraftSession> {
    const env: Record<string, string> = {
      ...process.env as Record<string, string>,
    };
    // Resolve and inject secrets named in the binding, but *only* those.
    for (const name of binding.secretEnv) {
      const value = this.secrets[name];
      if (value === undefined) throw new Error(`vault: missing secret "${name}" for craft "${binding.id}"`);
      env[name] = value;
    }
    // PhotoCraft, FilmCraft, VectorCraft and DeckCraft accept
    // --automation-read-root / --automation-write-root as *repeatable* flags.
    // The rest reject them outright, and their boundary is the working
    // directory the server is spawned in — so the policy says which is which
    // and the factory honours it.
    const args: string[] = ["mcp", ...binding.args];
    let cwd: string | undefined;
    if (binding.sandboxFlags) {
      for (const r of binding.roots.read) args.push("--automation-read-root", r);
      for (const w of binding.roots.write) args.push("--automation-write-root", w);
    } else {
      cwd = binding.roots.write[0];
    }

    const transport = new StdioClientTransport({
      command: binding.binary,
      args,
      ...(cwd ? { cwd } : {}),
      env,
    });
    const client = new Client(
      { name: `studio-governor/${binding.id}`, version: "1.0.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    return {
      id: binding.id,
      client,
      transport,
      close: async () => { try { await client.close(); } finally { /* idempotent */ } },
    };
  }

  /**
   * Given an agent binding id, open a governed surface over each craft it is
   * permitted to reach. Returns a map keyed by craft id.
   */
  async openFor(agentId: string): Promise<Map<string, GovernedClient>> {
    const agent = this.policy.agents.find((a) => a.id === agentId);
    if (!agent) throw new Error(`unknown agent "${agentId}"`);
    const out = new Map<string, GovernedClient>();
    for (const craftId of agent.crafts) {
      const binding = this.engine.getCraft(craftId);
      if (!binding) throw new Error(`agent "${agentId}" references unknown craft "${craftId}"`);
      const session = await this.connect(binding);
      out.set(craftId, new GovernedClient(session, this.engine, this.audit, agentId, agent.role));
    }
    return out;
  }
}
