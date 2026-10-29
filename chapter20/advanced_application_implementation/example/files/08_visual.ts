// src/08_visual.ts
import type { CraftClient } from "./03_craft-client.js";
import type { Budget } from "./06_budget.js";
import type { Brief } from "./04_types.js";

export interface VisualOutput {
  /** The hero PNG used as the campaign's canonical image. */
  readonly heroPngPath: string;
  /** A CTA badge PNG with transparency, sized 640×160. */
  readonly ctaBadgePngPath: string;
  /** Final 1080×1080 feed image. */
  readonly feedPngPath: string;
  /** Final 1920×1080 web banner. */
  readonly bannerPngPath: string;
  /** The editable VectorCraft document behind the badge. */
  readonly badgeVectorcraftPath: string;
}

const DEFAULT_PALETTE = {
  primary: "#0f172a",
  accent: "#f97316",
  neutral: "#f8fafc",
} as const;

/**
 * The visual designer: PhotoCraft for the raster base, VectorCraft for the
 * crisp typographic overlay.
 *
 * The two engines are not interchangeable and the difference shows up in
 * the very first call. PhotoCraft has a `doc_new` meta-tool; VectorCraft
 * has none — a document there is the `file.new` *command*, run through
 * `command_run`. The client hides that difference behind
 * `createDocument()`, but the underlying ids are not the same and the
 * listing would be wrong if it pretended they were.
 */
export class VisualAgent {
  public constructor(
    private readonly photocraft: CraftClient,
    private readonly vectorcraft: CraftClient,
    private readonly budget: Budget,
  ) {}

  public async run(brief: Brief, outDir: string): Promise<VisualOutput> {
    const palette = brief.product.palette ?? DEFAULT_PALETTE;

    // ── Step A: the hero in PhotoCraft ───────────────────────────────────
    if (brief.product.heroImagePath) {
      await this.photocraft.call("doc_open", {
        path: this.photocraft.readPath(brief.product.heroImagePath),
      });
      this.budget.spendCommands(1);
    } else {
      await this.photocraft.createDocument({
        width: 2048,
        height: 2048,
        mode: "rgb",
        depth: 8,
        background: palette.primary,
      });
      this.budget.spendCommands(1);
    }

    // A subtle S-curve for contrast, then a +0.05 exposure bump. Both are
    // adjustment layers, so the source pixels stay recoverable.
    await this.photocraft.runBatch([
      {
        id: "layer.newAdjustmentLayer.curves",
        params: { points: [[0, 0], [64, 58], [192, 200], [255, 255]] },
      },
      {
        id: "layer.newAdjustmentLayer.exposure",
        params: { exposure: 0.05, offset: 0, gamma: 1 },
      },
    ]);
    this.budget.spendCommands(2);

    // Resample to 1080×1080 and save the canonical hero.
    await this.photocraft.runCommand("image.imageSize", {
      width: 1080,
      height: 1080,
      resample: "bicubicSharper",
    });
    this.budget.spendCommands(1);

    const heroPngPath = this.photocraft.writePath(`${outDir}/hero-1080.png`);
    await this.photocraft.saveDocument(heroPngPath, "png");
    this.budget.spendCommands(1);

    // ── Step B: the CTA badge in VectorCraft ─────────────────────────────
    // VectorCraft has no document meta-tool: `file.new` is a registry
    // command, and the client routes it through `command_run`.
    await this.vectorcraft.createDocument({
      name: "CTA badge",
      width: 640,
      height: 160,
      units: "Pixels",
      colorMode: "rgb",
      backgroundContents: "transparent",
    });
    this.budget.spendCommands(1);

    // The shape stays selected after it is created, so the fill applies
    // to it without naming an object id.
    await this.vectorcraft.runCommand("shape.rectangle", {
      x: 0,
      y: 0,
      width: 640,
      height: 160,
      radius: 24,
    });
    this.budget.spendCommands(1);

    await this.vectorcraft.runCommand("paint.setFill", { color: palette.accent });
    this.budget.spendCommands(1);

    await this.vectorcraft.runCommand("text.create", {
      x: 32,
      y: 100,
      text: brief.product.tagline.slice(0, 28),
      size: 44,
      font: "Helvetica",
      color: "#ffffff",
    });
    this.budget.spendCommands(1);

    // Export the badge with transparency, and keep the editable document.
    const ctaBadgePngPath = this.vectorcraft.writePath(
      `${outDir}/cta-badge-640x160.png`,
    );
    await this.vectorcraft.runCommand("document.export", {
      path: ctaBadgePngPath,
      format: "png",
      scale: 1,
      background: "transparent",
    });
    this.budget.spendCommands(1);

    const badgeVectorcraftPath = this.vectorcraft.writePath(
      `${outDir}/cta-badge.vectorcraft`,
    );
    await this.vectorcraft.runCommand("file.saveAs", { path: badgeVectorcraftPath });
    this.budget.spendCommands(1);

    // ── Step C: the 1080×1080 feed composite in PhotoCraft ──────────────
    // Reopen the hero, place the badge at the bottom, add the name.
    await this.photocraft.call("doc_open", { path: heroPngPath });
    this.budget.spendCommands(1);

    await this.photocraft.call("doc_place", {
      path: this.photocraft.readPath(ctaBadgePngPath),
      fit: true,
      center: [540, 960],
    });
    this.budget.spendCommands(1);

    await this.photocraft.runCommand("type.create", {
      x: 80,
      y: 220,
      text: brief.product.name.toUpperCase(),
      font: "Helvetica",
      size: 96,
      color: palette.neutral,
      align: "left",
    });
    this.budget.spendCommands(1);

    const feedPngPath = this.photocraft.writePath(`${outDir}/feed-1080.png`);
    await this.photocraft.saveDocument(feedPngPath, "png");
    this.budget.spendCommands(1);

    // ── Step D: the 1920×1080 web banner ─────────────────────────────────
    await this.photocraft.runCommand("image.canvasSize", {
      width: 1920,
      height: 1080,
      anchor: "center",
      extensionColor: palette.neutral,
    });
    await this.photocraft.runCommand("type.create", {
      x: 128,
      y: 240,
      text: brief.product.tagline,
      font: "Helvetica",
      size: 72,
      color: palette.primary,
    });
    this.budget.spendCommands(1);

    const bannerPngPath = this.photocraft.writePath(
      `${outDir}/banner-1920x1080.png`,
    );
    await this.photocraft.saveDocument(bannerPngPath, "png");
    this.budget.spendCommands(1);

    return {
      heroPngPath,
      ctaBadgePngPath,
      feedPngPath,
      bannerPngPath,
      badgeVectorcraftPath,
    };
  }
}
