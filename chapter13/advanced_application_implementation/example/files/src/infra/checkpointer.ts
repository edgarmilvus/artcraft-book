// src/infra/checkpointer.ts
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * The stages are ordered; resumption starts from the first un-completed
 * stage. The pipeline writes the checkpoint after each stage boundary.
 */
export type StageId = "open" | "grade" | "duck" | "loudness" | "preview";

export interface Checkpoint {
  readonly jobId: string;
  readonly stage: StageId;
  readonly recipeHash: string;
  readonly policyHash: string;
  readonly targetHash: string;
  readonly startedAt: number;
  readonly lastTouchedAt: number;
}

export class FileCheckpointer {
  public constructor(private readonly path: string) {}

  public async load(jobId: string): Promise<Checkpoint | null> {
    try {
      const raw = await readFile(this.path, "utf8");
      const parsed = JSON.parse(raw) as Checkpoint[];
      return parsed.find((c) => c.jobId === jobId) ?? null;
    } catch {
      return null;
    }
  }

  public async upsert(checkpoint: Checkpoint): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    let list: Checkpoint[] = [];
    try {
      const raw = await readFile(this.path, "utf8");
      list = JSON.parse(raw) as Checkpoint[];
    } catch {
      list = [];
    }
    const idx = list.findIndex((c) => c.jobId === checkpoint.jobId);
    if (idx >= 0) list[idx] = checkpoint;
    else list.push(checkpoint);
    await writeFile(this.path, JSON.stringify(list, null, 2), "utf8");
  }

  public static hash(value: unknown): string {
    return createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex")
      .slice(0, 16);
  }
}
