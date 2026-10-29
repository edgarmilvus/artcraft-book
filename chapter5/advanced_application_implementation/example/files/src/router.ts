/**
 * @file creativeforge/router.ts
 *
 * The Tool Router. Every LLM-initiated action passes through here.
 *
 * Design contract:
 *   - Tools are strictly namespaced: `<app>__<meta_tool>`.
 *     Example: "photocraft__command_run". (`::` is not a legal
 *     character in an Anthropic tool name.)
 *   - The router validates arguments with a per-tool Zod schema.
 *   - The router validates every call against its own schema table; the
 *     catalog in agent-loop.ts is what limits the offered set to the tools
 *     a worker actually advertises.
 *   - The router records an AuditRecord for EVERY call, whether it succeeds
 *     or fails, and redacts large binary fields before persistence.
 */

import { z } from 'zod';
import type { ClientPool } from './pool.js';
import type { Session, CraftApp } from './session.js';

/** Every meta-tool the orchestrator will ever proxy. */
export const META_TOOLS = [
  'list_commands',
  'execute',
  'batch',
  'command_list',
  'command_run',
  'command_batch',
  'doc_new',
  'doc_open',
  'doc_save',
  'doc_export',
  'doc_inspect',
  'doc_render_preview',
  'render_preview',
  'doc_close',
  'ui_screenshot',
] as const;
type MetaTool = (typeof META_TOOLS)[number];

/**
 * Zod schemas per meta-tool. These mirror the Level-1 ground-truth schemas
 * from the runtime registries. Where a tool's argument shape differs across
 * apps (e.g. Photocraft uses `id`/`params`, Filmcraft uses `id`/`params`,
 * Designcraft uses `command`/`params`) the schema below is deliberately
 * permissive and the router normalizes into the canonical shape.
 */
const Schemas: Record<MetaTool, z.ZodTypeAny> = {
  // ── Registries ──────────────────────────────────────────────────────────
  list_commands: z.object({
    filter: z.string().optional(),
    enabled_only: z.boolean().optional(),
    enabledOnly: z.boolean().optional(),
    query: z.string().optional(),
  }).passthrough(),
  command_list: z.object({
    filter: z.string().optional(),
    enabled_only: z.boolean().optional(),
    enabledOnly: z.boolean().optional(),
  }).passthrough(),

  // ── Single command execution ────────────────────────────────────────────
  execute: z.object({
    command: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
  }),
  command_run: z.object({
    id: z.string().min(1),
    params: z.record(z.string(), z.unknown()).optional(),
    wait: z.boolean().optional(),
  }),

  // ── Batch execution ─────────────────────────────────────────────────────
  batch: z.object({
    commands: z.array(z.object({
      command: z.string().min(1),
      params: z.record(z.string(), z.unknown()).optional(),
    })).min(1).optional(),
    steps: z.array(z.object({
      id: z.string().min(1),
      params: z.record(z.string(), z.unknown()).optional(),
    })).min(1).optional(),
    stop_on_error: z.boolean().optional(),
    keepGoing: z.boolean().optional(),
    atomic: z.boolean().optional(),
    label: z.string().optional(),
  }).refine(
    (v) => !!(v.commands || v.steps),
    { message: 'batch requires either `commands` (DesignCraft) or `steps`' },
  ),
  command_batch: z.object({
    steps: z.array(z.object({
      id: z.string().min(1),
      params: z.record(z.string(), z.unknown()).optional(),
    })).min(1),
    stop_on_error: z.boolean().optional(),
    atomic: z.boolean().optional(),
    label: z.string().optional(),
  }),

  // ── Document lifecycle ──────────────────────────────────────────────────
  doc_new: z.object({
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    mode: z.string().optional(),
    depth: z.number().int().optional(),
    background: z.string().optional(),
    name: z.string().optional(),
  }).passthrough(),
  doc_open: z.object({
    path: z.string().min(1),
    password: z.string().optional(),
  }),
  doc_save: z.object({
    path: z.string().optional(),
    index: z.number().int().nonnegative().optional(),
    format: z.string().optional(),
    quality: z.number().int().min(0).max(100).optional(),
  }),
  doc_export: z.object({
    path: z.string().optional(),
    index: z.number().int().nonnegative().optional(),
    format: z.string().optional(),
    quality: z.number().int().min(0).max(100).optional(),
  }),
  doc_inspect: z.object({ index: z.number().int().nonnegative().optional() }),
  doc_close: z.object({ index: z.number().int().nonnegative().optional() }),

  // ── Preview / screenshot ────────────────────────────────────────────────
  doc_render_preview: z.object({
    index: z.number().int().nonnegative().optional(),
    max_side: z.number().int().min(1).max(4096).optional(),
  }),
  render_preview: z.object({
    max_side: z.number().int().min(1).max(4096).optional(),
    seconds: z.number().optional(), // Filmcraft only
    page: z.number().int().positive().optional(), // Photocraft only
  }).passthrough(),
  ui_screenshot: z.object({
    max_side: z.number().int().min(1).max(4096).optional(),
    path: z.string().optional(),
  }).passthrough(),
};

