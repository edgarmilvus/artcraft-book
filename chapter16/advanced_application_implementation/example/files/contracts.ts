/**
 * contracts.ts
 * ---------------------------------------------------------------------------
 * Wire format for the Editorial Publishing Service.
 *
 * A "manuscript" is the complete, self-describing input to a publish job. It is
 * deliberately *not* an intermediate representation of a DesignCraft document —
 * it is a specification of intent. The LayoutPlanner turns intent into
 * geometry; the TypographyBinder turns intent into named styles; the
 * ThreadEngine turns intent into a linked frame graph.
 */

import { z } from "zod";

/* -------------------------------------------------------------------------- */
/* 1. Colour                                                                   */
/* -------------------------------------------------------------------------- */

/** A CMYK ink separation in percent. Print work never round-trips through RGB. */
export const CmykSchema = z.object({
  c: z.number().min(0).max(100),
  m: z.number().min(0).max(100),
  y: z.number().min(0).max(100),
  k: z.number().min(0).max(100),
});

export const SwatchSchema = z.object({
  name: z.string().min(1),
  cmyk: CmykSchema,
  /** Spot inks get their own plate in preflight and in the PDF output intent. */
  spot: z.boolean().default(false),
});

/* -------------------------------------------------------------------------- */
/* 2. Typography                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Character-level specification.
 *
 * `leading` is expressed in points and is *also* the vertical quantum for the
 * baseline grid. The TypographyBinder asserts `leading % gridIncrement === 0`
 * before it ever writes a style, because a leading that does not divide the
 * grid produces drifted baselines on every page after the first.
 */
export const CharacterSpecSchema = z.object({
  fontFamily: z.string().min(1),
  fontStyle: z.string().default("Regular"),
  size: z.number().positive(),
  leading: z.number().positive(),
  tracking: z.number().default(0),
  kerning: z.union([z.literal("metrics"), z.literal("optical"), z.number()]).optional(),
  baselineShift: z.number().default(0),
  fill: z.string().default("Body Text"),
  capitalization: z.enum(["none", "allCaps", "smallCaps"]).default("none"),
  /** OpenType feature tags to enable (e.g. "liga", "onum", "frac"). */
  features: z.array(z.string()).default([]),
});

/**
 * Paragraph-level specification.
 *
 * `composer` is the Knuth-Plass switch:
 *   - "paragraph"  → Adobe Paragraph Composer semantics: global optimum across
 *                    the whole paragraph, using dynamic programming over a
 *                    badness/penalty model with a hyphenation ladder.
 *   - "singleLine" → greedy first-fit, one line at a time (the legacy path).
 * Editorial body copy must use "paragraph"; it is the entire reason the
 * hyphenation dictionary below matters.
 */
export const ParagraphSpecSchema = z.object({
  basedOn: z.string().nullable().default(null),
  /** Style applied to the *next* paragraph — drives heading → body flow. */
  nextStyle: z.string().nullable().default(null),
  align: z
    .enum(["left", "center", "right", "leftJustified", "centerJustified", "rightJustified", "justifyAll"])
    .default("leftJustified"),
  leftIndent: z.number().default(0),
  rightIndent: z.number().default(0),
  firstLineIndent: z.number().default(0),
  spaceBefore: z.number().default(0),
  spaceAfter: z.number().default(0),
  dropCapLines: z.number().int().min(0).default(0),
  hyphenate: z.boolean().default(true),
  composer: z.enum(["paragraph", "singleLine"]).default("paragraph"),
  keepWithNext: z.boolean().default(false),
  keepLinesTogether: z.boolean().default(false),
  /** Absolute tab stops in points, measured from the frame's left inset. */
  tabs: z.array(z.number()).default([]),
});

/** One named style in the manuscript. */
export const StyleSpecSchema = z.object({
  name: z.string().min(1),
  chars: CharacterSpecSchema,
  para: ParagraphSpecSchema,
  /** Which HTML tag this style maps to on export (h1…h6, p, blockquote, aside). */
  exportTag: z.string().default("p"),
  /** CSS class emitted to EPUB/HTML. Defaults to a slug of `name`. */
  exportClass: z.string().optional(),
});

/* -------------------------------------------------------------------------- */
/* 3. Grid + page geometry                                                     */
/* -------------------------------------------------------------------------- */

export const GridSpecSchema = z.object({
  pageWidthPt: z.number().positive(),
  pageHeightPt: z.number().positive(),
  margins: z.object({
    top: z.number().nonnegative(),
    bottom: z.number().nonnegative(),
    inside: z.number().nonnegative(),
    outside: z.number().nonnegative(),
  }),
  columns: z.number().int().min(1).max(12).default(1),
  gutterPt: z.number().nonnegative().default(12),
  /** Vertical rhythm quantum in points. Must equal the body style's leading. */
  baselinePt: z.number().positive(),
  bleedPt: z.number().nonnegative().default(9),
  slugPt: z.number().nonnegative().default(9),
  facingPages: z.boolean().default(true),
  /** Offset from the top margin to the first text frame, in points. */
  textTopOffsetPt: z.number().default(0),
  /** Space reserved below the last text frame (folio / footer zone). */
  textBottomInsetPt: z.number().default(24),
});

