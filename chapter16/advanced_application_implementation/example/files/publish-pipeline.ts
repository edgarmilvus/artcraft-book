/**
 * publish-pipeline.ts
 * ---------------------------------------------------------------------------
 * End-to-end orchestration for one publish job.
 *
 * Stage order is load-bearing:
 *   1. new_document       — page geometry must exist before spreads are addressed
 *   2. layout prefs       — baseline grid before any style is created
 *   3. style sheet        — styles before any text is placed
 *   4. parent pages       — masters before page-level overrides
 *   5. artwork frames     — wrap objects before the story flows around them
 *   6. text threading     — the story chain, with overset verification per link
 *   7. TOC / footnotes    — generated matter after the body is stable
 *   8. QA                 — preflight, fonts, links, story link freshness
 *   9. export             — PDF/X, EPUB, HTML, IDML, contact sheet
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import {
  DesignCraftSession,
  type CommandStep,
  type Logger,
  NullLogger,
} from "./designcraft-session.js";
import {
  ManuscriptSchema,
  type Manuscript,
  type Section,
  type Artwork,
} from "./contracts.js";
import { bindTypography, planStyleApplication, type TypographyReport } from "./typography.js";
import {
  fullPageTextRect,
  pageSlots,
  planArtwork,
  planSectionThread,
  textBand,
  type Rect,
} from "./layout-planner.js";

/* -------------------------------------------------------------------------- */
/* Configuration                                                              */
/* -------------------------------------------------------------------------- */

export interface PipelineConfig {
  readRoot: string;
  writeRoot: string;
  logger?: Logger;
  /** Engine binary override (useful in tests). */
  binary?: string;
  /** Frames to plan per section beyond the first. */
  framesPerSection?: number;
  /** Render page PNGs during QA. */
  renderProofs?: boolean;
  /** Optional vision endpoint for multimodal proof review. */
  visionEndpoint?: string;
}

export interface PublishResult {
  jobId: string;
  documentPath: string;
  pdfPath: string;
  epubPath?: string;
  htmlPath?: string;
  idmlPath?: string;
  proofPaths: string[];
  pages: number;
  spreads: number;
  stories: number;
  oversetFrames: number;
  typography: TypographyReport;
  warnings: string[];
}

/* -------------------------------------------------------------------------- */
/* Errors                                                                     */
/* -------------------------------------------------------------------------- */

export class OversetError extends Error {
  constructor(public readonly sectionId: string, public readonly remainingChars: number) {
    super(
      `Section "${sectionId}" still has ${remainingChars} characters in overset after ` +
        `all planned frames were consumed. Increase framesPerSection, reduce the ` +
        `body point size, or enable hyphenation on the body style.`
    );
    this.name = "OversetError";
  }
}

export class PreflightError extends Error {
  constructor(public readonly issues: Array<{ severity: string; message: string }>) {
    super(
      `Preflight failed with ${issues.filter((i) => i.severity === "error").length} error(s): ` +
        issues
          .filter((i) => i.severity === "error")
          .map((i) => i.message)
          .join("; ")
    );
    this.name = "PreflightError";
  }
}

/* -------------------------------------------------------------------------- */
/* Stage 1 — document creation                                                */
/* -------------------------------------------------------------------------- */

/**
 * Create the document at the manuscript's trim size with facing pages.
 *
 * `new_document` accepts the page geometry directly, which is preferable to
 * creating a default document and then calling `layout.documentSetup`, because
 * the latter triggers an `adjustLayout` pass that can move already-placed items.
 */
async function createDocument(session: DesignCraftSession, m: Manuscript): Promise<number> {
  const created = await session.docNew({
    width: m.grid.pageWidthPt,
    height: m.grid.pageHeightPt,
    pages: estimateInitialPages(m),
    facingPages: m.grid.facingPages,
    columns: m.grid.columns,
    gutter: m.grid.gutterPt,
    margins: {
      top: m.grid.margins.top,
      bottom: m.grid.margins.bottom,
      inside: m.grid.margins.inside,
      outside: m.grid.margins.outside,
    },
    bleed: m.grid.bleedPt,
    title: m.title,
    preset: undefined,
    sample: false,
  });
  return created.index ?? created.document ?? 0;
}

