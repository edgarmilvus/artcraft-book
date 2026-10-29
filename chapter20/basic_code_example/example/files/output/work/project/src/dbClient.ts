/**
 * The runtime half of the brand memory.
 *
 * `supabase/migrations/0001_brand_assets.sql` is the production schema:
 * a `vector(1536)` column, an HNSW index over `vector_cosine_ops`, and
 * the `match_brand_assets` RPC. This module is the adapter that keeps
 * the same rows — id, brief, headline, cta, palette, embedding,
 * created_at — and answers the same "nearest neighbours by cosine
 * distance" question with a brute-force scan over `node:sqlite`, the
 * database engine that ships inside Node and needs no server, no
 * container and no connection string.
 *
 * The interface is the contract; the adapter is an implementation
 * detail. Moving back to the hosted store means implementing
 * `BrandStore` against PostgREST — the callers do not change.
 */
import { DatabaseSync, type SQLOutputValue } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** One row of the brand-memory table. */
export interface BrandAsset {
  readonly id: string;
  readonly brief: string;
  readonly headline: string;
  readonly cta: string;
  readonly palette: readonly string[];
  readonly embedding: readonly number[];
  readonly createdAt: string;
}

/** A row the retrieval returned, with its similarity score. */
export interface BrandAssetMatch {
  readonly id: string;
  readonly brief: string;
  readonly headline: string;
  readonly cta: string;
  readonly palette: readonly string[];
  readonly similarity: number;
}

/** The row the store accepts; the embedding is already computed. */
export interface BrandAssetInput {
  readonly id: string;
  readonly brief: string;
  readonly headline: string;
  readonly cta: string;
  readonly palette: readonly string[];
  readonly embedding: readonly number[];
}

/** The arguments of the nearest-neighbour query. */
export interface MatchOptions {
  /** Minimum similarity, mirroring `match_threshold` in the RPC. */
  readonly threshold: number;
  /** Maximum number of rows, mirroring `match_count` in the RPC. */
  readonly count: number;
}

/** The contract the rest of the studio programs against. */
export interface BrandStore {
  /**
   * Stores one asset. An id that is already present is left untouched,
   * which makes seeding the corpus idempotent.
   */
  insert(asset: BrandAssetInput): BrandAsset;
  /** The nearest neighbours of a query vector, best match first. */
  match(
    queryEmbedding: readonly number[],
    options: MatchOptions,
  ): BrandAssetMatch[];
  /** How many rows the store holds. */
  count(): number;
  /** Releases the underlying handle. */
  close(): void;
}

/** How a store is opened. */
export interface BrandStoreOptions {
  /** The SQLite file the rows live in. */
  readonly file: string;
  /** The width of the embedding column; every vector must match it. */
  readonly dim: number;
  /**
   * The clock that stamps `created_at`. It is injected so a replay of
   * the same campaign produces the same bytes on disk.
   */
  readonly now?: () => string;
}

/**
 * The local schema. It carries the same columns as the production
 * table; only the column types change, because SQLite has no `vector`,
 * `jsonb` or `uuid` type. The embedding is kept as a JSON array of
 * numbers — the production column keeps the same numbers in binary.
 */
const LOCAL_SCHEMA = `
create table if not exists brand_assets (
  id          text primary key,
  brief       text not null,
  headline    text not null,
  cta         text not null,
  palette     text not null,
  embedding   text not null,
  created_at  text not null
);
`;

/** Opens the durable store: a single SQLite file under the work root. */
export function openBrandStore(options: BrandStoreOptions): BrandStore {
  const { file, dim } = options;
  const now = options.now ?? (() => new Date().toISOString());

  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec(LOCAL_SCHEMA);

  const insertStatement = db.prepare(
    `insert or ignore into brand_assets
       (id, brief, headline, cta, palette, embedding, created_at)
     values (?, ?, ?, ?, ?, ?, ?)`,
  );
  const selectStatement = db.prepare(
    `select id, brief, headline, cta, palette, embedding, created_at
       from brand_assets`,
  );
  const getStatement = db.prepare(
    `select id, brief, headline, cta, palette, embedding, created_at
       from brand_assets where id = ?`,
  );

  return {
    insert(asset: BrandAssetInput): BrandAsset {
      assertWidth(asset.embedding.length, dim, asset.id);
      const createdAt = now();
      insertStatement.run(
        asset.id,
        asset.brief,
        asset.headline,
        asset.cta,
        JSON.stringify(asset.palette),
        JSON.stringify(asset.embedding),
        createdAt,
      );
      const stored = getStatement.get(asset.id);
      if (stored === undefined) {
        throw new Error(`brand store: ${asset.id} did not reach the table`);
      }
      return rowToAsset(stored);
    },

    match(
      queryEmbedding: readonly number[],
      matchOptions: MatchOptions,
    ): BrandAssetMatch[] {
      assertWidth(queryEmbedding.length, dim, "query");
      const rows = selectStatement.all().map(rowToAsset);
      return score(rows, queryEmbedding, matchOptions);
    },

    count(): number {
      const row = db.prepare("select count(*) as n from brand_assets").get();
      return readNumber(row?.["n"]);
    },

    close(): void {
      db.close();
    },
  };
}

