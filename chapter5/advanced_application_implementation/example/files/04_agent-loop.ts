/**
 * @file creativeforge/agent-loop.ts
 *
 * The LLM tool-use loop. This is where the brief goes in and finished
 * documents come out.
 *
 * Key design decisions:
 *   1. Tool definitions are DYNAMIC — pulled from `tools/list` on each
 *      ArtCraft MCP server at session start, then name-spaced. This is
 *      what satisfies the "runtime ground truth" doctrine in the
 *      governance spec: if a tool isn't advertised, the LLM never sees it.
 *   2. We cap the loop at MAX_TURNS to prevent runaway spend.
 *   3. Every tool call is dispatched through the router, which handles
 *      validation, policy, and audit.
 */

import Anthropic from '@anthropic-ai/sdk';
import { ToolRouter } from './router.js';
import { ClientPool } from './pool.js';
import { Session, CraftApp } from './session.js';

const MAX_TURNS = 24;
const MODEL = 'claude-sonnet-4-20250514';

/** Namespace we prefix every MCP tool with, so the LLM can't collide them. */
const NS = (app: CraftApp, tool: string) => `${app}__${tool}`;

interface RegisteredTool {
  app: CraftApp;
  mcpName: string;                                    // e.g. "command_run"
  description: string;                                // from tools/list
  input_schema: { type: 'object'; [k: string]: unknown };
}

/**
 * Fetch the tool catalog for every ArtCraft app we intend to expose: one
 * tool definition per (app, meta-tool) pair that the worker actually
 * advertises in its `tools/list` reply.
 *
 * For pedagogical clarity we only emit the meta-tools; extending this to
 * emit one MCP tool per ArtCraft command is a one-line loop change:
 *   for (const cmd of registry.commands) tools.push({...});
 */
async function buildToolCatalog(
  pool: ClientPool,
  session: Session,
  apps: CraftApp[],
): Promise<RegisteredTool[]> {
  const tools: RegisteredTool[] = [];

  const META: Array<{ name: string; desc: string; schema: RegisteredTool["input_schema"] }> = [
    {
      name: 'command_run',
      desc: 'Execute one ArtCraft engine command by id with JSON params.',
      schema: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Command id, e.g. layer.new.layer' },
          params: { type: 'object', description: 'Command parameters' },
          wait: { type: 'boolean', description: 'Wait for long-running commands' },
        },
        required: ['id'],
      },
    },
    {
      name: 'command_batch',
      desc: 'Execute several commands atomically where supported.',
      schema: {
        type: 'object',
        properties: {
          steps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                params: { type: 'object' },
              },
              required: ['id'],
            },
          },
          stop_on_error: { type: 'boolean' },
          atomic: { type: 'boolean' },
        },
        required: ['steps'],
      },
    },
    {
      name: 'doc_new',
      desc: 'Create a new document (canvas).',
      schema: {
        type: 'object',
        properties: {
          width: { type: 'integer' },
          height: { type: 'integer' },
          mode: { type: 'string' },
          depth: { type: 'integer' },
          background: { type: 'string' },
        },
      },
    },
    {
      name: 'doc_save',
      desc: 'Save the active document.',
      schema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          format: { type: 'string' },
          quality: { type: 'integer' },
        },
      },
    },
    {
      name: 'doc_inspect',
      desc: 'Inspect the current document tree (layers, props, history).',
      schema: { type: 'object', properties: {} },
    },
    {
      name: 'doc_render_preview',
      desc: 'Return a PNG preview of the current document.',
      schema: {
        type: 'object',
        properties: { max_side: { type: 'integer' } },
      },
    },
  ];

  for (const app of apps) {
    // Ask the worker what it actually advertises: the MCP handshake's
    // `tools/list` is the runtime ground truth. A worker that fails to
    // start is skipped rather than failing the whole brief.
    const handle = pool.acquire(session, app);
    let advertised: Map<string, string>;
    try {
      advertised = new Map(
        (await handle.listTools()).map((t) => [t.name, t.description ?? '']),
      );
    } catch (err) {
      console.warn(`[catalog] ${app} unreachable, skipping:`, err);
      continue;
    }
    for (const meta of META) {
      // Only ship a tool the worker declared. This is what "if a tool
      // isn't advertised, the LLM never sees it" means in practice.
      const description = advertised.get(meta.name);
      if (description === undefined) continue;
      tools.push({
        app,
        mcpName: meta.name,
        description: `[${app}] ${description || meta.desc}`,
        input_schema: meta.schema,
      });
    }
  }
  return tools;
}

