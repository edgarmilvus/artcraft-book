// src/infra/checkpointer-postgres.ts (illustrative interface conformance)
import type { Checkpoint } from "./checkpointer.js";

/**
 * PostgreSQL-backed checkpointer. The `checkpoints` table declares
 * `job_id TEXT PRIMARY KEY`, so a concurrent upsert races are resolved
 * by Postgres' standard INSERT ... ON CONFLICT DO UPDATE semantics:
 * whichever transaction commits last wins, and the "last_touched_at"
 * column disambiguates zombie jobs from live ones.
 *
 * This class conforms to the same interface as FileCheckpointer; the
 * orchestrator takes a structural type and never cares which backs it.
 */
export interface DurableCheckpointer {
  load(jobId: string): Promise<Checkpoint | null>;
  upsert(checkpoint: Checkpoint): Promise<void>;
}

export class PostgresCheckpointer implements DurableCheckpointer {
  public constructor(private readonly conn: { query: (sql: string, params: unknown[]) => Promise<unknown> }) {}

  public async load(jobId: string): Promise<Checkpoint | null> {
    const res = await this.conn.query(
      `SELECT job_id, stage, recipe_hash, policy_hash, target_hash,
              started_at, last_touched_at
         FROM checkpoints WHERE job_id = $1`,
      [jobId],
    ) as { rows: Array<Record<string, unknown>> };
    const row = res.rows[0];
    if (!row) return null;
    return {
      jobId: row.job_id as string,
      stage: row.stage as Checkpoint["stage"],
      recipeHash: row.recipe_hash as string,
      policyHash: row.policy_hash as string,
      targetHash: row.target_hash as string,
      startedAt: Number(row.started_at),
      lastTouchedAt: Number(row.last_touched_at),
    };
  }

  public async upsert(c: Checkpoint): Promise<void> {
    await this.conn.query(
      `INSERT INTO checkpoints
         (job_id, stage, recipe_hash, policy_hash, target_hash,
          started_at, last_touched_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (job_id) DO UPDATE SET
         stage = EXCLUDED.stage,
         last_touched_at = EXCLUDED.last_touched_at`,
      [
        c.jobId, c.stage, c.recipeHash, c.policyHash, c.targetHash,
        c.startedAt, c.lastTouchedAt,
      ],
    );
  }
}
