// src/governor.ts
import { readFile } from "node:fs/promises";
import { StudioPolicy } from "./policy/schema.js";
import { openVault } from "./policy/vault.js";
import { PolicyEngine } from "./policy/engine.js";
import { AuditLogger } from "./audit/logger.js";
import { McpClientFactory, GovernedClient } from "./mcp/factory.js";
import { syncCursor } from "./adapters/cursor.js";
import { syncClaude } from "./adapters/claude-code.js";
import { syncOpenCode } from "./adapters/opencode.js";
import type { DriftReport } from "./adapters/cursor.js";

export interface GovernorOptions {
  /** Absolute path to the policy JSON. */
  policyPath: string;
  /** Passphrase that unlocks the vault. Typically from an env var. */
  passphrase: string;
}

/**
 * The StudioGovernor is the entry point for a governed session. Its lifecycle
 * is: `load()` → `sync()` (optional, on demand) → `session(agentId)` → `close()`.
 */
export class StudioGovernor {
  private policy!: StudioPolicy;
  private engine!: PolicyEngine;
  private audit!: AuditLogger;
  private factory!: McpClientFactory;

  private constructor(private readonly opts: GovernorOptions) {}

  /**
   * Load and validate the policy, unlock the vault, open the audit chain.
   * Throws on any validation, decryption, or write failure — never returns a
   * partially initialised governor.
   */
  static async load(opts: GovernorOptions): Promise<StudioGovernor> {
    const gov = new StudioGovernor(opts);
    const raw = await readFile(opts.policyPath, "utf8");
    gov.policy = StudioPolicy.parse(JSON.parse(raw));
    gov.engine = new PolicyEngine(gov.policy);
    gov.audit = await AuditLogger.open(gov.policy.audit.path);
    const secrets = openVault(gov.policy.secrets, opts.passphrase);
    gov.factory = new McpClientFactory(gov.policy, secrets, gov.engine, gov.audit);
    return gov;
  }

  /**
   * Compile and write every agent's configuration, returning the drift report
   * so a caller (CI, a developer's pre-commit hook, or the SaaS control plane)
   * can decide whether to fail the run.
   */
  async sync(): Promise<Record<string, DriftReport[]>> {
    const out: Record<string, DriftReport[]> = {};
    for (const agent of this.policy.agents) {
      switch (agent.shell) {
        case "cursor":
          out[agent.id] = await syncCursor(this.policy.workspace, this.policy, this.engine, agent.id);
          break;
        case "claude-code":
          out[agent.id] = await syncClaude(this.policy.workspace, this.policy, this.engine, agent.id);
          break;
        case "opencode":
          out[agent.id] = await syncOpenCode(this.policy.workspace, this.policy, this.engine, agent.id);
          break;
      }
    }
    return out;
  }

  /**
   * Open a governed session for an agent. Returns a closeable object with
   * a map of per-craft `GovernedClient`s. Callers must `close()` when done.
   */
  async session(agentId: string): Promise<GovernedSession> {
    const clients = await this.factory.openFor(agentId);
    return new GovernedSession(agentId, clients);
  }

  /** Access the policy engine for out-of-band queries. */
  get policyEngine(): PolicyEngine { return this.engine; }
  /** The tail of the audit chain — the anchor a receipt points at. */
  get auditTail(): { seq: number; hash: string } { return this.audit.tail; }
  /** Access the raw parsed policy. */
  get policyDoc(): StudioPolicy { return this.policy; }
}

/**
 * A live governed session. Provides typed helpers for the meta-tools, so
 * pipeline code never reaches for `client.call("command_run", …)` directly.
 */
export class GovernedSession {
  constructor(
    public readonly agentId: string,
    private readonly clients: Map<string, GovernedClient>,
  ) {}

  /** Retrieve the governed client for a specific craft, or throw. */
  craft(id: string): GovernedClient {
    const c = this.clients.get(id);
    if (!c) throw new Error(`agent "${this.agentId}" has no access to craft "${id}"`);
    return c;
  }

  /** Close every underlying MCP session. Idempotent. */
  async close(): Promise<void> {
    await Promise.all([...this.clients.values()].map((c) => c.close()));
  }
}
