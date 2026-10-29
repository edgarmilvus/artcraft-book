/**
 * typography.ts
 * ---------------------------------------------------------------------------
 * Turns a Manuscript's declarative style specs into DesignCraft paragraph and
 * character styles, and configures the engine's paragraph composer.
 */

import type { DesignCraftSession, CommandStep } from "./designcraft-session.js";
import type { GridSpec, Manuscript, StyleSpec } from "./contracts.js";

/** DesignCraft command ids this module is allowed to emit. */
export const DC = {
  STYLE_PARA_CREATE: "style.paragraph.create",
  STYLE_PARA_APPLY: "style.paragraph.apply",
  STYLE_CHAR_CREATE: "style.character.create",
  STYLE_CHAR_APPLY: "style.character.apply",
  STYLE_EXPORT_TAG: "style.exportTag",
  STYLE_OBJECT_CREATE: "style.object.create",
  SWATCH_CREATE: "swatch.create",
  SWATCH_ADD_UNNAMED: "swatch.addUnnamed",
  TYPE_CHAR: "type.char",
  TYPE_PARA: "type.para",
  TYPE_ALIGN: "type.align",
  DOC_PREFS: "document.preferences",
  HYPH_ADD: "hyphenation.addException",
  HYPH_LIST: "hyphenation.list",
  SPELL_SET_WORDS: "spelling.setWords",
  SPELL_CHECK: "spelling.check",
  FONT_LIST: "font.list",
  TYPE_SELECTION_ATTRS: "type.selectionAttrs",
  TEXT_SELECT: "text.select",
} as const;

/** Result of binding one style, retained for audit and for later re-application. */
export interface BoundStyle {
  name: string;
  exportTag: string;
  exportClass: string;
  chars: StyleSpec["chars"];
  para: StyleSpec["para"];
}

/* -------------------------------------------------------------------------- */
/* Grid assertion                                                             */
/* -------------------------------------------------------------------------- */

export class BaselineGridViolationError extends Error {
  constructor(
    styleName: string, leading: number, increment: number, line = 1,
  ) {
    super(
      `Style "${styleName}" declares leading ${leading}pt which does not divide the ` +
        `baseline grid increment ${increment}pt. Off-grid leading drifts the vertical ` +
        `rhythm on every page following the first: line ${line} sits at ` +
        `${(leading * line).toFixed(3)}pt instead of ` +
        `${(increment * Math.round((leading * line) / increment)).toFixed(3)}pt.`
    );
    this.name = "BaselineGridViolationError";
  }
}

/**
 * Assert that a leading value is an exact multiple of the grid increment.
 * Floating-point tolerance of 1e-6pt is used because leading is frequently
 * expressed as a fraction of point size (e.g. 10.5pt × 1.19 = 12.495pt).
 */
export function assertOnGrid(styleName: string, leading: number, increment: number): void {
  const ratio = leading / increment;
  const rounded = Math.round(ratio);
  if (rounded < 1 || Math.abs(ratio - rounded) > 1e-6) {
    throw new BaselineGridViolationError(styleName, leading, increment);
  }
}

/* -------------------------------------------------------------------------- */
/* Style binding                                                              */
/* -------------------------------------------------------------------------- */

export function slugifyStyleName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Build the DesignCraft command steps that materialise every style in the
 * manuscript. Steps are returned rather than executed so the caller can wrap
 * them in a single `batch` — one round trip and one undo step, so the style
 * sheet is never observed half-installed by a concurrent reader.
 */
