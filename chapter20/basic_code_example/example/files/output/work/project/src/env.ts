/**
 * Owns one responsibility: turn the process environment into a typed,
 * validated configuration object. Nothing else in the studio reads
 * `process.env`, so a missing or malformed value is caught once, at the
 * boundary — before an engine is spawned or a file is written.
 *
 * The studio asks for no secrets. A hosted deployment would also read
 * `OPENAI_API_KEY` and `SUPABASE_URL` here; this build takes the
 * embedding model and the brand store as injected interfaces instead,
 * so the process starts with an empty environment and still runs from
 * the first line to the last.
 */
import { accessSync, constants, mkdirSync } from "node:fs";
import { resolve } from "node:path";

/** The validated configuration every other module consumes. */
export interface StudioEnv {
  /** The PhotoCraft binary the bridge spawns over stdio. */
  readonly photocraftBin: string;
  /** The directory the studio writes its artefacts into. */
  readonly workDir: string;
  /** Units a single campaign run may spend on engine dispatches. */
  readonly budgetUnits: number;
  /** The width of the embedding column; every vector must match it. */
  readonly embeddingDim: number;
}

const DEFAULT_PHOTOCRAFT_BIN = "photocraft-cli";
const DEFAULT_BUDGET_UNITS = 8;
const DEFAULT_EMBEDDING_DIM = 1536;

/**
 * Reads the configuration. Every value has a default, and every value
 * that is present must be well formed: a typo in a numeric variable is
 * a configuration bug, and it is cheaper to find it here than three
 * layers down.
 */
export function loadStudioEnv(env: NodeJS.ProcessEnv = process.env): StudioEnv {
  return {
    photocraftBin: env.PHOTOCRAFT_BIN ?? DEFAULT_PHOTOCRAFT_BIN,
    workDir: resolve(
      env.STUDIO_WORK_DIR ?? resolve(process.cwd(), "output", "work"),
    ),
    budgetUnits: readPositiveInt(
      env.STUDIO_BUDGET_UNITS,
      DEFAULT_BUDGET_UNITS,
      "STUDIO_BUDGET_UNITS",
    ),
    embeddingDim: readPositiveInt(
      env.STUDIO_EMBEDDING_DIM,
      DEFAULT_EMBEDDING_DIM,
      "STUDIO_EMBEDDING_DIM",
    ),
  };
}

/**
 * Creates the work directory and proves the process may write into it.
 * The studio writes three things — the brand store, the run journal and
 * the rendered banner — and all three live under this one root.
 */
export function ensureStudioWorkDir(env: StudioEnv): string {
  mkdirSync(env.workDir, { recursive: true });
  accessSync(env.workDir, constants.W_OK);
  return env.workDir;
}

/** Parses a positive integer, or fails with the name of the offender. */
function readPositiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined || raw.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(
      `studio-hello: ${name} must be a positive integer, got ${JSON.stringify(raw)}`,
    );
  }
  return parsed;
}
