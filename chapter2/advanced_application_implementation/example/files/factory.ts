// ---------------------------------------------------------------------------
// @file creative-factory/factory.ts
//
// The top-level entry point. In the SaaS, this is invoked from a Next.js
// Server Action: `POST /api/generate` -> Server Action -> runBrandFactory().
// The browser only ever sees the preview PNG and the export URL.
// ---------------------------------------------------------------------------

import { ArtCraftSession } from "./session.js";
import { CommandRegistry } from "./registry.js";
import { TileDeltaPlanner, PlanStep } from "./tile-delta.js";
import { DualCompositor } from "./dual-compositor.js";
import {
  SupervisorNode,
  TypeSetterAgent,
  GradientAgent,
  ComplianceAgent,
  TenantBrief,
} from "./supervisor.js";
import { AssetRecord, VectorStoreClient, deriveVectorId } from "./asset-store.js";
import { mkdir, writeFile } from "node:fs/promises";

export interface FactoryConfig {
  readRoot: string;
  writeRoot: string;
  vectorStore: VectorStoreClient;
  embed: (previewPng: Uint8Array) => Promise<number[]>;
}

export class BrandFactory {
  constructor(private readonly cfg: FactoryConfig) {}

  /**
   * The full pipeline. Returns the URLs and the reconciliation report.
   *
   * Steps, in order:
   *   1.  Open the accelerated session and the reference session.
   *   2.  Boot both registries (cache their schemas).
   *   3.  Create the document on both sessions.
   *   4.  Dispatch the brief to the workers via the supervisor.
   *   5.  Plan the tile deltas.
   *   6.  Execute the frames on both sessions (in lock-step).
   *   7.  Reconcile the two compositors.
   *   8.  Export (reference session) and snapshot preview (accelerated).
   *   9.  Embed, upsert, return.
   */
  async run(brief: TenantBrief): Promise<{
    previewUrl: string;
    exportUrl: string;
    reconciliation: { converged: boolean; hashAligned: boolean };
    vectorId: string;
  }> {
    // 1. Open sessions. The reference session is bound to the CPU-SIMD
    //    compositor via env; the accelerated session uses the default GPU.
    const fast = new ArtCraftSession({
      binary: "photocraft-cli",
      readRoot: this.cfg.readRoot,
      writeRoot: this.cfg.writeRoot,
    });
    const ref = new ArtCraftSession({
      binary: "photocraft-cli",
      readRoot: this.cfg.readRoot,
      writeRoot: this.cfg.writeRoot,
      env: { PHOTOCRAFT_GPU: "0" },
    });
    await Promise.all([fast.connect(), ref.connect()]);

    try {
      // 2. Boot registries. These are independent caches, but on the same
      //    engine version they enumerate identically.
      const [regFast] = await Promise.all([CommandRegistry.load(fast)]);
      await CommandRegistry.load(ref);
      const engineVersion = regFast.engineVersion;

      // 3. Create documents on both sessions. The doc spec is identical,
      //    byte for byte: same size, same mode, same depth, same background.
      const docSpec = {
        width: brief.width,
        height: brief.height,
        mode: "rgb" as const,
        depth: 8 as const,
        background: "#ffffff",
      };
      await Promise.all([fast.newDoc(docSpec), ref.newDoc(docSpec)]);

      // 4. Dispatch. The supervisor merges the three workers' plans.
      const supervisor = new SupervisorNode(
        [new GradientAgent(), new TypeSetterAgent(), new ComplianceAgent()],
        regFast,
      );
      const intent: PlanStep[] = supervisor.dispatch(brief);

      // 5. Plan the tile deltas.
      const planner = new TileDeltaPlanner(regFast);
      const frames = planner.plan("brand-asset", intent);

      // 6. Execute every frame on both sessions, in lock-step. We execute
      //    frame-by-frame rather than en-masse so that, if reconciliation
      //    fails, we can bisect to the offending frame.
      for (const frame of frames) {
        const steps = frame.steps.map((s) => ({ id: s.id, params: s.params }));
        await Promise.all([fast.batch(steps), ref.batch(steps)]);
      }

      // 7. Reconcile compositors.
      const compositor = new DualCompositor(fast, ref);
      const report = await compositor.renderBoth(2048);

      // 8. Export from the reference session; preview from the fast session.
      //    `doc_save` does not create directories, so the tenant folder has to
      //    exist inside the write root before the first export.
      const assetDir = `${this.cfg.writeRoot}/${brief.tenantId}`;
      await mkdir(assetDir, { recursive: true });
      const exportPath = `${assetDir}/${brief.campaignId}.png`;
      const saveResult = await ref.save(exportPath, "png");
      if ((saveResult.warnings ?? []).length > 0) {
        console.warn("[factory] export warnings:", saveResult.warnings);
      }
      const previewPng = await fast.preview(1536);
      // The preview is an asset in its own right: without writing it, the
      // `previewPath` in the vector record points at a file that never exists.
      const previewPath = `${assetDir}/${brief.campaignId}-preview.png`;
      await writeFile(previewPath, previewPng);

      // 9. Embed + Upsert.
      const embedding = await this.cfg.embed(previewPng);
      const vectorId = deriveVectorId(
        brief,
        engineVersion,
        ["gradient", "typesetter", "compliance"],
      );
      const record: AssetRecord = {
        vectorId,
        tenantId: brief.tenantId,
        campaignId: brief.campaignId,
        locale: brief.locale,
        engineVersion,
        journal: frames.flatMap((f) =>
          f.steps.map((s) => ({ id: s.id, params: s.params })),
        ),
        reconciliation: {
          converged: report.converged,
          hashAligned: report.hashAligned,
          rmse: report.accelerated.rmse,
        },
        exportPath,
        previewPath,
        embedding,
      };
      await this.cfg.vectorStore.upsert([record]);

      return {
        previewUrl: `/assets/${brief.tenantId}/${brief.campaignId}-preview.png`,
        exportUrl: `/assets/${brief.tenantId}/${brief.campaignId}.png`,
        reconciliation: { converged: report.converged, hashAligned: report.hashAligned },
        vectorId,
      };
    } finally {
      // Always drain and close, even on failure, so no child process escapes.
      await Promise.allSettled([fast.close(), ref.close()]);
    }
  }
}
