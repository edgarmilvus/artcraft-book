/* ============================================================================
 * 6. Orchestrator: sequencing, telemetry, cleanup
 * ========================================================================== */
// The last section of the module: it sequences the stages of the previous
// section and closes the session when it is done.

import {
  LightCraftClient,
  PipelineConfigSchema,
  consoleLogger,
  type Logger,
  type PipelineConfig,
  type PipelineResult,
} from "./01_lightcraft-raw-pipeline.js";
import {
  stageCull,
  stageDenoise,
  stageExport,
  stageGrade,
  stageHdrMerge,
  stageImport,
  timed,
} from "./02_advanced_application_implementat.js";

/**
 * The end-to-end pipeline. Constructed with a validated config, it opens
 * a LightCraft MCP session, runs every stage in order, and always closes
 * the session — even on failure — so Kubernetes pods do not leak handles.
 */
export class RawPipeline {
  private readonly cfg: PipelineConfig;
  private readonly log: Logger;

  constructor(cfgInput: unknown, log: Logger = consoleLogger) {
    this.cfg = PipelineConfigSchema.parse(cfgInput);
    this.log = log;
  }

  /**
   * Run the pipeline to completion.
   * @returns An immutable {@link PipelineResult} suitable for the job ledger.
   */
  async run(): Promise<PipelineResult> {
    const durations: Record<string, number> = {};
    const lc = await LightCraftClient.spawn(this.cfg, this.log);

    try {
      // Stage A — Ingest with tenant’s metadata policy.
      const imp = await timed("import", durations, () =>
        stageImport(lc, this.cfg, this.log),
      );

      // Stage B — Optional HDR merge (bracketed deliverables only).
      const hdr = this.cfg.hdrMerge
        ? await timed("hdr", durations, () => stageHdrMerge(lc, this.cfg, this.log))
        : { merged: 0 };

      // Stage C — Burst stack + assisted culling (sharpness, clipping).
      const cull = await timed("cull", durations, () =>
        stageCull(lc, this.cfg, this.log),
      );

      // Stage D — 32-bit float linear grading graph + sync.
      const grade = await timed("grade", durations, () =>
        stageGrade(lc, this.cfg, this.log),
      );

      // Stage E — AI denoise on the graded picks.
      await timed("denoise", durations, () => stageDenoise(lc, this.log));

      // Stage F — Multi-tier export to object storage staging paths.
      const exported = await timed("export", durations, () =>
        stageExport(lc, this.cfg, this.log),
      );

      // Emit a LightCraft snapshot for the delivery record (idempotency key).
      const state = await lc.inspect();
      this.log.info("pipeline state snapshot", { state });

      return {
        eventDate: this.cfg.eventDate,
        album: this.cfg.albumName,
        imported: imp.imported,
        duplicates: imp.duplicates,
        moved: 0,
        culledGroups: cull.groups,
        rejected: cull.rejected,
        picked: cull.picked,
        hdrMerged: hdr.merged,
        graded: grade.graded,
        exported,
        stageDurationsMs: durations,
      };
    } finally {
      // The transport must close even on failure — pod cleanliness.
      await lc.close();
    }
  }
}

/* ============================================================================
 * 7. SaaS entry point (invoked by the worker’s job handler)
 * ========================================================================== */

/**
 * Example job handler. In production this is registered with the SaaS
 * queue consumer; the envelope comes from the ingest tier.
 */
export async function handleDeliveryJob(envelope: unknown): Promise<PipelineResult> {
  const pipeline = new RawPipeline(envelope, consoleLogger);
  return pipeline.run();
}