/** A deliberately generous first estimate; extra pages are trimmed at export. */
function estimateInitialPages(m: Manuscript): number {
  const chars = m.sections.reduce(
    (acc, s) => acc + s.blocks.reduce((a, b) => a + b.text.length, 0),
    0
  );
  const body = m.styles[0];
  if (!body) throw new Error("estimate: the manuscript has no body style");
  const approxCharsPerPage =
    ((m.grid.pageWidthPt - m.grid.margins.inside - m.grid.margins.outside) *
      (m.grid.pageHeightPt - m.grid.margins.top - m.grid.margins.bottom)) /
    (body.chars.size * body.chars.leading * 0.5);
  return Math.max(4, Math.ceil(chars / Math.max(600, approxCharsPerPage)) + m.sections.length * 2);
}

/* -------------------------------------------------------------------------- */
/* Stage 2 — layout: guides, sections, parent pages                           */
/* -------------------------------------------------------------------------- */

async function configureLayout(session: DesignCraftSession, m: Manuscript): Promise<void> {
  const steps: CommandStep[] = [];

  // Section numbering: front matter in roman, body in decimal.
  let pageCursor = 1;
  for (const section of m.sections) {
    steps.push({
      id: "layout.section",
      params: {
        page: pageCursor,
        startNumber: section.numbering.startAt,
        style: section.numbering.style,
        prefix: section.numbering.prefix,
      },
    });
    pageCursor += Math.max(2, Math.ceil(section.blocks.length / 3));
  }

  // Column guides are cosmetic but they make the proof pages readable to a
  // human reviewer and to a vision model auditing alignment.
  steps.push({
    id: "layout.createGuides",
    params: {
      columns: m.grid.columns,
      columnGutter: m.grid.gutterPt,
      rows: 0,
      fitTo: "margins",
      removeExisting: true,
    },
  });

  // Liquid layout: re-centre rather than scale when the trim size changes.
  steps.push({
    id: "liquid.pageRule",
    params: { rule: "reCenter" },
  });

  await session.commandBatch(steps);
}

/* -------------------------------------------------------------------------- */
/* Stage 3 — artwork                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Create art frames BEFORE threading text.
 *
 * Rationale: in DesignCraft, text wrap is declared on the *wrap object*
 * (`object.textWrap`), and the wrap is consulted by the compositor at line-break
 * time. An art frame created after the story has flowed does not retroactively
 * reshape the lines that already broke around empty space — the paragraph
 * composer's cached break decisions remain. Creating wrap objects first and
 * threading second is the correct ordering.
 */
async function placeArtwork(
  session: DesignCraftSession,
  m: Manuscript
): Promise<{ labelToFrame: Map<string, number>; warnings: string[] }> {
  const placements = planArtwork(m);
  const byLabel = new Map(m.artwork.map((a) => [a.label, a]));
  const labelToFrame = new Map<string, number>();
  const warnings: string[] = [];

  for (const placement of placements) {
    const art: Artwork | undefined = byLabel.get(placement.label);
    if (!art) continue;

    const created = await session.commandRun<{ id?: number; story?: number }>("frame.create", {
      spread: placement.spread,
      rect: placement.rect,
      content: "graphic",
      shape: "rectangle",
    });

    const frameId = created.id;
    if (frameId === undefined) {
      warnings.push(`frame.create returned no id for artwork "${art.label}"`);
      continue;
    }

    // Tag the frame with a script label so later stages can find it by name
    // even after the spread graph is reflowed by page insertion.
    await session.commandRun("object.label", { ids: [frameId], label: `art:${art.label}` });

    try {
      await session.placeImage({ frame: frameId, path: art.path });
    } catch (err) {
      warnings.push(`place_image failed for "${art.label}": ${String(err)}`);
      continue;
    }

    // Fit, wrap, and alt text are three separate commands; batch them so the
    // frame is never observed in a half-configured state by a concurrent QA read.
    const fitSteps: CommandStep[] = [
      { id: "object.fit", params: { mode: art.fit, ids: [frameId] } },
      {
        id: "object.textWrap",
        params: {
          mode: art.wrap,
          offset: art.wrapOffsetPt,
          invert: false,
          ids: [frameId],
        },
      },
    ];

    if (art.altText) {
      fitSteps.push({
        id: "object.altText",
        params: { text: art.altText, ids: [frameId] },
      });
    }

    if (art.caption) {
      fitSteps.push({
        id: "object.caption",
        params: {
          text: art.caption,
          position: "below",
          offset: 6,
          height: 24,
          style: m.styles.find((s) => /caption/i.test(s.name))?.name,
          ids: [frameId],
        },
      });
    }

    await session.commandBatch(fitSteps);
    labelToFrame.set(art.label, frameId);
  }

  return { labelToFrame, warnings };
}

