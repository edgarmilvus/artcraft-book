// ═══════════════════════════════════════════════════════════════════════════
// FILE 2/9 — src/artcraft/engine-session.ts
// A hardened MCP stdio session: bounded concurrency, per-call timeouts,
// structured error normalisation, and job-aware command execution.
// ═══════════════════════════════════════════════════════════════════════════

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { JsonObject, JsonValue } from './recipe.js';

/** A single part of an MCP tool result. */
export interface McpPart {
  type: string;
  text?: string;
  data?: string;
  mimeType?: string;
}

/** Shape of `CallToolResult` as we consume it. */
export interface McpToolResponse {
  content?: McpPart[];
  isError?: boolean;
  structuredContent?: unknown;
}

/** Normalised engine failure. Always carries the offending tool id. */
export class EngineToolError extends Error {
  constructor(
    readonly tool: string,
    message: string,
    readonly raw?: unknown,
  ) {
    super(`[${tool}] ${message}`);
    this.name = 'EngineToolError';
  }
}

export class EngineTimeoutError extends Error {
  constructor(tool: string, ms: number) {
    super(`[${tool}] timed out after ${ms} ms`);
    this.name = 'EngineTimeoutError';
  }
}

/** Minimal counting semaphore. Prevents stdio flooding on batch fan-out. */
class Semaphore {
  private permits: number;
  private readonly waiters: Array<() => void> = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  async acquire(): Promise<void> {
    if (this.permits > 0) {
      this.permits -= 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next();
      return;
    }
    this.permits += 1;
  }
}

/** Rejects if the promise does not settle within `ms`. */
async function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new EngineTimeoutError(label, ms)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Serialises mutations against a single open document. */
export class DocumentMutex {
  private tail: Promise<unknown> = Promise.resolve();

  async run<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn);
    // Swallow rejections on the chain itself so one failure cannot poison it.
    this.tail = next.catch(() => undefined);
    return next;
  }
}

export interface EngineSessionOptions {
  /** e.g. 'photocraft-cli', 'filmcraft-cli', 'vectorcraft-cli'. */
  binary: string;
  /** Capability scope: reading is refused outside this tree. */
  readRoot: string;
  /** Capability scope: writing is refused outside this tree. */
  writeRoot: string;
  /** Extra argv appended after `mcp`, e.g. ['--connect', '7979']. */
  extraArgs?: string[];
  /** Per-RPC timeout. Long operations should use wait:false + jobs polling. */
  requestTimeoutMs?: number;
  /** Maximum concurrent in-flight RPCs. */
  maxConcurrent?: number;
  /** Sink for structured logs; defaults to a no-op. */
  log?: (event: Record<string, JsonValue>) => void;
}

/**
 * One MCP server process. Owns the transport, the concurrency budget,
 * and the request/response decoding contract.
 */
export class EngineSession {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private readonly gate: Semaphore;
  private readonly timeoutMs: number;
  private readonly log: (event: Record<string, JsonValue>) => void;
  private started = false;

  constructor(private readonly opts: EngineSessionOptions) {
    const args = [
      'mcp',
      '--automation-read-root',
      opts.readRoot,
      '--automation-write-root',
      opts.writeRoot,
      ...(opts.extraArgs ?? []),
    ];
    this.transport = new StdioClientTransport({
      command: opts.binary,
      args,
      cwd: opts.readRoot,
      env: { ...process.env } as Record<string, string>,
    });
    this.client = new Client(
      { name: 'layered-forge', version: '1.0.0' },
      { capabilities: {} },
    );
    this.gate = new Semaphore(opts.maxConcurrent ?? 4);
    this.timeoutMs = opts.requestTimeoutMs ?? 60_000;
    this.log = opts.log ?? (() => undefined);
  }

  /** Spawn the engine process and perform the MCP handshake. */
  async start(): Promise<void> {
    if (this.started) return;
    await this.client.connect(this.transport);
    this.started = true;
    this.log({ event: 'engine.start', binary: this.opts.binary });
  }

