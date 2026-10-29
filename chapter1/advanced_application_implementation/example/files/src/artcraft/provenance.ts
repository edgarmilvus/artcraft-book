// ═══════════════════════════════════════════════════════════════════════════
// FILE 4/9 — src/artcraft/provenance.ts
// Provenance ledger: hashing, sidecar records, in-document notes,
// snapshots, and in-engine asset drift detection.
// ═══════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { ArtCraftEngine } from './engine-session.js';
import {
  recipeDigest,
  stableStringify,
  type JsonObject,
  type JsonValue,
  type LayeredRecipe,
  type SourceAsset,
} from './recipe.js';

/** One executed phase, recorded for the post-mortem and the audit trail. */
export interface PhaseRecord {
  phase: string;
  steps: number;
  completed: number;
  failed: number;
  ms: number;
  error?: string;
}

/** The complete provenance record for one forge run. */
export interface ProvenanceRecord {
  schema: 'artcraft.provenance/v1';
  jobId: string;
  recipeId: string;
  recipeDigest: string;
  recipePath: string;
  engine: { app: string; binary: string; commands: number };
  createdAt: string;
  finishedAt: string;
  assets: Array<{
    id: string;
    path: string;
    sha256: string;
    bytes: number;
    linkStatus: 'ok' | 'modified' | 'missing' | 'embedded';
    effectivePpi?: [number, number];
  }>;
  phases: PhaseRecord[];
  audit: Array<{ round: number; verdict: string; changes: JsonObject }>;
  deliverables: Array<{ id: string; path: string; sha256?: string; format: string }>;
  masterPath: string;
}

/** Compute the content hash of a file. */
export async function hashFile(path: string): Promise<{ sha256: string; bytes: number }> {
  const buf = await readFile(path);
  return {
    sha256: createHash('sha256').update(buf).digest('hex'),
    bytes: buf.byteLength,
  };
}

/** Write the ledger and return its own digest for chaining. */
export async function writeLedger(
  path: string,
  record: ProvenanceRecord,
): Promise<{ path: string; sha256: string }> {
  const serialised = stableStringify(record as unknown as JsonValue);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, serialised, 'utf8');
  return { path, sha256: createHash('sha256').update(serialised).digest('hex') };
}

/**
 * Embed a compact provenance note *inside* the document.
 *
 * Why duplicate data? Because the file outlives the database. A note is
 * visible to a human, survives format conversion, and gives an agent a
 * deterministic anchor to grep for on a later inspection pass.
 */
export async function stampDocumentNote(
  engine: ArtCraftEngine,
  recipe: LayeredRecipe,
  digest: string,
  recipePath: string,
): Promise<void> {
  const text = [
    '── artcraft.provenance/v1 ──',
    `recipe:  ${recipe.id} (${recipe.schema})`,
    `digest:  ${digest}`,
    `path:    ${recipePath}`,
    `canvas:  ${recipe.canvas.width}×${recipe.canvas.height} ${recipe.canvas.mode}/${recipe.canvas.depth}`,
    `stack:   ${recipe.stack.length} top-level node(s)`,
    `sources: ${recipe.sources.length} asset(s); all hashed in provenance.json`,
    'This document is a rendered artifact of the recipe above.',
    'Rebuild it; do not repair it by hand.',
  ].join('\n');

  await engine.runCommand('notes.add', {
    x: 24,
    y: 24,
    text,
    author: 'layered-forge',
    color: '#f2e08a',
    open: false,
  });
}

/** Pin the approved state inside the session history. */
export async function snapshotApproved(
  engine: ArtCraftEngine,
  label: string,
): Promise<void> {
  await engine.runCommand('history.newSnapshot', {
    name: label,
    from: 'fullDocument',
  });
}

/**
 * Verify that the source assets on disk are still the bytes we imported.
 *
 * PhotoCraft exposes **no** Links-panel inspection command (there is no
 * `links.check`, no preflight, no `file.info`), so this cannot ask the engine
 * for a link report. Instead it re-hashes each asset from the read root and
 * cross-checks the live document tree for the smart object that holds it:
 *
 *   ok        file on disk matches the recorded sha256 and the layer is present
 *   modified  the bytes changed since intake
 *   embedded  the layer is in the document but the file is gone
 *   missing   the file is gone and nothing in the document holds it
 */
export async function verifyAssetIntegrity(
  engine: ArtCraftEngine,
  assets: SourceAsset[],
  resolvePath: (relative: string) => string,
): Promise<Array<{ id: string; status: 'ok' | 'modified' | 'missing' | 'embedded' }>> {
  const tree = await engine.inspect();
  const names = new Set<string>();
  collectLayerNames(tree, names);

  const out: Array<{ id: string; status: 'ok' | 'modified' | 'missing' | 'embedded' }> = [];
  for (const asset of assets) {
    const base = asset.path.split('/').pop() ?? asset.path;
    const stem = base.replace(/\.[^.]+$/, '');
    const present = [...names].some((n) => n === stem || n === base || n.endsWith(`/${stem}`));

    let actual: { sha256: string } | null = null;
    try {
      actual = await hashFile(resolvePath(asset.path));
    } catch {
      actual = null;
    }

    const status =
      actual === null ? (present ? 'embedded' : 'missing')
        : asset.sha256 && actual.sha256 !== asset.sha256 ? 'modified'
          : 'ok';
    out.push({ id: asset.id, status });
  }
  return out;
}

/** Collect every layer name in an inspect payload. */
function collectLayerNames(node: unknown, out: Set<string>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { node.forEach((child) => collectLayerNames(child, out)); return; }
  const obj = node as Record<string, unknown>;
  if (typeof obj.name === 'string') out.add(obj.name);
  for (const key of ['layers', 'children', 'nodes', 'groups', 'items']) {
    if (obj[key]) collectLayerNames(obj[key], out);
  }
}

/** Raised when a source asset is no longer the approved bytes. */
export class ProvenanceDriftError extends Error {
  constructor(readonly drift: Array<{ id: string; status: string }>) {
    super(
      `source assets drifted since intake: ${drift.map((d) => `${d.id}=${d.status}`).join(', ')}`,
    );
    this.name = 'ProvenanceDriftError';
  }
}

/**
 * NOTE — there is no `links.info` either.
 *
 * PhotoCraft exposes no Links-panel surface at all: `photocraft-cli commands
 * --filter links` returns an empty list, so both `links.check` and `links.info`
 * are inventions. An earlier revision of this module called `links.info` to
 * read a placed asset's effective PPI; that call always failed. Effective PPI
 * is instead derivable from the recipe (source pixel width) and the placed
 * rectangle (points), and is computed where the preflight needs it — see
 * `audit.ts` — rather than asked of the engine.
 */

export function ledgerPath(outDir: string, jobId: string): string {
  return join(outDir, `${jobId}.provenance.json`);
}