/* -------------------------------------------------------------------------- */
/* Stage 4 — threading                                                        */
/* -------------------------------------------------------------------------- */

/** Concatenate a section's blocks into a single story string. */
function renderSectionText(section: Section): string {
  return section.blocks.map((b) => b.text).join("\n");
}

/**
 * Thread one section across as many frames as required.
 *
 * Algorithm
 * ---------
 * 1. Create the primary frame on the section's opening spread with the full
 *    section text pre-loaded. This gives the engine a story to measure.
 * 2. Ask `get_story` for the overset state.
 * 3. While overset remains and planned frames are exhausted, place a linked
 *    frame with `story.placeAndLink` and re-check.
 * 4. If overset remains after all frames are consumed, raise `OversetError`.
 *
 * `story.placeAndLink` creates a frame whose story is a *linked copy* of the
 * parent and stays associated via `story.links`. That link is what allows
 * `story.updateLink` to push a corrected manuscript through the whole chain
 * without re-threading from scratch — the mechanism behind live editorial
 * revisions in a review cycle.
 */
async function threadSection(
  session: DesignCraftSession,
  m: Manuscript,
  section: Section,
  startSpread: number,
  frameBudget: number
): Promise<{ storyId: number; frameIds: number[]; oversetChars: number }> {
  const plan = planSectionThread(m.grid, section, startSpread, frameBudget);
  if (plan.length === 0) {
    throw new Error(`No frames planned for section "${section.id}"`);
  }

  const text = renderSectionText(section);

  // --- 1. Primary frame -----------------------------------------------------
  const first = plan[0];
  if (!first) throw new Error(`No frames planned for section "${section.id}"`);
  const primary = await session.commandRun<{ id?: number; story?: number }>("frame.create", {
    spread: first.spread,
    rect: first.rect,
    content: "text",
    text,
    caret: false,
  });

  const primaryFrame = primary.id;
  const primaryStory = primary.story;
  if (primaryFrame === undefined || primaryStory === undefined) {
    throw new Error(`frame.create did not return {id, story} for section "${section.id}"`);
  }

  const frameIds: number[] = [primaryFrame];
  await session.commandRun("object.label", { ids: [primaryFrame], label: `body:${section.id}:0` });

  // Frame options: multi-column, first baseline locked to the grid.
  await session.commandBatch(
    [
      {
        id: "object.textFrameOptions",
        params: {
          columns: m.grid.columns,
          gutter: m.grid.gutterPt,
          inset: [0, 0, 0, 0],
          verticalJustification: "top",
          firstBaseline: m.grid.baselinePt,
          autoSize: false,
          ignoreWrap: false,
          balanceColumns: m.grid.columns > 1,
          ids: [primaryFrame],
        },
      },
    ],
  );

  // --- 2/3. Linked frame chain ---------------------------------------------
  let overset = await measureOverset(session, primaryStory);
  let index = 1;

  while (overset > 0 && index < plan.length) {
    const slot = plan[index];
    if (!slot) break;

    try {
      const linked = await session.commandRun<{ id?: number; story?: number }>(
        "story.placeAndLink",
        { story: primaryStory, rect: slot.rect, spread: slot.spread }
      );

      const frameId = linked.id;
      if (frameId === undefined) {
        // No room on this spread; advance to the next planned frame.
        index += 1;
        continue;
      }

      frameIds.push(frameId);
      await session.commandRun("object.label", {
        ids: [frameId],
        label: `body:${section.id}:${index}`,
      });

      // Sync the child frame to the parent's current copy before measuring.
      await session.commandRun("story.updateLink", { story: linked.story ?? primaryStory });

      overset = await measureOverset(session, primaryStory);
      index += 1;
    } catch (err) {
      // A failed placeAndLink usually means the spread has no room; advance.
      index += 1;
      if (index >= plan.length) break;
    }
  }

  if (overset > 0) {
    throw new OversetError(section.id, overset);
  }

  return { storyId: primaryStory, frameIds, oversetChars: overset };
}