  /** Terminate the engine process. Safe to call more than once. */
  async close(): Promise<void> {
    if (!this.started) return;
    this.started = false;
    await this.client.close();
    this.log({ event: 'engine.stop', binary: this.opts.binary });
  }

  /**
   * Invoke one MCP tool and decode its result.
   *
   * Decoding contract:
   *   - transport/engine errors throw EngineToolError
   *   - a text part containing JSON is parsed
   *   - a text part that is not JSON is returned as a raw string
   *   - image parts are surfaced as { data, mimeType } for audit consumers
   */
  async call<T = JsonValue>(tool: string, args: JsonObject = {}): Promise<T> {
    await this.start();
    await this.gate.acquire();
    const startedAt = Date.now();
    try {
      const raw = (await withTimeout(
        this.client.callTool({ name: tool, arguments: args as Record<string, unknown> }),
        this.timeoutMs,
        tool,
      )) as McpToolResponse;

      const parts = raw.content ?? [];
      const textParts = parts.filter((p) => p.type === 'text' && typeof p.text === 'string');
      const imageParts = parts.filter((p) => p.type === 'image' && typeof p.data === 'string');
      const joined = textParts.map((p) => p.text as string).join('\n');

      if (raw.isError === true) {
        throw new EngineToolError(tool, joined || 'engine reported an error', raw);
      }

      // An image-bearing result (render_preview / ui_screenshot) is returned
      // as a structured object so callers never have to guess.
      if (imageParts.length > 0) {
        return {
          images: imageParts.map((p) => ({ data: p.data as string, mimeType: p.mimeType ?? 'image/png' })),
          text: joined,
        } as unknown as T;
      }

      if (joined.length === 0) return undefined as unknown as T;
      try {
        return JSON.parse(joined) as T;
      } catch {
        return joined as unknown as T;
      }
    } finally {
      this.gate.release();
      this.log({
        event: 'engine.call',
        tool,
        ms: Date.now() - startedAt,
      });
    }
  }
}

/** A single step of a `command_batch` payload. */
export interface BatchStep {
  id: string;
  params?: JsonObject;
  /** false starts a long command as a background job. */
  wait?: boolean;
}

export interface BatchOutcome {
  completed: number;
  failed: number;
  results: Array<{ ok: boolean; result?: JsonValue; error?: string }>;
}

/**
 * Engine-agnostic facade over the official meta-tools.
 *
 * Every method here maps to one documented MCP tool; nothing is invented.
 */
export class ArtCraftEngine {
  constructor(readonly session: EngineSession) {}

  /** `command_run` — run one registry command by id. */
  runCommand<T = JsonValue>(id: string, params: JsonObject = {}, wait = true): Promise<T> {
    return this.session.call<T>('command_run', { id, params, wait });
  }

  /** `command_list` — discover or verify the registry at runtime. */
  listCommands(filter?: string, enabledOnly?: boolean) {
    return this.session.call<JsonValue>('command_list', {
      ...(filter ? { filter } : {}),
      ...(enabledOnly !== undefined ? { enabled_only: enabledOnly } : {}),
    });
  }

  /** `command_batch` — ordered execution with a partial-failure report. */
  runBatch(steps: BatchStep[], stopOnError = true): Promise<BatchOutcome> {
    return this.session.call<BatchOutcome>('command_batch', {
      steps: steps as unknown as JsonValue,
      stop_on_error: stopOnError,
    });
  }

  /** `doc_new` / doc open lifecycle. */
  newDocument(params: JsonObject) {
    return this.session.call<{ document?: number }>('doc_new', params);
  }

  openDocument(path: string) {
    return this.session.call<JsonValue>('doc_open', { path });
  }

  /** `doc_inspect` — layer tree, history, selection, active layer. */
  inspect(params: JsonObject = {}) {
    return this.session.call<JsonValue>('doc_inspect', params);
  }

  /** `doc_save` — native master when the extension is native; export otherwise. */
  save(params: JsonObject = {}) {
    return this.session.call<JsonValue>('doc_save', params);
  }