/**
 * The in-memory store. It answers exactly the same questions as the
 * durable one, which is what lets the pipeline be tested without a
 * database file and without the network.
 */
export function createInMemoryBrandStore(
  options: BrandStoreOptions,
): BrandStore {
  const { dim } = options;
  const now = options.now ?? (() => new Date().toISOString());
  const rows = new Map<string, BrandAsset>();

  return {
    insert(asset: BrandAssetInput): BrandAsset {
      assertWidth(asset.embedding.length, dim, asset.id);
      const existing = rows.get(asset.id);
      if (existing !== undefined) {
        return existing;
      }
      const stored: BrandAsset = {
        id: asset.id,
        brief: asset.brief,
        headline: asset.headline,
        cta: asset.cta,
        palette: asset.palette,
        embedding: asset.embedding,
        createdAt: now(),
      };
      rows.set(asset.id, stored);
      return stored;
    },

    match(
      queryEmbedding: readonly number[],
      matchOptions: MatchOptions,
    ): BrandAssetMatch[] {
      assertWidth(queryEmbedding.length, dim, "query");
      return score([...rows.values()], queryEmbedding, matchOptions);
    },

    count(): number {
      return rows.size;
    },

    close(): void {
      rows.clear();
    },
  };
}

/**
 * The nearest-neighbour query, in the order the RPC returns it: keep
 * the rows whose similarity clears the threshold, order them by
 * similarity, and cut the list at the requested count.
 *
 * The production implementation lets Postgres do this with an HNSW
 * index, so the scan stays sub-linear over a million rows. Here the
 * scan is linear — the corpus is small, and the contract is the same.
 */
function score(
  rows: readonly BrandAsset[],
  queryEmbedding: readonly number[],
  options: MatchOptions,
): BrandAssetMatch[] {
  return rows
    .map((row) => ({ row, similarity: cosineSimilarity(queryEmbedding, row.embedding) }))
    .filter((scored) => scored.similarity > options.threshold)
    .sort((left, right) => right.similarity - left.similarity)
    .slice(0, options.count)
    .map((scored) => ({
      id: scored.row.id,
      brief: scored.row.brief,
      headline: scored.row.headline,
      cta: scored.row.cta,
      palette: scored.row.palette,
      similarity: scored.similarity,
    }));
}

/**
 * Cosine similarity, the metric the `vector_cosine_ops` index and the
 * `<=>` operator of the production schema use. The value runs from
 * -1 (opposite) through 0 (orthogonal) to 1 (identical).
 */
export function cosineSimilarity(
  left: readonly number[],
  right: readonly number[],
): number {
  if (left.length !== right.length) {
    throw new Error(
      `brand store: embedding width mismatch, ${left.length} against ${right.length}`,
    );
  }
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < left.length; index += 1) {
    const x = left[index] ?? 0;
    const y = right[index] ?? 0;
    dot += x * y;
    leftNorm += x * x;
    rightNorm += y * y;
  }
  if (leftNorm === 0 || rightNorm === 0) {
    return 0;
  }
  return dot / Math.sqrt(leftNorm * rightNorm);
}

/** Reads one row of the local table back into the domain shape. */
function rowToAsset(row: Record<string, SQLOutputValue>): BrandAsset {
  return {
    id: readString(row["id"]),
    brief: readString(row["brief"]),
    headline: readString(row["headline"]),
    cta: readString(row["cta"]),
    palette: readPalette(row["palette"]),
    embedding: readEmbedding(row["embedding"]),
    createdAt: readString(row["created_at"]),
  };
}

function readString(value: SQLOutputValue | undefined): string {
  if (typeof value === "string") {
    return value;
  }
  throw new Error(`brand store: expected a text column, got ${typeof value}`);
}

function readNumber(value: SQLOutputValue | undefined): number {
  if (typeof value === "number") {
    return value;
  }
  throw new Error(`brand store: expected a numeric column, got ${typeof value}`);
}

function readPalette(value: SQLOutputValue | undefined): readonly string[] {
  const parsed: unknown = JSON.parse(readString(value));
  if (!Array.isArray(parsed)) {
    throw new Error("brand store: the palette column is not an array");
  }
  return parsed.filter((entry): entry is string => typeof entry === "string");
}

function readEmbedding(value: SQLOutputValue | undefined): readonly number[] {
  const parsed: unknown = JSON.parse(readString(value));
  if (!Array.isArray(parsed)) {
    throw new Error("brand store: the embedding column is not an array");
  }
  return parsed.filter((entry): entry is number => typeof entry === "number");
}

/** The dimension guard, at the only place that knows the column width. */
function assertWidth(width: number, dim: number, what: string): void {
  if (width !== dim) {
    throw new Error(
      `brand store: ${what} carries ${width} dimensions, the column holds ${dim}`,
    );
  }
}