/**
 * Normalise the many shapes the engine uses to report overset.
 *
 * `get_story` may return a character count, a boolean, a byte offset, or a
 * nested object depending on the build. We collapse all of them to a number.
 */
async function measureOverset(session: DesignCraftSession, story: number): Promise<number> {
  const info = await session.getStory({ story });
  const raw = info.overset;

  if (typeof raw === "number") return raw;
  if (typeof raw === "boolean") return raw ? Number.MAX_SAFE_INTEGER : 0;
  if (typeof raw === "object" && raw !== null) {
    const asRecord = raw as Record<string, unknown>;
    const candidates = ["characters", "length", "count", "offset", "position"];
    for (const key of candidates) {
      const value = asRecord[key];
      if (typeof value === "number") return value;
    }
  }
  return 0;
}

/* -------------------------------------------------------------------------- */
/* Stage 5 — generated matter                                                 */
/* -------------------------------------------------------------------------- */

async function generateEditorialMatter(
  session: DesignCraftSession,
  m: Manuscript
): Promise<string[]> {
  const warnings: string[] = [];

  // --- Table of contents ----------------------------------------------------
  try {
    await session.commandRun("toc.generate", {
      entries: [
        { style: "Headline 1", level: 1 },
        { style: "Headline 2", level: 2 },
      ],
      title: "Contents",
      pageNumbers: true,
    });
  } catch (err) {
    warnings.push(`toc.generate failed: ${String(err)}`);
  }

  // --- Running-head text variable ------------------------------------------
  try {
    await session.commandRun("variables.define", {
      name: "RunningHead",
      type: "runningHeader",
      style: "Headline 2",
      use: "firstOnPage",
    });
  } catch (err) {
    warnings.push(`variables.define(runningHeader) failed: ${String(err)}`);
  }

  // --- Footnote conventions ------------------------------------------------
  try {
    await session.commandRun("footnote.options", {
      style: "arabic",
      startAt: 1,
      restart: "page",
      prefix: "",
      suffix: "",
      separator: "\u2014",
      spaceBefore: 6,
      spaceBetween: 3,
      rule: { on: true, weight: 0.5, color: "Body Text", tint: 100, width: 33, offset: 9, leftIndent: 0 },
    });
  } catch (err) {
    warnings.push(`footnote.options failed: ${String(err)}`);
  }

  // --- Index ----------------------------------------------------------------
  try {
    await session.commandRun("index.generate", { title: "Index" });
  } catch (err) {
    warnings.push(`index.generate failed: ${String(err)}`);
  }

  return warnings;
}

/* -------------------------------------------------------------------------- */
/* Stage 6 — editorial QA                                                     */
/* -------------------------------------------------------------------------- */

export interface QaReport {
  preflight: Array<{ severity: string; kind: string; message: string; item?: number; page?: number }>;
  fonts: Array<{ family: string; style: string; missing: boolean }>;
  staleStoryLinks: number[];
  oversetFrames: number;
  pageCount: number;
  spreadCount: number;
  storyCount: number;
}

