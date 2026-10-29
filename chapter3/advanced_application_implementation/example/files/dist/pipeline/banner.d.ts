import { CraftMCPClient } from "../mcp/client.js";
import { type Artifact, type DesignBrief } from "../contracts.js";
export interface PipelineDeps {
    readonly photocraft: CraftMCPClient;
    readonly designcraft: CraftMCPClient;
    readonly outDir: string;
    readonly inDir: string;
}
/**
 * Execute the two-stage banner pipeline for one brief.
 * Preconditions: both clients are warm (already connected).
 * Postconditions: a PNG artifact exists under `outDir` with matching SHA-256.
 */
export declare function runBannerPipeline(brief: DesignBrief, deps: PipelineDeps): Promise<Artifact>;