  /** `doc_export` — explicit-format export. */
  exportDocument(params: JsonObject) {
    return this.session.call<JsonValue>('doc_export', params);
  }

  /** `doc_render_preview` — flattened PNG, headless-safe. */
  renderPreview(maxSide = 1024, index?: number) {
    return this.session.call<{ images: Array<{ data: string; mimeType: string }>; text: string }>(
      'doc_render_preview',
      { max_side: maxSide, ...(index !== undefined ? { index } : {}) },
    );
  }

  /**
   * `ui_screenshot` — PNG of the live desktop window.
   *
   * Bridge mode only: the MCP server must have been launched against a
   * running app (e.g. `photocraft-cli mcp --connect 7979`). This is the
   * correct capture for audits that must see panels, guides, rulers and
   * overlay chrome — not just the composited canvas.
   */
  uiScreenshot(maxSide = 0) {
    return this.session.call<{ images: Array<{ data: string; mimeType: string }>; text: string }>(
      'ui_screenshot',
      { max_side: maxSide },
    );
  }

  /** `jobs_list` — progress and terminal state of background jobs. */
  jobs() {
    return this.session.call<JsonValue>('jobs_list', {});
  }

  /** `jobs_cancel` — abort one job, or every running job when omitted. */
  cancelJobs(job?: number) {
    return this.session.call<JsonValue>('jobs_cancel', job !== undefined ? { job } : {});
  }

  /**
   * Run a command that may return a background job, and block until it ends.
   *
   * The document mutex MUST be held for the whole call. A background job keeps
   * a write lock on its document; any subsequent mutation of that document is
   * rejected by the engine until the job completes.
   */
  async runCommandAwaitingJob<T = JsonValue>(
    id: string,
    params: JsonObject = {},
    opts: { pollMs?: number; timeoutMs?: number } = {},
  ): Promise<T> {
    const first = await this.session.call<JsonValue>('command_run', { id, params, wait: false });
    const jobId = extractJobId(first);
    if (jobId === null) return first as unknown as T; // finished synchronously

    const pollMs = opts.pollMs ?? 250;
    const deadline = Date.now() + (opts.timeoutMs ?? 15 * 60_000);
    let backoff = pollMs;

    for (;;) {
      if (Date.now() > deadline) {
        await this.cancelJobs(jobId);
        throw new EngineToolError(id, `job ${jobId} exceeded its time budget`);
      }
      const state = await this.session.call<JsonValue>('jobs_list', {});
      const entry = findJob(state, jobId);
      if (entry) {
        const status = String(entry.state ?? entry.status ?? '');
        if (status === 'done' || status === 'completed') {
          return (entry.result ?? entry) as unknown as T;
        }
        if (status === 'failed' || status === 'cancelled' || status === 'canceled') {
          throw new EngineToolError(id, `job ${jobId} ended as ${status}`, entry);
        }
      }
      await sleep(backoff);
      backoff = Math.min(Math.round(backoff * 1.5), 2000);
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Pull a background job id out of a heterogeneous engine reply. */
function extractJobId(value: JsonValue | undefined): number | null {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const jid = (value as JsonObject).job;
    if (typeof jid === 'number') return jid;
  }
  return null;
}

/** Locate a job entry across the several shapes engines use for jobs_list. */
function findJob(state: JsonValue | undefined, jobId: number): JsonObject | null {
  if (!state || typeof state !== 'object') return null;
  const asObj = state as JsonObject;
  const pools: JsonValue[] = [];
  if (Array.isArray(asObj.running)) pools.push(...(asObj.running as JsonValue[]));
  if (Array.isArray(asObj.jobs)) pools.push(...(asObj.jobs as JsonValue[]));
  if (Array.isArray(asObj.finished)) pools.push(...(asObj.finished as JsonValue[]));
  for (const pool of pools) {
    if (pool && typeof pool === 'object' && !Array.isArray(pool)) {
      const obj = pool as JsonObject;
      if (obj.id === jobId || obj.job === jobId) return obj;
    }
  }
  return null;
}
