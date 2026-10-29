// gfx-factory/factory.ts
import * as fs from "node:fs/promises";
import * as path from "node:path";
import OpenAI from "openai";
import { PhotoCraftMcpClient } from "./mcp-client.js";
import { AssetResolver } from "./assets.js";
import {
  ProductFeedSchema,
  type ProductFeed,
  type ProductFeedEntry,
} from "./schemas.js";
import {
  BrandKitSchema,
  PlacementSchema,
  type BrandKit,
  type Placement,
} from "./brand.js";
import { compileRecipe, recipeHash, type Composition } from "./recipe.js";
import { composeBanner } from "./compose.js";
import { qaBanner } from "./qa.js";
import { z } from "zod";

export interface FactoryConfig {
  /** Directory containing the feed JSON file. */
  feedPath: string;
  /** Directory for downloaded assets (must be under the read-root). */
  assetRoot: string;
  /** Directory for flattened PNGs (must be under the write-root). */
  outRoot: string;
  /** Absolute read-root the MCP child may access. */
  readRoot: string;
  /** Absolute write-root the MCP child may write. */
  writeRoot: string;
  /** Optional OpenAI key; when absent, vision QA is skipped. */
  openaiKey?: string;
  /** Skip work whose recipe hash is already in the cache. */
  softCache?: boolean;
  /**
   * The fetcher the asset resolver uses. A worker injects the real one; a
   * test injects a stub that serves local bytes.
   */
  fetchImpl?: typeof fetch;
}

export interface RenderReport {
  generated: string[];      // absolute paths that were written this run
  reused: string[];         // hash paths already present
  failed: Array<{ sku: string; placement: string; error: string }>;
  qaFailures: Array<{ sku: string; placement: string; issues: unknown[] }>;
}

/**
 * The factory is stateful only in that it owns one MCP child and
 * one AssetResolver. Everything else — schemas, recipes, docs —
 * is per-invocation, so multiple `run()` calls can share a client
 * across an entire shard of the feed.
 */
export class GraphicsFactory {
  private mcp: PhotoCraftMcpClient;
  private assets: AssetResolver;
  private openai: OpenAI | null;

  constructor(private readonly cfg: FactoryConfig) {
    this.mcp = new PhotoCraftMcpClient({
      readRoot: cfg.readRoot,
      writeRoot: cfg.writeRoot,
    });
    this.assets = new AssetResolver(cfg.assetRoot, cfg.fetchImpl ?? globalThis.fetch);
    this.openai = cfg.openaiKey ? new OpenAI({ apiKey: cfg.openaiKey }) : null;
  }

  /**
   * Render one product across a set of placements & variants.
   * Guarantees: no partial PNG ever lands in the cache; a failed
   * banner is reported but does not abort the shard.
   */
  async renderProduct(
    brand: BrandKit,
    placement: Placement,
    product: ProductFeedEntry,
    hq = true
  ): Promise<{ generated: string[]; reused: string[]; qaIssues: unknown[] }> {
    const generated: string[] = [];
    const reused: string[] = [];
    let qaIssues: unknown[] = [];

    const hero = await this.assets.resolve(product.variants[0].imageUrl);
    const logoRel = brand.logoUrl
      ? (await this.assets.resolve(brand.logoUrl)).relativePath
      : undefined;

    for (const variant of product.variants) {
      const heroRel =
        variant.imageUrl === product.variants[0].imageUrl
          ? hero.relativePath
          : (await this.assets.resolve(variant.imageUrl)).relativePath;

      const composition = compileRecipe(brand, placement, product, variant);
      // The hash is namespaced ("sha256:<hex>"); the cache path uses the
      // digest alone, so the shard and the file name stay portable.
      const digest = recipeHash(composition).replace(/^[a-z0-9]+:/, "");
      const outPath = path.join(
        this.cfg.outRoot,
        digest.slice(0, 2),
        `${digest}.png`
      );

      if (this.cfg.softCache !== false) {
        try {
          await fs.access(outPath);
          reused.push(outPath);
          continue;
        } catch {
          /* cache miss */
        }
      }

      try {
        await composeBanner(this.mcp, composition, heroRel, logoRel);
        if (this.openai) {
          const verdict = await qaBanner(this.mcp, this.openai, composition);
          if (!verdict.pass) qaIssues = verdict.issues;
        }
        await fs.mkdir(path.dirname(outPath), { recursive: true });
        await this.mcp.save({
          path: path.relative(this.cfg.writeRoot, outPath),
          format: "png",
          quality: hq ? 95 : 80,
        });
        generated.push(outPath);
      } catch (err) {
        // The caller sees this via `failed`, and it does NOT
        // abort the shard. Errors are engine-level, contract-level
        // or transient.
        throw new Error(
          `render ${product.id}@${variant.sku} ${placement.id}: ${(err as Error).message}`
        );
      }
    }

    return { generated, reused, qaIssues };
  }

  /**
   * Full-shard entrypoint. Loads and validates the feed, applies
   * every (placement × product × variant) combination, and returns
   * a structured `RenderReport`.
   */
  async run(args: {
    brandJson: unknown;
    placementsJson: unknown;
  }): Promise<RenderReport> {
    // 1. Load & validate
    const raw = await fs.readFile(this.cfg.feedPath, "utf8");
    const feed: ProductFeed = ProductFeedSchema.parse(JSON.parse(raw));
    const brand = BrandKitSchema.parse(args.brandJson);
    const placements = z.array(PlacementSchema).parse(args.placementsJson);

    const report: RenderReport = {
      generated: [],
      reused: [],
      failed: [],
      qaFailures: [],
    };

    try {
      // 2. Iterate — placements outer, products inner: keeps the
      //    same scene size across a contiguous engine run, which
      //    helps the GPU/wgpu backend reuse pipelines.
      for (const placement of placements) {
        for (const product of feed.products) {
          try {
            const r = await this.renderProduct(brand, placement, product);
            report.generated.push(...r.generated);
            report.reused.push(...r.reused);
            if (r.qaIssues.length > 0) {
              report.qaFailures.push({
                sku: product.id,
                placement: placement.id,
                issues: r.qaIssues,
              });
            }
          } catch (err) {
            report.failed.push({
              sku: product.id,
              placement: placement.id,
              error: (err as Error).message,
            });
          }
        }
      }
      return report;
    } finally {
      await this.mcp.close();
    }
  }
}

/** Convenience CLI shim: `node factory.js <feed> <brand> <placements> <out>`. */
async function main(): Promise<void> {
  const [feedPath, brandPath, placementsPath, outRoot] = process.argv.slice(2);
  if (!feedPath || !brandPath || !placementsPath || !outRoot) {
    console.error("usage: factory <feed> <brand> <placements> <out>");
    process.exit(2);
  }
  const brandJson = JSON.parse(await fs.readFile(brandPath, "utf8"));
  const placementsJson = JSON.parse(await fs.readFile(placementsPath, "utf8"));

  const factory = new GraphicsFactory({
    feedPath,
    assetRoot: path.join(process.cwd(), ".assets"),
    outRoot,
    readRoot: process.cwd(),
    writeRoot: process.cwd(),
    openaiKey: process.env.OPENAI_API_KEY,
    softCache: true,
  });
  const report = await factory.run({ brandJson, placementsJson });
  console.log(JSON.stringify(report, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