/** The result of a completed brief. */
export interface BriefOutcome {
  sessionId: string;
  turns: number;
  finalMessage: string;
  outputs: string[];
  costCents: number;
}

/**
 * The slice of the Anthropic client the loop actually uses. Keeping it
 * narrow lets a test drive the whole pipeline — router, pool, engines —
 * with a scripted model and no API key.
 */
export interface LlmClient {
  messages: {
    create(body: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message>;
  };
}

/**
 * Drive one tenant brief to completion.
 *
 * @param tenantId            Owning tenant.
 * @param brief               The user prompt — natural language.
 * @param apps                Which ArtCraft apps to expose for this brief.
 * @param visualAttach        Tenant's Visual Attach entitlement flag.
 * @param llm                 Model client; production passes nothing.
 */
export async function runBrief(
  tenantId: string,
  brief: string,
  apps: CraftApp[],
  visualAttach: boolean,
  /** Inject a scripted model in tests; production passes nothing. */
  llm: LlmClient = new Anthropic(),
): Promise<BriefOutcome> {
  const session = await Session.create(tenantId, visualAttach);
  const pool = new ClientPool();
  const router = new ToolRouter(pool);

  try {
    const catalog = await buildToolCatalog(pool, session, apps);

    // Translate our internal catalog into Anthropic's tool shape.
    const anthropicTools = catalog.map((t) => ({
      name: NS(t.app, t.mcpName),
      description: t.description,
      input_schema: t.input_schema,
    }));

    // A name → registration map so we can un-namespace on dispatch.
    const byName = new Map(catalog.map((t) => [NS(t.app, t.mcpName), t]));

    const messages: Anthropic.MessageParam[] = [
      {
        role: 'user',
        content:
          `You are CreativeForge, an autonomous creative director agent.\n` +
          `You have access to the following ArtCraft applications:\n` +
          apps.map((a) => `- ${a}`).join('\n') +
          `\n\nBrief:\n${brief}\n\n` +
          `Work step-by-step. Prefer command_batch for multi-step edits. ` +
          `Save every artifact into the session write root: pass a bare ` +
          `relative filename, never an absolute path. When you are done, reply ` +
          `with a concise plain-text summary of what you produced.`,
      },
    ];

    let turn = 0;
    let finalMessage = '';
    while (turn < MAX_TURNS) {
      turn += 1;
      const resp = await llm.messages.create({
        model: MODEL,
        max_tokens: 4096,
        tools: anthropicTools,
        messages,
      });

      messages.push({ role: 'assistant', content: resp.content });

      const asksForTools = resp.content.some((b) => b.type === 'tool_use');
      if (!asksForTools) {
        finalMessage = resp.content
          .filter((b): b is Anthropic.TextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n');
        break;
      }

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const block of resp.content) {
        if (block.type !== 'tool_use') continue;
        const registered = byName.get(block.name);
        if (!registered) {
          results.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: `error: unknown tool ${block.name}`,
            is_error: true,
          });
          continue;
        }

        const dispatched = await router.dispatch(session, {
          app: registered.app,
          tool: registered.mcpName as never,
          args: block.input as Record<string, unknown>,
        });

        results.push({
          type: 'tool_result',
          tool_use_id: block.id,
          content: dispatched.ok
            ? JSON.stringify(dispatched.result ?? null)
            : `error: ${dispatched.error}`,
          is_error: !dispatched.ok,
        });

        // Track written documents for the tenant's output listing. Only a
        // successful save counts: a refused path must not appear as delivered.
        if (dispatched.ok &&
            registered.mcpName === 'doc_save' &&
            typeof (block.input as { path?: unknown }).path === 'string') {
          session.outputs.push((block.input as { path: string }).path);
        }
      }

      messages.push({ role: 'user', content: results });
    }

    // Rough billing model: sum the wall-clock seconds of worker calls.
    const totalMs = session.auditTrail.reduce((a, r) => a + r.durationMs, 0);
    session.costCents = Math.ceil(totalMs / 1000) * 3; // 3¢/sec of worker time

    return {
      sessionId: session.sessionId,
      turns: turn,
      finalMessage,
      outputs: [...session.outputs],
      costCents: session.costCents,
    };
  } finally {
    await session.dispose();
    pool.forget(session);
  }
}
