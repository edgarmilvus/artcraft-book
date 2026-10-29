/**
 * common-pitfalls.ts — the batch loop, and the three ways to get it wrong.
 * ---------------------------------------------------------------------------
 * The single-banner renderer is the easy half; the batch is where a factory
 * falls over. Three mistakes are worth naming, because each of them is a
 * one-line change with a large blast radius:
 *
 *   1. **One engine session for the whole batch.** Spawning a
 *      `photocraft-cli` process per product costs a handshake and a process
 *      per banner; a factory that renders 5 000 a day dies on process churn.
 *      The renderer owns its session, so the batch renderer owns the
 *      session and passes it down.
 *   2. **A shared output directory with predictable names.** The slug comes
 *      from the product name, so two products that normalise to the same
 *      slug overwrite each other. The suffix is part of the contract.
 *   3. **A rejected product stops the batch.** One malformed feed row must
 *      not take the other 4 999 down with it: the failure is recorded and
 *      the loop continues.
 *
 * The loop below is the corrected shape: one session, deterministic names,
 * and per-record error handling.
 */

import { renderBanner } from "./01_banner-factory.js";

/** The outcome of one product in the batch. */
export interface BatchResult {
  /** The product's name, when it could be read at all. */
  name: string;
  /** The written file, when the product rendered. */
  path: string | null;
  /** The failure, when the product did not render. */
  error: string | null;
}

/**
 * Render a batch of products, one file per product.
 *
 * @param products The raw feed records, unvalidated.
 * @param outDir   The absolute directory the PNGs land in.
 * @param readRoot The directory the source images live in; it is the
 *                 engine's read root, so a product cannot point at a file
 *                 outside the staging area.
 */
export async function renderBatch(
  products: unknown[],
  outDir: string,
  readRoot: string,
): Promise<BatchResult[]> {
  const results: BatchResult[] = [];
  for (const product of products) {
    const name = (product as { name?: unknown })?.name;
    try {
      const path = await renderBanner(product, outDir, readRoot);
      results.push({ name: typeof name === "string" ? name : "(unnamed)", path, error: null });
    } catch (error) {
      // A malformed record is recorded and the batch continues: one bad row
      // must not take the catalogue down.
      results.push({
        name: typeof name === "string" ? name : "(unnamed)",
        path: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}
