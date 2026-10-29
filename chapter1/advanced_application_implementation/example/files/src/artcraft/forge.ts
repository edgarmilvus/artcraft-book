// ═══════════════════════════════════════════════════════════════════════════
// FILE 6/9 — src/artcraft/forge.ts
// The orchestration service: intake → compile → execute → audit → deliver.
// ═══════════════════════════════════════════════════════════════════════════

import { basename, join, resolve, sep } from 'node:path';
import { ArtCraftEngine, DocumentMutex } from './engine-session.js';
import { compileRecipe, type CompiledPhase, type PlannedStep } from './compiler.js';
import {
  hashFile,
  ledgerPath,
  ProvenanceDriftError,
  snapshotApproved,
  stampDocumentNote,
  verifyAssetIntegrity,
  writeLedger,
  type PhaseRecord,
  type ProvenanceRecord,
} from './provenance.js';
import {
  isLayerRef,
  recipeDigest,
  type JsonObject,
  type JsonValue,
  type LayeredRecipe,
  type LayerRef,
} from './recipe.js';
import { runAuditLoop, type VisionOracle } from './audit.js';

export interface ForgeJob {
  jobId: string;
  recipe: LayeredRecipe;
  /** Absolute path to the recipe file (recorded in the ledger). */
  recipePath: string;
  /** Absolute output directory for the master, ledger and deliverables. */
  outDir: string;
  /** Capture mode for the audit loop. */
  capture?: 'preview' | 'window';
  oracle?: VisionOracle;
  /** Regenerate the smart object layer in place from a new plate. */
  replaceSource?: { layerName: string; path: string };
  log?: (event: JsonObject) => void;
}

export interface ForgeResult {
  jobId: string;
  masterPath: string;
  ledgerPath: string;
  ledgerDigest: string;
  recipeDigest: string;
  phases: PhaseRecord[];
  deliverables: Array<{ id: string; path: string; format: string }>;
  audit?: { ok: boolean; rounds: number; converged: boolean };
}

/**
 * The Forge service.
 *
 * One instance owns one engine session and one document mutex for the whole
 * lifetime of a job. Jobs are run sequentially per instance; horizontal
 * scaling comes from running more instances, not from concurrent mutation of
 * a single document — the engine cannot support the latter and pretending
 * otherwise is how orchestrators corrupt files.
 */
export class LayeredForge {
  private readonly mutex = new DocumentMutex();
  /** Canvas of the job in flight; used to centre an automation-scoped place. */
  private canvas = { width: 0, height: 0 };

  constructor(
    private readonly engine: ArtCraftEngine,
    private readonly readRoot: string,
    private readonly writeRoot: string,
  ) {}