/**
 * A single LLM-proposed tool call, normalized from the model's JSON.
 * `app` may be null when the LLM hasn't yet decided which application
 * should handle the action — the router will then pick the best fit using
 * `heuristicAppFor(tool)`, but only for tools that are unambiguously app-agnostic.
 */
export interface ToolCall {
  app: CraftApp | null;
  tool: MetaTool;
  args: Record<string, unknown>;
}

export interface ToolResult {
  ok: boolean;
  result?: unknown;
  error?: string;
  /** Which app actually served this call (post-routing). */
  app?: CraftApp;
  /** Milliseconds the worker spent on the call. */
  durationMs: number;
}

/**
 * The router. Stateless across sessions — all state lives in the Session
 * and ClientPool objects passed to `dispatch`.
 */
export class ToolRouter {
  public constructor(private readonly pool: ClientPool) {}

  /**
   * Heuristic default app for each meta-tool. Used only when the LLM
   * doesn't name an app. `ui_screenshot` is intentionally absent — visual
   * tooling must be explicitly requested.
   */
  private static readonly DEFAULT_APP: Partial<Record<MetaTool, CraftApp>> = {
    doc_new: 'photocraft',
    doc_open: 'photocraft',
    doc_save: 'photocraft',
    doc_render_preview: 'photocraft',
  };

  /**
   * Dispatch one tool call. Guarantees:
   *   - the tool name is in the router's declared set (unknown names fail closed),
   *   - the arguments validate against the per-tool Zod schema,
   *   - UI tools are refused unless the tenant opted in,
   *   - an AuditRecord is appended regardless of success.
   */
  public async dispatch(session: Session, call: ToolCall): Promise<ToolResult> {
    const started = Date.now();

    // Rule 1: UI tools are policy-gated.
    if ((call.tool === 'ui_screenshot') && !session.visualAttachAllowed) {
      const msg =
        'ui_screenshot refused: this tenant is not provisioned for Visual Attach Mode';
      session.record({
        app: call.app ?? 'photocraft',
        toolName: call.tool,
        toolArgs: call.args,
        durationMs: Date.now() - started,
        ok: false,
        errorMessage: msg,
      });
      return { ok: false, error: msg, durationMs: Date.now() - started };
    }

    // Rule 2: argument validation. The union type is a compile-time
    // guarantee only — the tool name arrives from model-generated JSON, so
    // an unknown name has to be rejected here rather than crash the lookup.
    const schema = Schemas[call.tool] as z.ZodTypeAny | undefined;
    if (!schema) {
      const msg = `unknown tool ${String(call.tool)}: not in the router's declared set`;
      session.record({
        app: call.app ?? 'photocraft',
        toolName: String(call.tool),
        toolArgs: call.args,
        durationMs: Date.now() - started,
        ok: false,
        errorMessage: msg,
      });
      return { ok: false, error: msg, durationMs: Date.now() - started };
    }
    const parsed = schema.safeParse(call.args);
    if (!parsed.success) {
      const msg = `invalid arguments for ${call.tool}: ${parsed.error.message}`;
      session.record({
        app: call.app ?? 'photocraft',
        toolName: call.tool,
        toolArgs: call.args,
        durationMs: Date.now() - started,
        ok: false,
        errorMessage: msg,
      });
      return { ok: false, error: msg, durationMs: Date.now() - started };
    }

    // Rule 3: routing — LLM's choice wins, else heuristics, else reject.
    const app = call.app ?? ToolRouter.DEFAULT_APP[call.tool];
    if (!app) {
      const msg =
        `cannot route ${call.tool}: no application specified and no default available`;
      session.record({
        app: 'photocraft',
        toolName: call.tool,
        toolArgs: call.args,
        durationMs: Date.now() - started,
        ok: false,
        errorMessage: msg,
      });
      return { ok: false, error: msg, durationMs: Date.now() - started };
    }

    // Rule 4: execute.
    const handle = this.pool.acquire(session, app);
    try {
      const result = await handle.callTool<unknown>(
        call.tool,
        parsed.data as Record<string, unknown>,
      );
      session.record({
        app,
        toolName: call.tool,
        toolArgs: redact(call.args),
        durationMs: Date.now() - started,
        ok: true,
      });
      return {
        ok: true,
        result,
        app,
        durationMs: Date.now() - started,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      session.record({
        app,
        toolName: call.tool,
        toolArgs: redact(call.args),
        durationMs: Date.now() - started,
        ok: false,
        errorMessage: message,
      });
      return {
        ok: false,
        error: message,
        app,
        durationMs: Date.now() - started,
      };
    }
  }
}

/**
 * Strip payloads whose size would blow up the audit log. Images and base64
 * blobs are replaced with a length-prefixed placeholder.
 */
function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (typeof v === 'string' && v.length > 512) {
      out[k] = `<redacted ${v.length} chars>`;
    } else if (k === 'data' || k === 'base64') {
      out[k] = '<binary>';
    } else {
      out[k] = v;
    }
  }
  return out;
}
