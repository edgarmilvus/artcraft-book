// src/12_orchestrator.ts
import { closeSync, openSync, readSync, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CraftClient, type CraftDialect } from "./03_craft-client.js";
import { CampaignStore } from "./05_store.js";
import { Budget, type BudgetLimits } from "./06_budget.js";
import { CopywriterAgent } from "./07_copywriter.js";
import { VisualAgent, type VisualOutput } from "./08_visual.js";
import { MotionAgent, type MotionOutput } from "./09_motion.js";
import { PublisherAgent, type PublishOutput } from "./10_publisher.js";
import { VisionAuditor } from "./11_auditor.js";
import type {
  AssetArtefact,
  AuditVerdict,
  Brief,
  CampaignState,
  Channel,
  CopyBlock,
  CopyModel,
  VisionModel,
} from "./04_types.js";

export interface OrchestratorOptions {
  /** The validated brief. */
  readonly brief: Brief;
  /** The parent directory of the campaign workspace. */
  readonly campaignRoot: string;
  /** The injected copywriter model. */
  readonly copyModel: CopyModel;
  /** The injected vision model. */
  readonly visionModel: VisionModel;
  /** The guardrail envelope for the whole campaign. */
  readonly budget: BudgetLimits;
  /** A hard timeout per MCP tool call, in milliseconds. */
  readonly requestTimeoutMs?: number;
}

export interface CampaignResult {
  /** The final snapshot of the campaign store. */
  readonly state: CampaignState;
  /** The campaign workspace. */
  readonly workDir: string;
  /** Where the journal was flushed. */
  readonly statePath: string;
  /** The budget snapshot at the end of the run. */
  readonly budget: { commands: number; tokens: number; seconds: number };
  readonly copy: CopyBlock;
  readonly visuals: VisualOutput;
  readonly published: PublishOutput;
  readonly motion: MotionOutput | null;
  readonly verdict: AuditVerdict;
}

/**
 * The orchestrator: the only class that owns a whole run.
 *
 * It is responsible for spawning every transport, sequencing the agents,
 * invoking the vision auditor at the right moment — after the base hero
 * exists but before the campaign is published — and flushing the journal
 * on the way out.
 *
 * The engines are heterogeneous by construction. PhotoCraft and VectorCraft
 * confine themselves to the directories they are given; DesignCraft,
 * WordCraft and EffectCraft do not, so the client confines them. The
 * orchestrator does not care which is which: it hands every client the
 * same campaign directory and lets the dialect decide how to say so.
 */
export class StudioOrchestrator {
  private readonly store: CampaignStore;
  private readonly budget: Budget;
  private readonly clients = new Map<CraftDialect, CraftClient>();

  public constructor(private readonly opts: OrchestratorOptions) {
    this.store = CampaignStore.bootstrap(opts.brief, opts.campaignRoot);
    this.budget = new Budget(opts.budget);
  }