export function buildStyleSheetSteps(m: Manuscript): CommandStep[] {
  const steps: CommandStep[] = [];

  // --- 1. Validate the grid before emitting anything. -----------------------
  for (const style of m.styles) {
    assertOnGrid(style.name, style.chars.leading, m.grid.baselinePt);
  }

  // --- 2. Swatches. CMYK only; spots get their own plate. -------------------
  for (const swatch of m.swatches) {
    steps.push({
      id: DC.SWATCH_CREATE,
      params: {
        name: swatch.name,
        color: { c: swatch.cmyk.c, m: swatch.cmyk.m, y: swatch.cmyk.y, k: swatch.cmyk.k },
        spot: swatch.spot,
      },
    });
  }

  // --- 3. Paragraph styles, in declaration order so `basedOn` always resolves.
  for (const style of m.styles) {
    steps.push({
      id: DC.STYLE_PARA_CREATE,
      params: {
        name: style.name,
        basedOn: style.para.basedOn ?? undefined,
        nextStyle: style.para.nextStyle ?? undefined,
        para: {
          align: style.para.align,
          leftIndent: style.para.leftIndent,
          rightIndent: style.para.rightIndent,
          firstLineIndent: style.para.firstLineIndent,
          spaceBefore: style.para.spaceBefore,
          spaceAfter: style.para.spaceAfter,
          dropCapLines: style.para.dropCapLines,
          hyphenate: style.para.hyphenate,
          composer: style.para.composer,
          // The engine is not symmetric here: `keepWithNext` is a 0/1
          // flag, while `keepLinesTogether` is a plain boolean.
          keepWithNext: style.para.keepWithNext ? 1 : 0,
          keepLinesTogether: style.para.keepLinesTogether,
          tabs: style.para.tabs.length ? style.para.tabs : undefined,
        },
        chars: characterAttrs(style),
      },
    });
  }

  // --- 4. Export tagging: HTML/EPUB semantics follow the style, not the text.
  for (const style of m.styles) {
    steps.push({
      id: DC.STYLE_EXPORT_TAG,
      params: {
        style: style.name,
        tag: style.exportTag,
        class: style.exportClass ?? slugifyStyleName(style.name),
      },
    });
  }

  // --- 5. Hyphenation dictionary. -------------------------------------------
  // Without entries here the KP composer has nowhere to break and degenerates
  // to emergency spacing. "ex-am-ple" declares legal break points; a bare word
  // is a no-break directive (used for proper nouns and product names).
  for (const entry of m.hyphenationExceptions) {
    steps.push({ id: DC.HYPH_ADD, params: { word: entry } });
  }

  // --- 6. User dictionary so spell check never blocks the release gate. -----
  if (m.userDictionary.length > 0) {
    steps.push({ id: DC.SPELL_SET_WORDS, params: { words: m.userDictionary } });
  }

  return steps;
}

/** Derive the `type.char` attribute object from a style spec. */
function characterAttrs(style: StyleSpec): Record<string, unknown> {
  const chars: Record<string, unknown> = {
    fontFamily: style.chars.fontFamily,
    fontStyle: style.chars.fontStyle,
    size: style.chars.size,
    leading: { kind: "points", value: style.chars.leading },
    tracking: style.chars.tracking,
    baselineShift: style.chars.baselineShift,
    fill: style.chars.fill,
  };

  if (style.chars.kerning !== undefined) chars.kerning = style.chars.kerning;
  if (style.chars.capitalization === "allCaps") chars.capitalization = "allCaps";
  if (style.chars.capitalization === "smallCaps") chars.capitalization = "smallCaps";
  if (style.chars.features.length > 0) {
    // DesignCraft accepts an OpenType feature list on character attributes.
    chars.openType = style.chars.features;
  }

  return chars;
}

/* -------------------------------------------------------------------------- */
/* Runner                                                                     */
/* -------------------------------------------------------------------------- */

export interface TypographyReport {
  boundStyles: BoundStyle[];
  fontsInUse: Array<{ family: string; style: string; missing: boolean; characters: number }>;
  gridIncrementPt: number;
  composerDefault: string;
}

/**
 * Install the style sheet into the live document and return a report.
 *
 * Runs as a SINGLE `batch`: if any style fails the grid assertion the
 * engine rolled nothing back, because we asserted before emitting. If any style
 * fails inside the engine (e.g. an unknown swatch name referenced as a fill),
 * the batch aborts at that index and the document is left with the earlier
 * styles — which is why we re-inspect fonts afterwards and fail the job loudly.
 */
