// ---------------------------------------------------------------------------
// @file creative-factory/asset-store.ts
//
// Vector-store Upsert. Each finished asset emits one record keyed by a stable
// Vector ID derived from (tenantId, campaignId, assetRevision). Because the
// pipeline is deterministic, re-running with an unchanged brief produces the
// same Vector ID, which the store interprets as an Upsert (update-or-insert):
// the metadata is refreshed, the embedding does not need recomputation.
// ---------------------------------------------------------------------------

import { createHash } from "node:crypto";

export interface AssetRecord {
  vectorId: string;          // deterministic primary key
  tenantId: string;
  campaignId: string;
  locale: string;
  engineVersion: string;
  /** The command journal, as an append-only list of (id, params). */
  journal: Array<{ id: string; params: unknown }>;
  /** The reconciliation report from the DualCompositor. */
  reconciliation: { converged: boolean; hashAligned: boolean; rmse: number[] };
  /** Path to the signed export on the object store. */
  exportPath: string;
  /** Path to the accelerated preview. */
  previewPath: string;
  embedding: number[];       // produced by the vision model
}

export interface VectorStoreClient {
  upsert(records: AssetRecord[]): Promise<{ upserted: number }>;
}

/**
 * Derive a stable Vector ID. Note that we hash *only* the inputs the pipeline
 * actually consumes: brief, engine version, worker registration order. Change
 * any of them and you legitimately get a new asset; change nothing and you
 * get the same asset, re-upserted.
 */
export function deriveVectorId(
  brief: object,
  engineVersion: string,
  workerOrder: string[],
): string {
  const h = createHash("sha256");
  h.update(stableStringify(brief));
  h.update("\u0000");
  h.update(engineVersion);
  h.update("\u0000");
  h.update(workerOrder.join("|"));
  return h.digest("hex").slice(0, 32);
}

/**
 * Stable JSON: object keys sorted at *every* level.
 *
 * `JSON.stringify(value, Object.keys(value).sort())` is not equivalent: the
 * replacer array applies to all nesting levels, so every nested key that is
 * not also a top-level key is silently dropped. The digest would then be blind
 * to the headline, the colourway, and most of the brief.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys
    .map((key) => `${JSON.stringify(key)}:${stableStringify(obj[key])}`)
    .join(",")}}`;
}
