/**
 * @file lightcraft-raw-pipeline.ts
 * @summary Production-grade MCP orchestrator for high-throughput RAW ingest,
 *          AI-assisted culling, 32-bit float linear grading, and multi-tier
 *          delivery via the LightCraft MCP server.
 *
 * @remarks
 * This module is the control-plane worker for a SaaS photographic delivery
 * pipeline. It speaks to `lightcraft-cli mcp` over stdio using the official
 * MCP meta-tools (`command_run`, `command_batch`, `doc_inspect`, `render_preview`).
 * The heavy lifting (RAW decode, AI denoise, HSL math, tiling, ICC transforms)
 * runs inside the LightCraft engine on the same node, so pixel data never
 * crosses the network until the final export lands in object storage.
 *
 * Design principles:
 *   1. **Edge-first**: model inference and pixel math never leave the worker.
 *   2. **Idempotent**: every stage can be re-run against the same catalog
 *      without duplicating work (import dedup, stack dedup, export overwrite).
 *   3. **Observable**: every command returns structured JSON that is emitted
 *      to the SaaS telemetry bus (per-photo cost, per-stage latency).
 *   4. **Retry-safe**: transient MCP faults are retried with exponential
 *      backoff and jitter; the pipeline is resumable from any stage.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";

/* ============================================================================
 * 1. Configuration surface (validated, environment-driven)
 * ========================================================================== */

/**
 * Runtime configuration for a single pipeline invocation.
 * In the SaaS context this is derived from the job envelope enqueued by the
 * ingest worker (SQS / Pub-Sub / Kafka) and merged with worker defaults.
 */
export const PipelineConfigSchema = z.object({
  /** Filesystem root where the RAW masters were staged by the ingest tier. */
  readRoot: z.string(),
  /** Filesystem root where exports and sidecars may be written. */
  writeRoot: z.string(),
  /** Absolute path of the catalog (Originals/ + `.lrcat`-equivalent store). */
  catalogPath: z.string(),
  /** ISO date used for the dated destination tree (`YYYY/YYYY-MM-DD`). */
  eventDate: z.string(),
  /** Album name; the album becomes the delivery unit attached to the client. */
  albumName: z.string(),
  /** Number of sharpness points (0..100) below which a frame is rejected. */
  cullRejectBelow: z.number().min(0).max(100).default(35),
  /** Whether to auto-pick the sharpest frame in each burst group. */
  cullPickBest: z.boolean().default(true),
  /** Seconds between consecutive captures that define a burst for auto-stack. */
  burstGapSeconds: z.number().min(1).max(600).default(4),
  /** LUT to import as a creative profile (e.g. Rec.2020 → Rec.709 trim). */
  inputLutPath: z.string().optional(),
  /** Metadata preset applied to every imported photo (copyright, creator). */
  metadataPreset: z.string().optional(),
  /** Export tiers the platform bills for. */
  tiers: z.array(
    z.enum(["web_preview", "print_16bit", "archival_dng"]),
  ).min(1),
  /** Optional HDR bracket groups to merge before develop. */
  hdrMerge: z.boolean().default(false),
});

export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;

/* ============================================================================
 * 2. Structured result types (emitted to the SaaS telemetry bus)
 * ========================================================================== */

/** Aggregate output of the orchestrator, one instance per job. */
export interface PipelineResult {
  readonly eventDate: string;
  readonly album: string;
  readonly imported: number;
  readonly duplicates: number;
  readonly moved: number;
  readonly culledGroups: number;
  readonly rejected: number;
  readonly picked: number;
  readonly hdrMerged: number;
  readonly graded: number;
  readonly exported: ReadonlyArray<{ tier: string; files: number; bytes: number }>;
  readonly stageDurationsMs: Readonly<Record<string, number>>;
}

/* ============================================================================
 * 3. Lightweight structured logger (maps to OpenTelemetry in production)
 * ========================================================================== */

/**
 * Minimal logging facade. In the SaaS deployment this is replaced by a
 * pino/OTel bridge; the interface below is intentionally stable so the
 * pipeline can be unit-tested without a transport.
 */