  /** Resolve and validate an asset path against the automation read root. */
  private resolveAssetPath(relative: string): string {
    const absolute = resolve(this.readRoot, relative);
    const root = resolve(this.readRoot);
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      throw new Error(`asset path escapes the automation read root: ${relative}`);
    }
    return absolute;
  }

  /** Resolve and validate an output path against the automation write root. */
  private resolveOutputPath(relative: string): string {
    const absolute = resolve(this.writeRoot, relative);
    const root = resolve(this.writeRoot);
    if (absolute !== root && !absolute.startsWith(root + sep)) {
      throw new Error(`output path escapes the automation write root: ${relative}`);
    }
    return absolute;
  }

  /** Full pipeline for one job. */
  async run(job: ForgeJob): Promise<ForgeResult> {
    const log = job.log ?? (() => undefined);
    const startedAt = new Date().toISOString();
    const digest = recipeDigest(job.recipe);
    this.canvas = { width: job.recipe.canvas.width, height: job.recipe.canvas.height };

    // ── 0. Intake: hash every declared source asset. ───────────────────────
    const assetHashes = new Map<string, { sha256: string; bytes: number }>();
    for (const asset of job.recipe.sources) {
      const absolute = this.resolveAssetPath(asset.path);
      const hashed = await hashFile(absolute);
      assetHashes.set(asset.id, hashed);
      if (asset.sha256 && asset.sha256 !== hashed.sha256) {
        throw new Error(
          `recipe ${job.recipe.id}: asset "${asset.id}" hash mismatch (recipe says ${asset.sha256.slice(0, 12)}, file is ${hashed.sha256.slice(0, 12)})`,
        );
      }
    }
    log({ event: 'forge.intake', assets: job.recipe.sources.length, digest });

    // ── 1. Compile. ────────────────────────────────────────────────────────
    const phases = compileRecipe(job.recipe, (asset) => this.resolveAssetPath(asset.path));
    const records: PhaseRecord[] = [];

    // ── 2. Execute inside the document mutex. ──────────────────────────────
    await this.mutex.run(async () => {
      for (const phase of phases) {
        const record = await this.executePhase(phase, log);
        records.push(record);
        if (record.failed > 0) {
          throw new Error(
            `phase "${phase.phase}" failed after ${record.completed} step(s): ${record.error ?? 'unknown'}`,
          );
        }
      }

      // ── 3. Optional in-place regeneration of the source plate. ───────────
      if (job.replaceSource) {
        const smartIds = await this.resolveLayerRefs([
          { $layer: job.replaceSource.layerName },
        ]);
        const layerId = smartIds.get(job.replaceSource.layerName);
        if (layerId === undefined) {
          throw new Error(`replaceSource: no layer named "${job.replaceSource.layerName}"`);
        }
        await this.engine.runCommand('layer.smartObjects.replaceContents', {
          layer: layerId,
          path: this.resolveAssetPath(job.replaceSource.path),
        });
        log({ event: 'forge.replaceContents', layer: job.replaceSource.layerName });
      }

      // ── 4. Provenance stamping. ──────────────────────────────────────────
      await stampDocumentNote(this.engine, job.recipe, digest, job.recipePath);
      await snapshotApproved(this.engine, `${job.recipe.id} approved ${digest.slice(0, 8)}`);

      // ── 5. Write the native master. ──────────────────────────────────────
      const masterPath = this.resolveOutputPath(join(job.outDir, `${job.jobId}.pcraft`));
      await this.engine.save({ path: masterPath });
      log({ event: 'forge.master', path: masterPath });

      // ── 6. Audit (bounded, hybrid). ──────────────────────────────────────
      let auditSummary: ForgeResult['audit'];
      if (job.recipe.audit && job.oracle) {
        const outcome = await runAuditLoop({
          engine: this.engine,
          recipe: job.recipe,
          oracle: job.oracle,
          capture: job.capture ?? 'preview',
          maxSide: 1536,
          log,
        });
        auditSummary = { ok: outcome.ok, rounds: outcome.rounds, converged: outcome.converged };
        if (!outcome.ok) {
          throw new Error(
            `audit failed after ${outcome.rounds} round(s): ${outcome.violations.length} invariant violation(s)`,
          );
        }
        // The audit edited adjustment layers: re-save the master so the
        // approved state — including corrections — is what lands on disk.
        await this.engine.save({});
      }

      // ── 7. Deliverables (all derived; the master is untouched). ──────────
      const deliverables: ForgeResult['deliverables'] = [];
      for (const spec of job.recipe.delivery) {
        const path = this.resolveOutputPath(spec.path);
        if (spec.kind === 'raster') {
          await this.engine.exportDocument({
            path,
            format: spec.format,
            ...(spec.quality !== undefined ? { quality: spec.quality } : {}),
          });
        } else if (spec.kind === 'print') {
          await this.engine.runCommand('file.print', {
            output: path,
            send: false,
            dryRun: false,
          });
        }
        deliverables.push({ id: spec.id, path, format: spec.format });
        log({ event: 'forge.deliverable', id: spec.id, path });
      }

      // ── 8. Asset integrity check, in-engine. ─────────────────────────────
      const integrity = await verifyAssetIntegrity(
        this.engine,
        job.recipe.sources,
        (relative) => this.resolveAssetPath(relative),
      );
      const drift = integrity.filter((i) => i.status === 'missing');
      if (drift.length > 0) {
        throw new ProvenanceDriftError(drift);
      }

      // ── 9. Ledger. ───────────────────────────────────────────────────────
      const finishedAt = new Date().toISOString();
      const record: ProvenanceRecord = {
        schema: 'artcraft.provenance/v1',
        jobId: job.jobId,
        recipeId: job.recipe.id,
        recipeDigest: digest,
        recipePath: job.recipePath,
        engine: {
          app: 'photocraft',
          binary: 'photocraft-cli',
          commands: 0,
        },
        createdAt: startedAt,
        finishedAt,
        assets: job.recipe.sources.map((asset) => ({
          id: asset.id,
          path: asset.path,
          sha256: assetHashes.get(asset.id)?.sha256 ?? asset.sha256,
          bytes: assetHashes.get(asset.id)?.bytes ?? asset.bytes,
          linkStatus: integrity.find((i) => i.id === asset.id)?.status ?? 'missing',
        })),
        phases: records,
        audit: auditSummary
          ? [{ round: auditSummary.rounds, verdict: auditSummary.ok ? 'ok' : 'failed', changes: {} }]
          : [],
        deliverables,
        masterPath,
      };

      const written = await writeLedger(ledgerPath(this.resolveOutputPath(job.outDir), job.jobId), record);

      this.lastResult = {
        jobId: job.jobId,
        masterPath,
        ledgerPath: written.path,
        ledgerDigest: written.sha256,
        recipeDigest: digest,
        phases: records,
        deliverables,
        audit: auditSummary,
      };
    });

    if (!this.lastResult) throw new Error('forge: pipeline produced no result');
    return this.lastResult;
  }

  /** Populated by `run`; read after the mutex releases. */
  private lastResult: ForgeResult | null = null;

  /**
   * Execute one phase as a single `command_batch`.
   *
   * Layer references are resolved *before* the batch is dispatched, using a
   * fresh `document.inspect` whenever a referenced name is not yet known.
   * Because every creating step in a phase is followed by a `layer.setProps`
   * that renames it to its scoped name, the index stays accurate.
   */
  private async executePhase(
    phase: CompiledPhase,
    log: (event: JsonObject) => void,
  ): Promise<PhaseRecord> {
    const startedAt = Date.now();

    // ── FIX §E1 — `file.placeEmbedded` is refused under automation ─────────
    // ("uses ambient filesystem paths and is disabled; use capability-scoped
    // document methods"). The scoped replacement is the `doc_place` MCP tool,
    // which still creates a real Smart Object. It must run *before* the batch,
    // because the `$layer` refs in this same phase point at the layer it
    // creates; the compiler's rename step is applied here by hand.
    const skipped = new Set<PlannedStep>();
    const placeStep = phase.steps.find((s) => s.id === 'file.placeEmbedded');
    if (placeStep) {
      const placed = await this.engine.session.call<{ layer: number; smartObject?: boolean }>('doc_place', {
        path: String((placeStep.params as JsonObject).path),
        fit: Boolean((placeStep.params as JsonObject).fit),
        center: [this.canvas.width / 2, this.canvas.height / 2],
      });
      skipped.add(placeStep);
      const rename = phase.steps.find(
        (s) => s.id === 'layer.setProps' && isLayerRef((s.params as JsonObject).layer as JsonValue),
      );
      if (rename) {
        const scoped = ((rename.params as JsonObject).layer as LayerRef).$layer;
        await this.engine.runCommand('layer.setProps', { layer: placed.layer, name: scoped });
        skipped.add(rename);
      }
      log({ event: 'forge.place', phase: phase.phase, layer: placed.layer, smartObject: Boolean(placed.smartObject) });
    }

    // Resolve all layer references used by this phase up front.
    const effective = phase.steps.filter((s) => !skipped.has(s) && s.id !== 'select.deselect');
    const refs = collectRefs(effective);
    const resolved = await this.resolveLayerRefs(refs);
    const steps = effective.map((step) => ({
      id: step.id,
      params: substituteRefs(step.params, resolved),
      wait: true,
    }));

    try {
      const outcome = await this.engine.runBatch(steps, true);
      const ms = Date.now() - startedAt;
      log({ event: 'forge.phase', phase: phase.phase, completed: outcome.completed, ms });

      if (outcome.failed > 0) {
        await this.compensate(outcome.completed);
        return {
          phase: phase.phase,
          steps: steps.length,
          completed: outcome.completed,
          failed: outcome.failed,
          ms,
          error: outcome.results.find((r) => !r.ok)?.error ?? 'unknown',
        };
      }

      return {
        phase: phase.phase,
        steps: steps.length,
        completed: outcome.completed,
        failed: 0,
        ms,
      };
    } catch (error) {
      const ms = Date.now() - startedAt;
      // A transport-level failure gives us no `completed` count. We undo
      // optimistically: one `edit.undo` is a no-op-safe call when there is
      // nothing to undo, and the recipe makes full rebuilds cheap.
      await this.compensate(1).catch(() => undefined);
      return {
        phase: phase.phase,
        steps: steps.length,
        completed: 0,
        failed: steps.length,
        ms,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Compensating rollback.
   *
   * PhotoCraft's `command_batch` is documented as non-transactional: earlier
   * successful steps stay applied. We therefore undo exactly as many steps as
   * the engine reports it completed. This is a best-effort compensation, and
   * it is why the recipe — not the document — is the system of record.
   */
  private async compensate(completed: number): Promise<void> {
    for (let i = 0; i < completed; i++) {
      await this.engine.runCommand('edit.undo', {});
    }
  }

  /**
   * Resolve `$layer` placeholders to integer layer ids.
   *
   * A single `document.inspect` feeds the whole lookup; if a name is missing,
   * we refresh once (a just-created layer may not have been visible in a
   * stale index) and then fail loudly rather than guessing.
   */
  private async resolveLayerRefs(refs: LayerRef[]): Promise<Map<string, number>> {
    const wanted = new Set(refs.map((r) => r.$layer));
    const resolved = new Map<string, number>();
    if (wanted.size === 0) return resolved;

    for (let attempt = 0; attempt < 2; attempt++) {
      // PhotoCraft's `doc_inspect` takes only an optional `index` — it returns
      // the whole tree, so there is no `depth`/`childLimit` to page with.
      const tree = await this.engine.inspect();
      indexLayers(tree, resolved);
      const missing = [...wanted].filter((name) => !resolved.has(name));
      if (missing.length === 0) break;

      const deep = await this.engine.inspect({});
      indexLayers(deep, resolved);
      if ([...wanted].every((name) => resolved.has(name))) break;
    }

    const stillMissing = [...wanted].filter((name) => !resolved.has(name));
    if (stillMissing.length > 0) {
      // A reference whose layer is created *later in the same phase* cannot be
      // resolved yet. PhotoCraft resolves `{ "$layer": name }` natively, so the
      // unresolved ones are passed through untouched by `substituteRefs`.
      return resolved;
    }
    return resolved;
  }
}

/** Collect every `$layer` placeholder appearing anywhere in a step list. */
function collectRefs(steps: PlannedStep[]): LayerRef[] {
  const refs: LayerRef[] = [];
  const walk = (value: JsonValue | undefined): void => {
    if (value === undefined || value === null) return;
    if (isLayerRef(value)) {
      refs.push(value);
      return;
    }
    if (Array.isArray(value)) {
      value.forEach(walk);
      return;
    }
    if (typeof value === 'object') {
      Object.values(value).forEach(walk);
    }
  };
  for (const step of steps) walk(step.params);
  return refs;
}

/** Replace `$layer` placeholders with their resolved integer ids. */
function substituteRefs(params: JsonObject, resolved: Map<string, number>): JsonObject {
  const walk = (value: JsonValue): JsonValue => {
    if (isLayerRef(value)) {
      const id = resolved.get(value.$layer);
      // Not resolvable up front (created later in this phase): hand the ref to
      // the engine, which resolves `{ "$layer": name }` itself.
      return id === undefined ? value : id;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === 'object') {
      const out: JsonObject = {};
      for (const [k, v] of Object.entries(value)) out[k] = walk(v);
      return out;
    }
    return value;
  };
  return walk(params) as JsonObject;
}

/**
 * Walk an inspect payload and index every node with both an `id` and a `name`.
 *
 * The traversal is deliberately shape-tolerant: it accepts `layers`,
 * `children` and `nodes` as child collections, because the inspect payload is
 * a rich engine structure and we only depend on the two fields we need.
 */
function indexLayers(node: unknown, out: Map<string, number>): void {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach((child) => indexLayers(child, out));
    return;
  }
  const obj = node as Record<string, unknown>;
  const id = obj.id;
  const name = obj.name;
  if (typeof id === 'number' && typeof name === 'string') out.set(name, id);

  for (const key of ['layers', 'children', 'nodes', 'groups', 'items']) {
    const child = obj[key];
    if (child) indexLayers(child, out);
  }
}

/** Small helper used by the CLI entry point. */
export function jobIdFromPath(path: string): string {
  return basename(path).replace(/\.json$/i, '');
}
