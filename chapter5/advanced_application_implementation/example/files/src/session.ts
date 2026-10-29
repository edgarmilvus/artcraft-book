/**
 * @file creativeforge/session.ts
 *
 * Session-level abstraction for a single creative brief execution.
 *
 * A Session owns:
 *   - its tenant identity and billing context
 *   - a private sandbox directory on disk (the ONLY thing ArtCraft MCP
 *     workers can read from or write to)
 *   - the set of MCP client handles currently alive for this brief
 *   - the audit trail for every tool invocation that fired
 *
 * Sessions are immutable in their identity fields (tenantId, sessionId,
 * sandboxRoot) but mutable in their bookkeeping fields (documentsWritten,
 * costCents, etc.).
 */

import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Client } from '@modelcontextprotocol/sdk/client/index.js';

/** Which ArtCraft application a given MCP worker runs. */
export type CraftApp =
  | 'photocraft'
  | 'vectorcraft'
  | 'filmcraft'
  | 'effectcraft'
  | 'designcraft'
  | 'lightcraft'
  | 'pdfcraft'
  | 'wordcraft';

/** A single recorded tool invocation — the audit-log record shape. */
export interface AuditRecord {
  readonly timestamp: number;
  readonly sessionId: string;
  readonly tenantId: string;
  readonly app: CraftApp;
  readonly toolName: string;        // e.g. "command_run"
  readonly toolArgs: unknown;       // redacted before persistence
  readonly durationMs: number;
  readonly ok: boolean;
  readonly errorMessage?: string;
}

/**
 * One creative-brief execution. Effectively a "workspace" in the MCP sense:
 * it aggregates a pool of client connections bound to the same on-disk
 * sandbox, and it exposes the tenant's policy decisions to the router.
 */
export class Session {
  public readonly sessionId: string = randomUUID();
  public readonly sandboxRoot: string;
  public readonly clients = new Map<CraftApp, Client>();
  public readonly auditTrail: AuditRecord[] = [];

  /** Documents the session has produced (relative to sandboxRoot/write). */
  public readonly outputs: string[] = [];

  /** Accumulated cost, in cents — populates the tenant's invoice row. */
  public costCents = 0;

  private constructor(
    public readonly tenantId: string,
    sandboxRoot: string,
    /** If false, the LLM loop is forbidden from calling any UI tool. */
    public readonly visualAttachAllowed: boolean,
  ) {
    this.sandboxRoot = sandboxRoot;
  }

  /**
   * Factory: allocate a fresh, tenant-scoped sandbox and return a Session
   * bound to it. The sandbox is a tmpdir parented under the tenant's
   * allocated disk quota (in production this is an overlayfs mount, but a
   * plain mkdtemp is fine for the reference implementation).
   */
  public static async create(
    tenantId: string,
    visualAttachAllowed: boolean,
  ): Promise<Session> {
    const base = join(tmpdir(), 'creativeforge');
    await mkdir(base, { recursive: true });
    // Tenant ids come from the auth layer, but they end up in a path: keep
    // only characters that cannot escape `base`.
    const safe = tenantId.replace(/[^A-Za-z0-9_-]/g, '_');
    const root = await mkdtemp(join(base, `${safe}-`));
    const session = new Session(tenantId, root, visualAttachAllowed);
    // The capability roots must exist before a worker is spawned against
    // them: the CLI validates both paths at startup.
    await Promise.all([
      mkdir(session.readRoot, { recursive: true }),
      mkdir(session.writeRoot, { recursive: true }),
    ]);
    return session;
  }

  /** Absolute path ArtCraft workers may read from. */
  public get readRoot(): string {
    return join(this.sandboxRoot, 'read');
  }

  /** Absolute path ArtCraft workers may write to. */
  public get writeRoot(): string {
    return join(this.sandboxRoot, 'write');
  }

  /** Append an audit record; caller supplies a pre-redacted argument blob. */
  public record(rec: Omit<AuditRecord, 'sessionId' | 'tenantId' | 'timestamp'>): void {
    this.auditTrail.push({
      timestamp: Date.now(),
      sessionId: this.sessionId,
      tenantId: this.tenantId,
      ...rec,
    });
  }

  /**
   * Terminate every MCP worker bound to this session. Called on brief
   * completion, on policy violation, or on orchestrator shutdown. Never
   * throws — errors from individual clients are swallowed and logged so the
   * rest of the pool still gets closed.
   */
  public async dispose(): Promise<void> {
    const closes = [...this.clients.entries()].map(async ([app, client]) => {
      try {
        await client.close();
      } catch (err) {
        console.warn(`[session ${this.sessionId}] close ${app} failed:`, err);
      }
    });
    await Promise.allSettled(closes);
    this.clients.clear();
  }
}
