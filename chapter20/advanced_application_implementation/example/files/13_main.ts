// src/13_main.ts
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { StudioOrchestrator, type CampaignResult } from "./12_orchestrator.js";
import { BriefSchema, type Brief, type CopyModel, type VisionModel } from "./04_types.js";

export interface CampaignRequestOptions {
  /** The parent directory of the campaign workspace. */
  readonly campaignRoot: string;
  /** The injected copywriter model. */
  readonly copyModel: CopyModel;
  /** The injected vision model. */
  readonly visionModel: VisionModel;
  /** The guardrail envelope for the campaign. */
  readonly budget?: {
    readonly maxCommands: number;
    readonly maxSeconds: number;
    readonly maxModelTokens: number;
  };
}

/**
 * The webhook handler. In production this is what turns an inbound HTTP
 * POST from the SaaS front-end into an end-to-end campaign.
 *
 * The two models are injected, not constructed here. A deployment wires
 * them to whatever vendor it uses; a test wires them to a deterministic
 * stand-in. Nothing in the studio knows or cares which.
 */
export async function handleCampaignRequest(
  briefJson: unknown,
  options: CampaignRequestOptions,
): Promise<CampaignResult> {
  const brief: Brief = BriefSchema.parse(briefJson);
  const orchestrator = new StudioOrchestrator({
    brief,
    campaignRoot: options.campaignRoot,
    copyModel: options.copyModel,
    visionModel: options.visionModel,
    budget: options.budget ?? {
      maxCommands: 2_500,
      maxSeconds: 900,
      maxModelTokens: 120_000,
    },
  });
  return orchestrator.run();
}

/**
 * A copy model that needs no network and no API key: it derives the copy
 * from the brief itself. It is the default for a local run and the
 * reference for what a real model's answer has to look like.
 */
export const deterministicCopyModel: CopyModel = async (brief) => ({
  headline: `${brief.product.name}: ${brief.product.tagline}`,
  subhead: `Designed for ${brief.audience}.`,
  bullets: brief.product.keyBenefits.map((benefit) => benefit.trim()),
  cta: "Shop now",
});

/**
 * A vision model that always finds the image acceptable. It is the
 * default for a local run.
 */
export const permissiveVisionModel: VisionModel = async () => ({
  status: "ok",
});

if (isMainModule(import.meta.url)) {
  const briefPath = process.argv[2];
  if (!briefPath) {
    process.stderr.write("usage: node dist/13_main.js <brief.json>\n");
    process.exit(2);
  }
  readFile(briefPath, "utf8")
    .then(async (raw) => {
      const result = await handleCampaignRequest(JSON.parse(raw), {
        campaignRoot: process.env.CAMPAIGN_ROOT ?? "/work/campaign",
        copyModel: deterministicCopyModel,
        visionModel: permissiveVisionModel,
      });
      process.stdout.write(`${JSON.stringify(result.state, null, 2)}\n`);
    })
    .catch((error: unknown) => {
      process.stderr.write(`${String(error)}\n`);
      process.exitCode = 1;
    });
}

/** True when this module is the process entry point. */
function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  return fileURLToPath(moduleUrl) === resolve(entry);
}
