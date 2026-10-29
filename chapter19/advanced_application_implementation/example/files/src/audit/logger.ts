// src/audit/logger.ts
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/**
 * A deterministic, canonical JSON serializer used wherever an "envelope" hash
 * is computed. Key order is stabilised recursively so that two structurally
 * identical invocations always produce the same digest.
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const parts = keys.map((k) => `${JSON.stringify(k)}:${canonicalize((value as any)[k])}`);
  return `{${parts.join(",")}}`;
}

export interface AuditEntry {
  /** Monotonic sequence number, 1-based. */
  seq: number;
  /** ISO-8601 millisecond timestamp, UTC. */
  ts: string;
  /** Fully-qualified agent id (e.g. "cursor:lead-designer"). */
  agent: string;
  /** Craft binding id the action targeted. */
  craft: string;
  /** Meta-tool that was invoked (command_run, command_batch, doc_new, …). */
  tool: string;
  /** Canonical nested payload sent to the tool. */
  payload: unknown;
  /** Status of the underlying MCP call. */
  status: "ok" | "denied" | "error";
  /** For denied entries: the specific rule that fired. */
  reason?: string;
  /** SHA-256 over canonicalize({seq, ts, agent, craft, tool, payload, status, prev}). */
  hash: string;
  /** Hash of the previous entry, or 64 zeros for the genesis entry. */
  prev: string;
}

const ZERO_HASH = "0".repeat(64);

/**
 * Append-only audit logger with a linear SHA-256 hash chain. Not thread-safe
 * across processes; a production SaaS deployment mounts this behind a
 * serialising mutex (or routes all writes through the governor, which is
 * single-threaded by construction via the Node.js event loop).
 */
export class AuditLogger {
  private lastHash = ZERO_HASH;
  private seq = 0;

  private constructor(private readonly path: string) {}

  /** Open (or create) the audit log at the given path. */
  static async open(path: string): Promise<AuditLogger> {
    await mkdir(dirname(path), { recursive: true });
    const logger = new AuditLogger(path);
    try {
      const raw = await readFile(path, "utf8");
      const lines = raw.split("\n").filter((l) => l.trim().length > 0);
      if (lines.length > 0) {
        const last = JSON.parse(lines[lines.length - 1]!) as AuditEntry;
        logger.lastHash = last.hash;
        logger.seq = last.seq;
      }
    } catch {
      // First run: genesis state is already correct.
      await writeFile(path, "", "utf8");
    }
    return logger;
  }

  /**
   * Record an entry. The caller passes the *intent* of the action; the logger
   * computes the hash and appends the line atomically.
   */
  async record(entry: Omit<AuditEntry, "seq" | "ts" | "hash" | "prev">): Promise<AuditEntry> {
    const seq = ++this.seq;
    const ts = new Date().toISOString();
    const prev = this.lastHash;
    const hash = createHash("sha256")
      .update(canonicalize({ seq, ts, agent: entry.agent, craft: entry.craft, tool: entry.tool, payload: entry.payload, status: entry.status, reason: entry.reason ?? null, prev }))
      .digest("hex");
    const full: AuditEntry = { seq, ts, ...entry, hash, prev };
    await appendFile(this.path, JSON.stringify(full) + "\n", "utf8");
    this.lastHash = hash;
    return full;
  }

  /** Return the current tail hash (useful as a checkpoint anchor). */
  get tail(): { seq: number; hash: string } {
    return { seq: this.seq, hash: this.lastHash };
  }
}

/**
 * Verify that an audit log has not been tampered with. Returns the number of
 * valid entries on success; throws on the first inconsistency found.
 */
export async function verifyAudit(path: string): Promise<number> {
  const raw = await readFile(path, "utf8");
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  let prev = ZERO_HASH;
  let expectedSeq = 1;
  for (const line of lines) {
    const entry = JSON.parse(line) as AuditEntry;
    if (entry.seq !== expectedSeq) throw new Error(`audit: sequence gap at ${expectedSeq}`);
    if (entry.prev !== prev) throw new Error(`audit: broken chain at seq ${entry.seq}`);
    const recomputed = createHash("sha256")
      .update(canonicalize({ seq: entry.seq, ts: entry.ts, agent: entry.agent, craft: entry.craft, tool: entry.tool, payload: entry.payload, status: entry.status, reason: entry.reason ?? null, prev: entry.prev }))
      .digest("hex");
    if (recomputed !== entry.hash) throw new Error(`audit: content hash mismatch at seq ${entry.seq}`);
    prev = entry.hash;
    expectedSeq++;
  }
  return lines.length;
}