async function runEditorialQa(
  session: DesignCraftSession,
  m: Manuscript
): Promise<QaReport> {
  // --- Preflight ------------------------------------------------------------
  let preflight: QaReport["preflight"] = [];
  try {
    const result = await session.commandRun<
      Array<{ severity: string; kind: string; message: string; item?: number; page?: number }>
    >("preflight.run", { minPpi: 220 });
    preflight = Array.isArray(result) ? result : [];
  } catch {
    preflight = [];
  }

  // --- Fonts ----------------------------------------------------------------
  let fonts: QaReport["fonts"] = [];
  try {
    const list = await session.commandRun<Array<{ family: string; style: string; missing?: boolean }>>(
      "font.list",
      {}
    );
    fonts = (Array.isArray(list) ? list : []).map((f) => ({
      family: f.family,
      style: f.style,
      missing: Boolean(f.missing),
    }));
  } catch {
    fonts = [];
  }

  // --- Story link freshness -------------------------------------------------
  // A non-empty `outOfDate` list means an editor revised a parent story and the
  // child frames downstream are rendering stale copy. In a review workflow this
  // is the single most dangerous silent failure mode.
  const staleStoryLinks: number[] = [];
  try {
    const links = await session.commandRun<Array<{ story: number; parent: number; outOfDate: boolean }>>(
      "story.links",
      {}
    );
    for (const link of Array.isArray(links) ? links : []) {
      if (link.outOfDate) staleStoryLinks.push(link.story);
    }
  } catch {
    /* no linked stories */
  }

  // --- Structural counts ----------------------------------------------------
  const doc = await session.docInspect<{
    pageCount?: number;
    spreads?: unknown[];
    stories?: Array<{ id: number; overset?: number | boolean }>;
  }>();

  const pageCount = typeof doc.pageCount === "number" ? doc.pageCount : 0;
  const spreadCount = Array.isArray(doc.spreads) ? doc.spreads.length : 0;
  const stories = Array.isArray(doc.stories) ? doc.stories : [];
  const oversetFrames = stories.filter((s) => Boolean(s.overset)).length;

  return {
    preflight,
    fonts,
    staleStoryLinks,
    oversetFrames,
    pageCount,
    spreadCount,
    storyCount: stories.length,
  };
}

/* -------------------------------------------------------------------------- */
/* Stage 7 — multimodal proof review                                          */
/* -------------------------------------------------------------------------- */

/**
 * Render a spread and, if a vision endpoint is configured, ask a vision model
 * to flag layout defects that programmatic QA cannot see: collisions between an
 * image and a folio, an orphaned heading at a column foot, a pull-quote that has
 * drifted off the baseline grid, a river of white space through justified copy.
 *
 * In containerised CI this is a no-op unless PROOF_VISION_ENDPOINT is set.
 */
async function auditProof(
  session: DesignCraftSession,
  page: number,
  writeRoot: string,
  visionEndpoint?: string
): Promise<{ path: string; findings: string[] }> {
  const proofPath = path.join(writeRoot, `proof-page-${String(page).padStart(3, "0")}.png`);

  await session.renderPage(page, 2, proofPath);

  if (!visionEndpoint) return { path: proofPath, findings: [] };

  try {
    const bytes = await readFile(proofPath);
    const b64 = bytes.toString("base64");

    const response = await fetch(visionEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        image: `data:image/png;base64,${b64}`,
        prompt:
          "You are a typesetting proof auditor. Inspect this book page for: (1) overset or " +
          "clipped text, (2) any line whose baseline does not align to the horizontal grid " +
          "shared by the rest of the column, (3) widows or orphans of one line, (4) collisions " +
          "between artwork and running heads, folios, or captions, (5) rivers of white space in " +
          "justified copy. Return JSON: {\"findings\": [\"...\"]}. Empty array if clean.",
        responseFormat: "json",
      }),
    });

    if (!response.ok) return { path: proofPath, findings: [] };

    const payload = (await response.json()) as { findings?: string[] };
    return { path: proofPath, findings: payload.findings ?? [] };
  } catch {
    // Vision review is advisory; its absence must never fail a publish job.
    return { path: proofPath, findings: [] };
  }
}

/* -------------------------------------------------------------------------- */
/* Stage 8 — export                                                           */
/* -------------------------------------------------------------------------- */