export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export const consoleLogger: Logger = {
  info: (msg, meta) => console.log(JSON.stringify({ level: "info", msg, ...meta })),
  warn: (msg, meta) => console.warn(JSON.stringify({ level: "warn", msg, ...meta })),
  error: (msg, meta) => console.error(JSON.stringify({ level: "error", msg, ...meta })),
};

/* ============================================================================
 * 4. Transport wrapper: retry-safe MCP command dispatch
 * ========================================================================== */

/**
 * Wraps an MCP `Client` and exposes typed helpers around LightCraft’s
 * meta-tools. All payloads are JSON-serialisable so they can be cached,
 * replayed, or diffed in a job ledger.
 */
export class LightCraftClient {
  private readonly client: Client;
  private readonly log: Logger;

  constructor(client: Client, log: Logger = consoleLogger) {
    this.client = client;
    this.log = log;
  }

  /**
   * Boot a client over stdio, launching `lightcraft-cli mcp` against a
   * library folder.
   *
   * LightCraft has no automation roots: there is no
   * `--automation-read-root` / `--automation-write-root` pair to set. The
   * library is opened with `--library`, and the engine reads the files the
   * `import` tool is given.
   */
  static async spawn(cfg: PipelineConfig, log: Logger = consoleLogger): Promise<LightCraftClient> {
    const transport = new StdioClientTransport({
      command: "lightcraft-cli",
      args: ["mcp", "--library", cfg.catalogPath],
    });
    const client = new Client(
      { name: "saas-raw-pipeline", version: "1.4.0" },
      { capabilities: {} },
    );
    await client.connect(transport);
    return new LightCraftClient(client, log);
  }

  /**
   * Dispatch a single command through `command_run` with retry/backoff.
   * @param id - LightCraft engine command id (e.g. `library.import`).
   * @param params - Command parameters per the runtime schema.
   * @param retries - Number of retry attempts for transient faults.
   */
  async run<T = unknown>(
    id: string,
    params: Record<string, unknown> = {},
    retries = 3,
  ): Promise<T> {
    let attempt = 0;
    let lastErr: unknown;
    while (attempt <= retries) {
      try {
        const res = await this.client.callTool({
          name: "command_run",
          arguments: { id, params },
        });
        // MCP returns the tool result as a JSON-encoded text payload.
        return this.unwrap<T>(res);
      } catch (err) {
        lastErr = err;
        attempt += 1;
        const delay = Math.round((2 ** attempt) * 250 + Math.random() * 200);
        this.log.warn("command retry", { id, attempt, delay, err: String(err) });
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    this.log.error("command failed permanently", { id, err: String(lastErr) });
    throw lastErr;
  }

  /**
   * Dispatch a group of commands atomically (where supported) or sequentially
   * with `stop_on_error: true`. This is the primary path for stage-level
   * operations that must either fully succeed or be replayed as a unit.
   */
  async batch<T = unknown>(
    steps: Array<{ id: string; params?: Record<string, unknown> }>,
    stopOnError = true,
  ): Promise<T> {
    const res = await this.client.callTool({
      name: "command_batch",
      arguments: { steps, stop_on_error: stopOnError },
    });
    return this.unwrap<T>(res);
  }

  /**
   * Read the LightCraft library state (source, filter, sort, selection,
   * active photo, undo labels, catalog stats). Cheap; used for progress.
   */
  async inspect(): Promise<unknown> {
    const res = await this.client.callTool({ name: "doc_inspect", arguments: {} });
    return this.unwrap<unknown>(res);
  }

  /** Close the MCP client and its transport cleanly. */
  async close(): Promise<void> {
    await this.client.close();
  }

  /**
   * MCP tool results arrive as `{ content: [{ type: "text", text: "<json>" }] }`.
   * This helper normalises them into plain typed values.
   */
  private unwrap<T>(res: unknown): T {
    const content = (res as { content?: Array<{ type: string; text?: string }> }).content;
    const first = content?.find((c) => c.type === "text");
    if (!first?.text) return undefined as unknown as T;
    try {
      return JSON.parse(first.text) as T;
    } catch {
      return first.text as unknown as T;
    }
  }
}