  /** Run the entire pipeline end to end. */
  public async run(): Promise<CampaignResult> {
    const { brief, campaignRoot } = this.opts;
    const workDir = join(campaignRoot, brief.campaignId);
    await mkdir(workDir, { recursive: true });

    // ── Transport bring-up ───────────────────────────────────────────────
    const photocraft = this.spawn("photocraft", workDir);
    const vectorcraft = this.spawn("vectorcraft", workDir);
    const wordcraft = this.spawn("wordcraft", workDir);
    const effectcraft = this.spawn("effectcraft", workDir);
    const designcraft = this.spawn("designcraft", workDir);
    const pdfcraft = this.spawn("pdfcraft", workDir);

    try {
      for (const client of this.clients.values()) {
        await client.connect();
      }
      this.store.journal(
        "orchestrator",
        `Connected ${String(this.clients.size)} ArtCraft engines.`,
        0,
      );

      // ── Phase 1: the narrative plane ───────────────────────────────────
      let mark = this.budget.snapshot().commands;
      const copywriter = new CopywriterAgent(wordcraft, this.budget, this.opts.copyModel);
      const copy = await copywriter.run(brief, join(workDir, "copy.docx"));
      this.store.setCopy(copy);
      this.store.journal(
        "copywriter",
        `Copy block generated: "${copy.headline}".`,
        this.spentSince(mark),
      );
      this.budget.assertWithinLimits();

      // ── Phase 2: the visual plane ──────────────────────────────────────
      mark = this.budget.snapshot().commands;
      const visual = new VisualAgent(photocraft, vectorcraft, this.budget);
      const visuals = await visual.run(brief, workDir);
      this.store.setHero({
        path: visuals.heroPngPath,
        palette: brief.product.palette ?? {
          primary: "#0f172a",
          accent: "#f97316",
          neutral: "#f8fafc",
        },
      });
      this.store.journal(
        "visual",
        "Hero, badge, feed and banner rendered.",
        this.spentSince(mark),
      );
      this.budget.assertWithinLimits();

      // ── Phase 2b: the editorial plane audits the feed image ───────────
      mark = this.budget.snapshot().commands;
      await photocraft.call("doc_open", { path: photocraft.readPath(visuals.feedPngPath) });
      this.budget.spendCommands(1);
      const auditor = new VisionAuditor(photocraft, this.budget, this.opts.visionModel);
      const verdict = await auditor.auditAndCorrect(3);
      if (!verdict.passed) {
        await photocraft.saveDocument(visuals.feedPngPath, "png");
        this.budget.spendCommands(1);
      }
      this.store.journal(
        "vision",
        `Audit ${verdict.passed ? "passed" : "corrected"}: ${verdict.reasons.join(" | ")}`,
        this.spentSince(mark),
      );

      // Register the visuals as first-class artefacts.
      const visualArtefacts: Array<[Channel, string]> = [
        ["email-hero", visuals.heroPngPath],
        ["instagram-post", visuals.feedPngPath],
        ["web-banner", visuals.bannerPngPath],
      ];
      for (const [channel, path] of visualArtefacts) {
        this.store.recordAsset(
          this.makeArtefact(channel, path, "image/png", "visual", "photocraft-cli", {
            audit: channel === "instagram-post" ? verdict : null,
          }),
        );
      }

      // ── Phase 3: the motion plane, only when a reel was asked for ──────
      let motion: MotionOutput | null = null;
      mark = this.budget.snapshot().commands;
      if (brief.channels.includes("tiktok-reel")) {
        const framesDir = join(workDir, "reel-frames");
        await mkdir(framesDir, { recursive: true });
        const motionAgent = new MotionAgent(effectcraft, this.budget);
        motion = await motionAgent.run(brief, framesDir);
        this.store.journal(
          "motion",
          `Rendered ${String(motion.frames)} frames for "${motion.compName}".`,
          this.spentSince(mark),
        );
        this.budget.assertWithinLimits();
      }

      // ── Phase 4: publication ───────────────────────────────────────────
      mark = this.budget.snapshot().commands;
      const publisher = new PublisherAgent(designcraft, pdfcraft, this.budget);
      const published = await publisher.run(brief, copy, visuals, workDir);
      this.store.journal(
        "publisher",
        "Flyer rendered, bundle compiled.",
        this.spentSince(mark),
      );

      this.store.recordAsset(
        this.makeArtefact(
          "print-flyer",
          published.flyerPngPaths[0] ?? "",
          "image/png",
          "publisher",
          "designcraft-cli",
        ),
      );
      this.store.recordAsset(
        this.makeArtefact(
          "pdf-onepager",
          published.bundlePdfPath,
          "application/pdf",
          "publisher",
          "pdfcraft-cli",
        ),
      );
      this.store.recordAsset(
        this.makeArtefact(
          "pdf-onepager",
          published.flyerPdfPath,
          "application/pdf",
          "publisher",
          "pdfcraft-cli",
        ),
      );

      // ── Flush the journal ──────────────────────────────────────────────
      const statePath = join(workDir, "campaign-state.json");
      await this.store.flush(statePath);
      this.budget.assertWithinLimits();

      const snapshot = this.budget.snapshot();
      this.store.journal(
        "orchestrator",
        `Campaign complete. commands=${String(snapshot.commands)} tokens=${String(snapshot.tokens)}`,
        0,
      );
      await this.store.flush(statePath);

      return {
        state: this.store.get(),
        workDir,
        statePath,
        budget: snapshot,
        copy,
        visuals,
        published,
        motion,
        verdict,
      };
    } finally {
      await Promise.allSettled(
        [...this.clients.values()].map((client) => client.close()),
      );
    }
  }

  private spawn(dialect: CraftDialect, workDir: string): CraftClient {
    const client = new CraftClient({
      dialect,
      readRoot: workDir,
      writeRoot: workDir,
      requestTimeoutMs: this.opts.requestTimeoutMs ?? 120_000,
    });
    this.clients.set(dialect, client);
    return client;
  }

  /** The commands spent since a mark taken from the budget snapshot. */
  private spentSince(mark: number): number {
    return this.budget.snapshot().commands - mark;
  }

  private makeArtefact(
    channel: Channel,
    path: string,
    mime: string,
    producer: string,
    binary: string,
    extra: { audit?: AuditVerdict | null } = {},
  ): AssetArtefact {
    return {
      id: this.store.nextArtefactId(channel),
      channel,
      path,
      mime,
      producer,
      binary,
      dimensions: describeDimensions(path, mime),
      bytes: describeBytes(path),
      audit: extra.audit ?? null,
      createdAtIso: new Date().toISOString(),
    };
  }
}

/** The size of a file on disk, or zero when it is not there. */
function describeBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * The pixel dimensions of a PNG, read from the IHDR chunk. A PDF or a
 * `.docx` has no pixel size, so it reports null.
 */
function describeDimensions(
  path: string,
  mime: string,
): { width: number; height: number } | null {
  if (mime !== "image/png") return null;
  let handle: number;
  try {
    handle = openSync(path, "r");
  } catch {
    return null;
  }
  try {
    const header = Buffer.alloc(24);
    const read = readSync(handle, header, 0, header.length, 0);
    if (read < 24) return null;
    if (header.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a") return null;
    return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
  } catch {
    return null;
  } finally {
    closeSync(handle);
  }
}