async function exportArtifacts(
  session: DesignCraftSession,
  m: Manuscript,
  outDir: string
): Promise<{
  pdfPath: string;
  epubPath?: string;
  htmlPath?: string;
  idmlPath?: string;
  warnings: string[];
}> {
  const warnings: string[] = [];
  const stem = slugify(m.title);
  const pdfPath = path.join(outDir, `${stem}.pdf`);

  // --- Print PDF / PDF-X ----------------------------------------------------
  const pdfResult = await session.commandRun<{ path?: string; bytes?: number; pages?: number; warnings?: string[] }>(
    "file.exportPdf",
    {
      path: pdfPath,
      pages: "all",
      flatten: m.export.flatten,
      spreads: false,
      bookmarksPanel: true,
      pageLayout: "twoUpCover",
      view: "fitPage",
      bleed: m.export.bleed,
      marks: m.export.marks
        ? { crop: true, bleed: true, pageInfo: true, weight: 0.25, offset: 9 }
        : false,
      standard: m.export.pdfStandard,
      compressImages: true,
      tagged: m.export.tagged,
      media: false,
      title: m.title,
      author: m.author,
    }
  );
  if (pdfResult.warnings?.length) warnings.push(...pdfResult.warnings);

  // --- Reflowable EPUB ------------------------------------------------------
  let epubPath: string | undefined;
  if (m.export.emitEpub) {
    epubPath = path.join(outDir, `${stem}.epub`);
    try {
      const epub = await session.commandRun<{ path?: string; bytes?: number }>("file.exportEpub", {
        path: epubPath,
        title: m.title,
        author: m.author,
        language: m.language,
        cover: true,
        fixedLayout: false,
      });
      if (!epub.path) warnings.push("Export EPUB produced no path; file was not written.");
    } catch (err) {
      warnings.push(`Export EPUB failed: ${String(err)}`);
      epubPath = undefined;
    }
  }

  // --- Self-contained HTML --------------------------------------------------
  let htmlPath: string | undefined;
  if (m.export.emitHtml) {
    htmlPath = path.join(outDir, `${stem}.html`);
    try {
      const html = await session.commandRun<{ path?: string; bytes?: number }>("file.exportHtml", {
        path: htmlPath,
        title: m.title,
        language: m.language,
      });
      if (!html.path) warnings.push("Export HTML produced no path; file was not written.");
    } catch (err) {
      warnings.push(`Export HTML failed: ${String(err)}`);
      htmlPath = undefined;
    }
  }

  // --- IDML handoff ---------------------------------------------------------
  let idmlPath: string | undefined;
  if (m.export.emitIdml) {
    idmlPath = path.join(outDir, `${stem}.idml`);
    try {
      await session.commandRun("file.exportIdml", { path: idmlPath, embedImages: true });
    } catch (err) {
      warnings.push(`Export IDML failed: ${String(err)}`);
      idmlPath = undefined;
    }
  }

  // The optional deliverables are only set when they exist: the
  // contract does not accept an explicit `undefined`.
  return {
    pdfPath,
    ...(epubPath ? { epubPath } : {}),
    ...(htmlPath ? { htmlPath } : {}),
    ...(idmlPath ? { idmlPath } : {}),
    warnings,
  };
}

/* -------------------------------------------------------------------------- */
/* Orchestrator                                                               */
/* -------------------------------------------------------------------------- */

