/**
 * The vector-memory module: it owns the embedding model and the query
 * that turns a fresh brief into a grounded, on-brand headline.
 *
 * The embedding model is injected. The production model is OpenAI's
 * `text-embedding-3-small`, which returns 1536 dimensions — the exact
 * width of the `vector(1536)` column in
 * `supabase/migrations/0001_brand_assets.sql`; a vector of any other
 * width is refused by the database, and the hosted store refuses it
 * here first. The implementation below is a deterministic,
 * dependency-free embedder with the same contract, so the studio runs
 * offline and every run is repeatable to the byte.
 *
 * The production implementation of an injected model is one HTTP call:
 *
 *     const res = await fetch("https://api.openai.com/v1/embeddings", {
 *       method: "POST",
 *       headers: {
 *         "Content-Type": "application/json",
 *         Authorization: `Bearer ${apiKey}`,
 *       },
 *       body: JSON.stringify({
 *         model: "text-embedding-3-small",
 *         input: text,
 *         dimensions: 1536,
 *       }),
 *     });
 *     const json = (await res.json()) as { data: { embedding: number[] }[] };
 *     return json.data[0]?.embedding ?? [];
 */
import type { BrandAssetMatch, BrandStore } from "./dbClient.js";

/**
 * The embedding contract: text in, one vector out. Everything else in
 * the studio is written against this type, so swapping the hosted model
 * for a local one touches nothing but the composition root.
 */
export type EmbeddingModel = (text: string) => Promise<number[]>;

/** The width of the embedding column, and of every vector in it. */
export const EMBEDDING_DIM = 1536;

/** The similarity a row must clear to be considered a match. */
export const MATCH_THRESHOLD = 0.72;

/** How many rows the retrieval asks for. */
export const MATCH_COUNT = 3;

/**
 * A row of the brand-memory corpus, before its embedding is computed.
 */
export interface BrandAssetSeed {
  readonly id: string;
  readonly brief: string;
  readonly headline: string;
  readonly cta: string;
  readonly palette: readonly string[];
}

/**
 * The corpus the studio starts from: three campaigns the brand has
 * already run. `brand-001` is the previous run of the brief in
 * `src/main.ts`, so the retrieval finds it and the new banner inherits
 * the headline the brand already approved. The other two campaigns
 * belong to other products and other audiences; they are in the corpus
 * so the threshold has something to exclude.
 */
export const EXAMPLE_BRAND_ASSETS: readonly BrandAssetSeed[] = [
  {
    id: "brand-001",
    brief: [
      "Product: ArtCraft Suite",
      "Audience: indie game studios",
      "Tone: confident, technical",
      "Call to action: Start the free trial",
    ].join("\n"),
    headline: "Ship faster",
    cta: "Try it now",
    palette: ["#ffffff", "#f59e0b"],
  },
  {
    id: "brand-002",
    brief: [
      "Product: ArtCraft Suite",
      "Audience: motion designers",
      "Tone: playful",
      "Call to action: Try it now",
    ].join("\n"),
    headline: "Every cut, frame-perfect",
    cta: "See the timeline",
    palette: ["#0f172a", "#38bdf8"],
  },
  {
    id: "brand-003",
    brief: [
      "Product: VectorCraft",
      "Audience: brand teams",
      "Tone: precise",
      "Call to action: Start the free trial",
    ].join("\n"),
    headline: "Draw the system, not the picture",
    cta: "Start the free trial",
    palette: ["#ffffff", "#ef4444"],
  },
];

/**
 * The deterministic embedder: text is lower-cased, split into words,
 * and every word is hashed into one bucket of a fixed-width vector with
 * a signed feature. Words that share a bucket cancel instead of
 * reinforcing one another, and the vector is scaled to unit length, so
 * the cosine similarity of two briefs is the share of words they have
 * in common.
 */
export function createLocalEmbedder(
  dim: number = EMBEDDING_DIM,
): EmbeddingModel {
  return async (text: string): Promise<number[]> => embedLocally(text, dim);
}

/**
 * The dimension guard. The store refuses a vector of the wrong width,
 * and so does the hosted column; catching it here turns a confusing
 * database error into a stack trace that points at the call site.
 */
export async function embedBrief(
  text: string,
  model: EmbeddingModel,
  expectedDim: number = EMBEDDING_DIM,
): Promise<number[]> {
  const embedding = await model(text);
  if (embedding.length !== expectedDim) {
    throw new Error(
      `embedBrief: expected ${expectedDim} dimensions, got ${embedding.length}`,
    );
  }
  return embedding;
}

/**
 * The retrieval: the nearest neighbours of the brief's vector, best
 * match first. The hosted store answers it with the
 * `match_brand_assets` RPC; the local store answers it with a scan.
 * The arguments and the ordering are the same.
 */
export async function findSimilarBrandAssets(
  store: BrandStore,
  embedding: readonly number[],
  matchThreshold: number = MATCH_THRESHOLD,
  matchCount: number = MATCH_COUNT,
): Promise<BrandAssetMatch[]> {
  return store.match(embedding, {
    threshold: matchThreshold,
    count: matchCount,
  });
}

/**
 * Loads the corpus into the store. The embedding of every row is
 * computed with the injected model, so the same corpus and the same
 * model always produce the same vectors.
 */
export async function seedBrandMemory(
  store: BrandStore,
  assets: readonly BrandAssetSeed[],
  model: EmbeddingModel,
): Promise<number> {
  const before = store.count();
  for (const asset of assets) {
    const embedding = await embedBrief(asset.brief, model);
    store.insert({
      id: asset.id,
      brief: asset.brief,
      headline: asset.headline,
      cta: asset.cta,
      palette: asset.palette,
      embedding,
    });
  }
  return store.count() - before;
}

/** Hashes the words of a text into a unit-length vector. */
function embedLocally(text: string, dim: number): number[] {
  const vector = new Array<number>(dim).fill(0);
  for (const word of words(text)) {
    const bucket = fnv1a(word) % dim;
    const sign = (fnv1a(`${word}#salt`) & 1) === 0 ? -1 : 1;
    vector[bucket] = (vector[bucket] ?? 0) + sign;
  }
  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));
  if (norm === 0) {
    return vector;
  }
  return vector.map((value) => value / norm);
}

/** Lower-cases a text and splits it into words. */
function words(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length > 0);
}

/** The 32-bit FNV-1a hash, the cheapest good hash there is. */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}
