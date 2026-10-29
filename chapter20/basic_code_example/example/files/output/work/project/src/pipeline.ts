/**
 * The orchestration module: it owns the order of the work and the
 * ledger of the run.
 *
 * The ledger has two halves. The budget is the envelope that bounds
 * what a campaign may spend on the engine; a run that cannot pay for
 * its render is refused before the engine is spawned. The journal is
 * the trace of the run — one line per step, in order — and it is what
 * makes a campaign replayable: the same brief and the same corpus
 * produce the same banner, the same journal and the same bytes.
 */
import { createHash } from "node:crypto";
import { mkdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { BrandStore } from "./dbClient.js";
import {
  embedBrief,
  findSimilarBrandAssets,
  MATCH_COUNT,
  MATCH_THRESHOLD,
  type EmbeddingModel,
} from "./brandMemory.js";
import {
  HERO_RENDER_COST,
  type HeroRenderResult,
  type HeroRenderSpec,
} from "./photocraftBridge.js";
import type { StudioEnv } from "./env.js";

/** The four fields a campaign brief carries. */
export interface StudioBrief {
  readonly product: string;
  readonly audience: string;
  readonly tone: string;
  readonly callToAction: string;
}

/** One step of the run, as the journal records it. */
export interface JournalEntry {
  readonly step: number;
  readonly name: string;
  readonly detail: string;
  readonly at: string;
}

/** The state of the budget envelope at the end of a run. */
export interface BudgetSnapshot {
  readonly limit: number;
  readonly spent: number;
  readonly remaining: number;
}

/** What one campaign run produced. */
export interface StudioRunResult {
  /** The content-addressed id of the run. */
  readonly runId: string;
  /** The absolute path of the rendered banner. */
  readonly assetPath: string;
  readonly headline: string;
  readonly subhead: string;
  /** The exemplar the retrieval grounded the copy in, if any. */
  readonly exemplarId: string | null;
  readonly exemplarSimilarity: number | null;
  /** Everything the engine complained about. */
  readonly warnings: readonly string[];
  /** The trace of the run. */
  readonly journal: readonly JournalEntry[];
  /** What the run cost. */
  readonly budget: BudgetSnapshot;
}

/**
 * Everything the pipeline needs, injected. The pipeline builds no
 * client, spawns no process and reads no environment of its own, which
 * is what makes it testable without a network and without a database.
 */
export interface StudioDeps {
  readonly env: StudioEnv;
  readonly store: BrandStore;
  readonly embed: EmbeddingModel;
  readonly render: (spec: HeroRenderSpec) => Promise<HeroRenderResult>;
  /** The clock the journal is stamped with; injected for replay. */
  readonly now?: () => string;
}

/**
 * The envelope that bounds what a run may spend. The units are the
 * engine dispatches a campaign may buy.
 */
export interface Budget {
  readonly limit: number;
  readonly spent: number;
  readonly remaining: number;
  /** Charges the envelope, or refuses the step. */
  spend(units: number, reason: string): void;
}

/** Creates a budget envelope with the given number of units. */
export function createBudget(limit: number): Budget {
  let spent = 0;
  return {
    get limit(): number {
      return limit;
    },
    get spent(): number {
      return spent;
    },
    get remaining(): number {
      return limit - spent;
    },
    spend(units: number, reason: string): void {
      if (!Number.isInteger(units) || units <= 0) {
        throw new Error(
          `budget: ${reason} costs ${units} unit(s), which is not a positive number of units`,
        );
      }
      if (spent + units > limit) {
        throw new Error(
          `budget exhausted: ${reason} needs ${units} unit(s), ${limit - spent} left`,
        );
      }
      spent += units;
    },
  };
}

/** The canvas of a hero banner. */
const HERO_WIDTH = 1200;
const HERO_HEIGHT = 628;
const HERO_FILE = "hero.png";

/** The palette the studio falls back to when retrieval finds nothing. */
const DEFAULT_ACCENT = "#f59e0b";
const DEFAULT_BACKGROUND = "#ffffff";

/**
 * Runs one campaign: embed the brief, retrieve an exemplar, compose
 * the copy, render the banner, and record what happened.
 */
export async function runStudioOnce(
  brief: StudioBrief,
  deps: StudioDeps,
): Promise<StudioRunResult> {
  const { env, store, embed, render } = deps;
  const now = deps.now ?? (() => new Date().toISOString());
  const budget = createBudget(env.budgetUnits);
  const journal: JournalEntry[] = [];

  const record = (name: string, detail: string): void => {
    journal.push({ step: journal.length + 1, name, detail, at: now() });
  };

  // The run is addressed by its content: the same brief always renders
  // to the same file, and a replay overwrites it instead of piling up
  // near-identical artefacts.
  const runId = computeRunId(brief);
  const outDir = join(env.workDir, "campaigns", runId);
  mkdirSync(outDir, { recursive: true });

  // 1. Embed the brief. The model is injected, and the guard checks
  //    the width against the column before anything is stored.
  const embedding = await embedBrief(
    briefToPrompt(brief),
    embed,
    env.embeddingDim,
  );
  record("embed", `${embedding.length} dimensions`);

  // 2. Retrieve the exemplar the copy will be grounded in.
  const neighbours = await findSimilarBrandAssets(
    store,
    embedding,
    MATCH_THRESHOLD,
    MATCH_COUNT,
  );
  const exemplar = neighbours[0] ?? null;
  record(
    "retrieve",
    exemplar === null
      ? "no exemplar cleared the threshold"
      : `${exemplar.id} at ${exemplar.similarity.toFixed(3)}`,
  );

  // 3. Compose the copy and the palette. Every value has a fallback,
  //    so a brief the brand has never seen still produces a banner.
  const headline = exemplar?.headline ?? brief.product;
  const subhead = exemplar?.cta ?? brief.callToAction;
  const accent = exemplar?.palette[1] ?? DEFAULT_ACCENT;
  const background = exemplar?.palette[0] ?? DEFAULT_BACKGROUND;
  record("compose", `${headline} / ${subhead}`);

  // 4. Pay for the render before the engine is spawned.
  budget.spend(HERO_RENDER_COST, "hero banner render");
  const rendered = await render({
    width: HERO_WIDTH,
    height: HERO_HEIGHT,
    headline,
    subhead,
    background,
    accent,
    outDir,
    outFile: HERO_FILE,
  });
  record(
    "render",
    `${rendered.calls.length} engine call(s) → ${rendered.relativePath}`,
  );

  // 5. The post-materialization guardrail: the engine said it wrote a
  //    file, so a file must be there and it must not be empty.
  const size = statSync(rendered.path).size;
  if (size === 0) {
    throw new Error(
      `studio: the engine wrote an empty artefact at ${rendered.path}`,
    );
  }
  record("materialise", `${rendered.relativePath}, ${size} bytes`);

  // 6. Write the trace.
  const journalPath = join(env.workDir, "runs", `${runId}.jsonl`);
  writeJournal(journalPath, journal);

  return {
    runId,
    assetPath: rendered.path,
    headline,
    subhead,
    exemplarId: exemplar?.id ?? null,
    exemplarSimilarity: exemplar?.similarity ?? null,
    warnings: rendered.warnings,
    journal,
    budget: {
      limit: budget.limit,
      spent: budget.spent,
      remaining: budget.remaining,
    },
  };
}

/**
 * The canonical text of a brief. This is the string that gets
 * embedded, and the embedding is what the whole retrieval quality
 * hangs on, so it is built in one place and nowhere else.
 */
export function briefToPrompt(brief: StudioBrief): string {
  return [
    `Product: ${brief.product}`,
    `Audience: ${brief.audience}`,
    `Tone: ${brief.tone}`,
    `Call to action: ${brief.callToAction}`,
  ].join("\n");
}

/** The id of a run: the first twelve hex digits of the brief's hash. */
function computeRunId(brief: StudioBrief): string {
  return createHash("sha256")
    .update(briefToPrompt(brief))
    .digest("hex")
    .slice(0, 12);
}

/** Writes the trace, one JSON document per line. */
function writeJournal(
  path: string,
  entries: readonly JournalEntry[],
): void {
  mkdirSync(dirname(path), { recursive: true });
  const lines = entries.map((entry) => JSON.stringify(entry)).join("\n");
  writeFileSync(path, `${lines}\n`, "utf8");
}
