// src/10_publisher.ts
import type { CraftClient } from "./03_craft-client.js";
import type { Budget } from "./06_budget.js";
import type { Brief, CopyBlock } from "./04_types.js";
import type { VisualOutput } from "./08_visual.js";

export interface PublishOutput {
  /** The editable DesignCraft document behind the flyer. */
  readonly flyerDesigncraftPath: string;
  /** The two rendered flyer pages. */
  readonly flyerPngPaths: readonly string[];
  /** The print PDF, assembled from the flyer pages. */
  readonly flyerPdfPath: string;
  /** The tracking page, on its own. */
  readonly trackingPdfPath: string;
  /** The campaign bundle: flyer pages plus the tracking page. */
  readonly bundlePdfPath: string;
}

/**
 * The publisher: DesignCraft lays out a two-page flyer, PdfCraft turns the
 * rendered pages into a print PDF and combines it with a tracking page.
 *
 * This is the only agent that drives two engines directly, and it is
 * deliberately procedural. Publication is a linear sequence — lay out,
 * render, print, combine — and a generic "app coordinator" would cost more
 * abstraction than it saves.
 *
 * Two engine quirks shape the code. DesignCraft has no sandbox of its
 * own, so every path it is handed goes through the client's confinement
 * check first. PdfCraft is confined to a single `--root` directory and
 * addresses documents by id, so its `doc_save` needs the id that
 * `doc_create` returned.
 */
export class PublisherAgent {
  public constructor(
    private readonly designcraft: CraftClient,
    private readonly pdfcraft: CraftClient,
    private readonly budget: Budget,
  ) {}

  public async run(
    brief: Brief,
    copy: CopyBlock,
    visuals: VisualOutput,
    outDir: string,
  ): Promise<PublishOutput> {
    // ── Step 1: the two-page flyer in DesignCraft ───────────────────────
    await this.designcraft.createDocument({
      preset: "A4",
      facingPages: false,
      pages: 2,
      margins: 36,
      columns: 1,
      gutter: 12,
      title: `${brief.product.name} — ${brief.campaignId.slice(0, 8)}`,
    });
    this.budget.spendCommands(1);

    // Page 1: a frame for the hero image and a headline frame.
    const heroFrame = await this.designcraft.runCommand<{ id: number }>(
      "frame.create",
      { spread: 0, rect: [36, 36, 560, 400], content: "graphic" },
    );
    await this.designcraft.call("place_image", {
      path: this.designcraft.readPath(visuals.heroPngPath),
      frame: heroFrame.id,
      spread: 0,
    });
    await this.designcraft.runCommand("frame.create", {
      spread: 0,
      rect: [36, 460, 560, 620],
      content: "text",
      text: copy.headline,
    });
    this.budget.spendCommands(3);

    // Page 2: the bullet copy and the CTA badge.
    await this.designcraft.runCommand("frame.create", {
      spread: 1,
      rect: [36, 36, 560, 500],
      content: "text",
      text: [copy.subhead, "", ...copy.bullets.map((b) => `• ${b}`)].join("\n"),
    });
    const badgeFrame = await this.designcraft.runCommand<{ id: number }>(
      "frame.create",
      { spread: 1, rect: [36, 560, 400, 640], content: "graphic" },
    );
    await this.designcraft.call("place_image", {
      path: this.designcraft.readPath(visuals.ctaBadgePngPath),
      frame: badgeFrame.id,
      spread: 1,
    });
    this.budget.spendCommands(3);

    // Render both pages. `page` is 0-based and `scale` is pixels per
    // point, so scale 2 renders an A4 page at 144 dpi.
    const page1Png = this.designcraft.writePath(`${outDir}/flyer-p1.png`);
    const page2Png = this.designcraft.writePath(`${outDir}/flyer-p2.png`);
    await this.designcraft.call("export_png", { page: 0, path: page1Png, scale: 2 });
    await this.designcraft.call("export_png", { page: 1, path: page2Png, scale: 2 });
    this.budget.spendCommands(2);

    const flyerDesigncraftPath = this.designcraft.writePath(
      `${outDir}/flyer.designcraft`,
    );
    await this.designcraft.saveDocument(flyerDesigncraftPath);
    this.budget.spendCommands(1);

    // ── Step 2: the print PDF in PdfCraft ────────────────────────────────
    // PdfCraft turns the rendered pages into a PDF, then a second document
    // carries the tracking line, and the two are combined into the bundle.
    const flyerDocument = await this.pdfcraft.call<{ doc: number }>("doc_create", {
      from: "images",
      paths: [page1Png, page2Png],
    });
    this.budget.spendCommands(1);

    const flyerPdfPath = this.pdfcraft.writePath(`${outDir}/flyer-print.pdf`);
    await this.pdfcraft.call("doc_save", { doc: flyerDocument.doc, path: flyerPdfPath });
    this.budget.spendCommands(1);

    const trackingDocument = await this.pdfcraft.call<{ doc: number }>("doc_create", {
      from: "text",
      text:
        `Campaign: ${brief.product.name}\n` +
        `Audience: ${brief.audience}\n` +
        `Tracking URL: https://track.example.com/c/${brief.campaignId}\n`,
    });
    this.budget.spendCommands(1);

    const trackingPdfPath = this.pdfcraft.writePath(`${outDir}/tracking.pdf`);
    await this.pdfcraft.call("doc_save", {
      doc: trackingDocument.doc,
      path: trackingPdfPath,
    });
    this.budget.spendCommands(1);

    const bundlePdfPath = this.pdfcraft.writePath(`${outDir}/campaign-bundle.pdf`);
    await this.pdfcraft.call("doc_combine", {
      paths: [flyerPdfPath, trackingPdfPath],
      out: bundlePdfPath,
    });
    this.budget.spendCommands(1);

    return {
      flyerDesigncraftPath,
      flyerPngPaths: [page1Png, page2Png],
      flyerPdfPath,
      trackingPdfPath,
      bundlePdfPath,
    };
  }
}