/* -------------------------------------------------------------------------- */
/* 4. Artwork + placement                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Art is placed by *label*, never by coordinates. The LayoutPlanner computes a
 * rectangle for the label from the grid; the ArtworkPlacer fills it. This keeps
 * the manuscript portable across trim sizes.
 */
export const ArtworkSchema = z.object({
  label: z.string().min(1),
  /** Relative to the automation read root. */
  path: z.string().min(1),
  altText: z.string().default(""),
  caption: z.string().optional(),
  fit: z.enum(["fillProportionally", "fitProportionally", "fitContentToFrame", "centerContent"]).default("fitProportionally"),
  /** Text wrap around this frame. */
  wrap: z.enum(["none", "boundingBox", "contour", "jumpObject"]).default("boundingBox"),
  wrapOffsetPt: z.number().default(9),
  /** "inline" keeps the art in the story flow; "float" anchors it to the page. */
  anchoring: z.enum(["inline", "float"]).default("float"),
  /** Where the planner should reserve space. */
  slot: z.enum(["opening", "run-in-half", "full-bleed", "sidebar"]).default("run-in-half"),
});

/* -------------------------------------------------------------------------- */
/* 5. Structure                                                                */
/* -------------------------------------------------------------------------- */

export const SectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  /** Paragraph style name used for the section head. */
  headStyle: z.string().default("Headline 1"),
  /** Named running-header variable to install for this section. */
  runningHead: z.string().optional(),
  /** Force a recto (right-hand) page start — standard for chapter openers. */
  startOnRecto: z.boolean().default(true),
  /** Roman numerals for front matter, arabic numerals for body. */
  numbering: z
    .object({
      style: z.enum(["arabic", "upperRoman", "lowerRoman", "upperLetters", "lowerLetters", "arabicLeadingZero", "symbols"]).default("arabic"),
      startAt: z.number().int().positive().default(1),
      prefix: z.string().default(""),
    })
    .default({ style: "arabic", startAt: 1, prefix: "" }),
  /** Paragraphs of the section body, in order. `styleRef` names a StyleSpec. */
  blocks: z
    .array(
      z.object({
        styleRef: z.string(),
        text: z.string(),
        /** Optional pull-quote / sidebar keyed to an artwork label. */
        artworkRef: z.string().optional(),
      })
    )
    .default([]),
});

export const ManuscriptSchema = z.object({
  jobId: z.string().min(1),
  title: z.string().min(1),
  author: z.string().default(""),
  language: z.string().default("en-US"),
  grid: GridSpecSchema,
  swatches: z.array(SwatchSchema).default([]),
  styles: z.array(StyleSpecSchema).min(1),
  sections: z.array(SectionSchema).min(1),
  artwork: z.array(ArtworkSchema).default([]),
  /** Hyphenation overrides — "ex-am-ple" forces a break, "WordPress" forbids one. */
  hyphenationExceptions: z.array(z.string()).default([]),
  /** Words the spell checker should accept without flagging. */
  userDictionary: z.array(z.string()).default([]),
  /** Glossary entries → auto-generated cross-references. */
  glossary: z.array(z.object({ term: z.string(), definition: z.string() })).default([]),
  export: z
    .object({
      pdfStandard: z.enum(["none", "x4", "a2b"]).default("x4"),
      /** Flattening strategy if the PDF engine must rasterise live effects. */
      flatten: z.enum(["high", "medium", "low", "ppi"]).default("high"),
      bleed: z.boolean().default(true),
      marks: z.boolean().default(true),
      tagged: z.boolean().default(true),
      emitEpub: z.boolean().default(true),
      emitHtml: z.boolean().default(true),
      emitIdml: z.boolean().default(false),
      emitContactSheet: z.boolean().default(true),
    })
    .default({
      pdfStandard: "x4",
      flatten: "high",
      bleed: true,
      marks: true,
      tagged: true,
      emitEpub: true,
      emitHtml: true,
      emitIdml: false,
      emitContactSheet: true,
    }),
});

export type Cmyk = z.infer<typeof CmykSchema>;
export type Swatch = z.infer<typeof SwatchSchema>;
export type CharacterSpec = z.infer<typeof CharacterSpecSchema>;
export type ParagraphSpec = z.infer<typeof ParagraphSpecSchema>;
export type StyleSpec = z.infer<typeof StyleSpecSchema>;
export type GridSpec = z.infer<typeof GridSpecSchema>;
export type Artwork = z.infer<typeof ArtworkSchema>;
export type Section = z.infer<typeof SectionSchema>;
export type Manuscript = z.infer<typeof ManuscriptSchema>;
