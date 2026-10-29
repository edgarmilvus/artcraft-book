// The query contract of the cross-suite provenance ledger.
//
// The auditor's question is always the same: given the content hash of the
// original raw, and optionally the page that carries the pixels, return the
// ordered hops that produced it. The contract is deliberately small — one
// function, two arguments — because it is the only surface the compliance
// bot is allowed to use.

/** The engines that can appear in the ledger, as the schema constrains it. */
export type CraftApp =
  | "lightcraft"
  | "photocraft"
  | "designcraft"
  | "filmcraft"
  | "effectcraft"
  | "pdfcraft"
  | "vectorcraft";

/** The studio client that made the call, as the launcher tags it. */
export type Ide = "cursor" | "claude-code" | "opencode";

/** One hop of the chain, as the auditor reads it. */
export type ProvenanceHop = {
  eventId: string;
  parentEventId: string | null;
  app: CraftApp;
  toolCall: string;
  resultDigest: string;
  timestamp: string;
  ide: Ide;
};

/**
 * The contract itself.
 *
 * `assetRootId` is the content hash of the original raw; every hop of that
 * asset is filed under it. `pageHint` narrows the answer to the hops that
 * touch one page — the hops that touch no page (the grade, the export, the
 * archive) are always part of the answer, because they are what the page
 * was made of.
 *
 * The shim's `Ledger` class implements this contract: its
 * `traceProvenance` is the function below, over the SQLite ledger the shim
 * writes.
 */
export interface ProvenanceQuery {
  traceProvenance(
    assetRootId: string,
    pageHint?: number,
  ): Promise<ProvenanceHop[]>;
}