export async function bindTypography(
  session: DesignCraftSession,
  m: Manuscript
): Promise<TypographyReport> {
  const steps = buildStyleSheetSteps(m);

  // Install engine-level advanced-type preferences and grid geometry.
  // `advancedType` sizes drive superscript/subscript in footnotes and xrefs.
  await session.commandRun(DC.DOC_PREFS, {
    horizontalUnits: "points",
    verticalUnits: "points",
    baselineGrid: {
      start: m.grid.margins.top + m.grid.textTopOffsetPt,
      increment: m.grid.baselinePt,
      color: [160, 190, 255],
      viewThreshold: 1,
    },
    advancedType: {
      superscriptSize: 62.5,
      superscriptPosition: 33,
      subscriptSize: 62.5,
      subscriptPosition: -14,
    },
    overprintBlack: true,
    glyphFallback: true,
  });

  await session.commandBatch(steps);

  // --- Font audit -----------------------------------------------------------
  // A style whose font family is absent silently substitutes, and substituted
  // metrics invalidate every line-break decision the composer made.
  const fontList = await session.commandRun<
    Array<{ family: string; style: string; characters: number; missing: boolean }>
  >(DC.FONT_LIST, {});

  const fontsInUse = fontList.map((f) => ({
    family: f.family,
    style: f.style,
    characters: f.characters ?? 0,
    missing: Boolean(f.missing),
  }));

  return {
    boundStyles: m.styles.map((s) => ({
      name: s.name,
      exportTag: s.exportTag,
      exportClass: s.exportClass ?? slugifyStyleName(s.name),
      chars: s.chars,
      para: s.para,
    })),
    fontsInUse,
    gridIncrementPt: m.grid.baselinePt,
    composerDefault: m.styles.find((s) => s.para.composer === "paragraph") ? "paragraph" : "singleLine",
  };
}

/* -------------------------------------------------------------------------- */
/* Post-threading style application                                           */
/* -------------------------------------------------------------------------- */

/**
 * Apply paragraph styles to the threaded story.
 *
 * DesignCraft addresses text by UTF-8 byte offsets (`text.select {story, anchor,
 * focus}`) — the same offsets `find.find` reports. We therefore walk the
 * story text, compute byte spans for each block, and emit a `style.paragraph.apply`
 * + `text.select` pair per block inside one batch.
 *
 * Note: `style.paragraph.apply` operates on the current text selection, so the
 * ordering within the batch is load-bearing — select, then apply, per block.
 */
export interface AppliedBlock {
  styleRef: string;
  startByte: number;
  endByte: number;
}

export function planStyleApplication(
  storyId: number,
  renderedBlocks: Array<{ styleRef: string; text: string }>
): { steps: CommandStep[]; blocks: AppliedBlock[] } {
  const steps: CommandStep[] = [];
  const blocks: AppliedBlock[] = [];

  const encoder = new TextEncoder();
  let cursor = 0;

  renderedBlocks.forEach((block, i) => {
    const start = cursor;
    const end = cursor + encoder.encode(block.text).length;
    cursor = end;

    // Paragraph break between blocks (except after the last): one \n = 1 byte.
    const isLast = i === renderedBlocks.length - 1;
    if (!isLast) cursor += 1;

    blocks.push({ styleRef: block.styleRef, startByte: start, endByte: end });

    // Select the span, then apply the paragraph style with overrides cleared so
    // local formatting from an earlier pass cannot survive the rebind.
    steps.push({
      id: DC.TEXT_SELECT,
      params: { story: storyId, anchor: start, focus: end },
    });
    steps.push({
      id: DC.STYLE_PARA_APPLY,
      params: { name: block.styleRef, clearOverrides: true },
    });
  });

  return { steps, blocks };
}