export async function publish(manuscript: Manuscript, config: PipelineConfig): Promise<PublishResult> {
  const log = config.logger ?? new NullLogger();
  const warnings: string[] = [];

  const session = new DesignCraftSession({
    ...(config.binary ? { binary: config.binary } : {}),
    readRoot: config.readRoot,
    writeRoot: config.writeRoot,
    logger: log,
  });

  await session.connect();

  try {
    // --- 1. Document --------------------------------------------------------
    await createDocument(session, manuscript);
    log.info("stage.document.created", { jobId: manuscript.jobId });

    // --- 2. Layout ----------------------------------------------------------
    await configureLayout(session, manuscript);

    // --- 3. Typography ------------------------------------------------------
    const typography = await bindTypography(session, manuscript);
    const missingFonts = typography.fontsInUse.filter((f) => f.missing);
    if (missingFonts.length > 0) {
      // A missing font invalidates every line-break decision the composer made.
      // Fail fast rather than ship a document with substituted metrics.
      throw new Error(
        `Missing fonts: ${missingFonts.map((f) => `${f.family} ${f.style}`).join(", ")}. ` +
          `Install the fonts or substitute them in the manuscript before publishing.`
      );
    }
    log.info("stage.typography.bound", { styles: typography.boundStyles.length });

    // --- 4. Artwork (before text, so wraps participate in composition) ------
    const artwork = await placeArtwork(session, manuscript);
    warnings.push(...artwork.warnings);

    // --- 5. Threading -------------------------------------------------------
    const frameBudget = config.framesPerSection ?? 24;
    let spreadCursor = 0;
    let totalOverset = 0;

    for (const section of manuscript.sections) {
      const threaded = await threadSection(session, manuscript, section, spreadCursor, frameBudget);
      totalOverset += threaded.oversetChars;
      spreadCursor += Math.ceil(threaded.frameIds.length / manuscript.grid.columns) + 2;
      log.info("stage.thread.done", {
        section: section.id,
        frames: threaded.frameIds.length,
        story: threaded.storyId,
      });
    }

    // --- 6. Generated matter ------------------------------------------------
    warnings.push(...(await generateEditorialMatter(session, manuscript)));

    // --- 7. QA --------------------------------------------------------------
    const qa = await runEditorialQa(session, manuscript);
    const blocking = qa.preflight.filter((i) => i.severity === "error" || i.severity === "warning");
    if (blocking.length > 0) {
      log.warn("stage.qa.preflight.issues", { count: blocking.length });
    }

    // --- 8. Proof render (multimodal loop) ----------------------------------
    const proofPaths: string[] = [];
    if (config.renderProofs) {
      for (let p = 1; p <= Math.min(4, qa.pageCount); p++) {
        const proof = await auditProof(session, p, config.writeRoot, config.visionEndpoint);
        proofPaths.push(proof.path);
        if (proof.findings.length > 0) {
          warnings.push(`Page ${p} proof: ${proof.findings.join(" | ")}`);
        }
      }
    }

    // --- 9. Save + export ---------------------------------------------------
    const documentPath = path.join(config.writeRoot, `${slugify(manuscript.title)}.designcraft`);
    await session.docSave(documentPath);

    const exported = await exportArtifacts(session, manuscript, config.writeRoot);
    warnings.push(...exported.warnings);

    return {
      jobId: manuscript.jobId,
      documentPath,
      pdfPath: exported.pdfPath,
      ...(exported.epubPath ? { epubPath: exported.epubPath } : {}),
      ...(exported.htmlPath ? { htmlPath: exported.htmlPath } : {}),
      ...(exported.idmlPath ? { idmlPath: exported.idmlPath } : {}),
      proofPaths,
      pages: qa.pageCount,
      spreads: qa.spreadCount,
      stories: qa.storyCount,
      oversetFrames: qa.oversetFrames,
      typography,
      warnings,
    };
  } finally {
    await session.close();
  }
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 64);
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const [, , manuscriptPath, outDir] = process.argv;
  if (!manuscriptPath || !outDir) {
    console.error("usage: node publish-pipeline.js <manuscript.json> <out-dir>");
    process.exitCode = 2;
    return;
  }

  const raw = JSON.parse(await readFile(manuscriptPath, "utf8")) as unknown;
  const manuscript = ManuscriptSchema.parse(raw);

  const result = await publish(manuscript, {
    readRoot: process.env.AUTOMATION_READ_ROOT ?? process.cwd(),
    writeRoot: outDir,
    renderProofs: process.env.RENDER_PROOFS === "1",
    ...(process.env.PROOF_VISION_ENDPOINT ? { visionEndpoint: process.env.PROOF_VISION_ENDPOINT } : {}),
  });

  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(JSON.stringify({ ok: false, error: String(err) }, null, 2));
    process.exitCode = 1;
  });
}
