/**
 * layout-planner.ts
 * ---------------------------------------------------------------------------
 * Pure geometry. No MCP calls. Everything here is unit-testable in isolation,
 * which matters because a one-point error in a thread rectangle produces an
 * off-grid document that no amount of downstream cleverness can repair.
 */

import type { Artwork, GridSpec, Manuscript, Section } from "./contracts.js";

export type Rect = [x0: number, y0: number, x1: number, y1: number];

/** One page within a spread, in spread-space coordinates. */
export interface PageSlot {
  /** 1-based page number. */
  page: number;
  /** Left edge of the page in spread space. */
  x: number;
  width: number;
  /** Effective left/right margins for this page (mirrored for inside/outside). */
  marginLeft: number;
  marginRight: number;
  side: "verso" | "recto" | "single";
}

/**
 * Enumerate the pages on a spread.
 *
 * Convention (trade book, left-to-right binding):
 *   spread 0 → page 1 alone, on the recto (right-hand) side, x = 0.
 *   spread n → verso = page 2n, recto = page 2n + 1.
 *
 * For a non-facing document every "spread" is a single full-width page.
 */
export function pageSlots(grid: GridSpec, spread: number): PageSlot[] {
  const W = grid.pageWidthPt;
  const M = grid.margins;

  if (!grid.facingPages) {
    return [
      {
        page: spread + 1,
        x: 0,
        width: W,
        marginLeft: M.outside,
        marginRight: M.outside,
        side: "single",
      },
    ];
  }

  if (spread === 0) {
    // Recto-only opening spread. Inside margin is on the left of this page.
    return [
      {
        page: 1,
        x: 0,
        width: W,
        marginLeft: M.inside,
        marginRight: M.outside,
        side: "recto",
      },
    ];
  }

  const versoPage = 2 * spread; // even → left-hand
  const rectoPage = 2 * spread + 1; // odd  → right-hand

  return [
    {
      page: versoPage,
      x: 0,
      width: W,
      marginLeft: M.outside, // outer edge of the book
      marginRight: M.inside, // gutter side
      side: "verso",
    },
    {
      page: rectoPage,
      x: W,
      width: W,
      marginLeft: M.inside, // gutter side
      marginRight: M.outside, // outer edge
      side: "recto",
    },
  ];
}

/* -------------------------------------------------------------------------- */
/* Column geometry                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Vertical extents of the text block, snapped to the baseline grid.
 *
 * The block is anchored to the top margin and grows downward in whole grid
 * increments. Snapping the *bottom* rather than the top guarantees that every
 * text frame's baseline set begins at the same absolute y across the document,
 * which is what makes a cross-spread spread read as a single plane.
 */
export function textBand(grid: GridSpec): { top: number; bottom: number; height: number } {
  const top = snapUp(grid.margins.top + grid.textTopOffsetPt, grid.baselinePt);
  const rawBottom = grid.pageHeightPt - grid.margins.bottom - grid.textBottomInsetPt;
  const bottom = snapDown(rawBottom, grid.baselinePt);
  return { top, bottom, height: bottom - top };
}

/**
 * Spread-space rectangle for column `col` of `cols` on `slot`.
 * Includes a half-gutter inset on each interior edge so that visually the
 * gutter appears as `gutterPt` and the outer edges align to the margins.
 */
export function columnRect(
  slot: PageSlot,
  grid: GridSpec,
  col: number,
  cols: number = grid.columns
): Rect {
  const band = textBand(grid);
  const usable = slot.width - slot.marginLeft - slot.marginRight;
  const gutters = (cols - 1) * grid.gutterPt;
  const colWidth = (usable - gutters) / cols;

  const x0 = slot.x + slot.marginLeft + col * (colWidth + grid.gutterPt);
  const x1 = x0 + colWidth;

  return [round(x0), round(band.top), round(x1), round(band.bottom)];
}

/** Convenience: the full-width single-column rect for a whole page. */
export function fullPageTextRect(slot: PageSlot, grid: GridSpec): Rect {
  const band = textBand(grid);
  return [
    round(slot.x + slot.marginLeft),
    round(band.top),
    round(slot.x + slot.width - slot.marginRight),
    round(band.bottom),
  ];
}

/* -------------------------------------------------------------------------- */
/* Artwork slots                                                              */
/* -------------------------------------------------------------------------- */

export interface ArtworkPlacement {
  label: string;
  spread: number;
  rect: Rect;
  /** Whether the planner expects the art to break the outer margin. */
  bleeds: boolean;
}

/**
 * Compute the rectangle for each artwork item, honouring its declared slot.
 *
 * The planner reserves these rectangles from the *same* grid as text, which is
 * why the caller must create art frames BEFORE threading body copy around them.
 * Text wrap in DesignCraft is a property of the *wrap object*, not of the text
 * frame, so a frame created after the story flows simply will not participate
 * in the wrap.
 */
export function planArtwork(m: Manuscript): ArtworkPlacement[] {
  const placements: ArtworkPlacement[] = [];
  const grid = m.grid;
  const band = textBand(grid);

  let runningSpread = 0;

  for (const art of m.artwork) {
    const slots = pageSlots(grid, runningSpread);
    const slot = slots[slots.length - 1]; // prefer the recto
    if (!slot) throw new Error("layout: the spread has no page slot");

    let rect: Rect;
    let bleeds = false;

    switch (art.slot) {
      case "opening": {
        // Half-page art at the top of the recto, above the text band start.
        const h = snapDown(band.height * 0.45, grid.baselinePt);
        rect = [
          round(slot.x + slot.marginLeft),
          round(slot.x === 0 ? band.top : band.top),
          round(slot.x + slot.width - slot.marginRight),
          round(band.top + h),
        ];
        break;
      }
      case "full-bleed": {
        // Edge to edge, including the bleed outside the trim.
        bleeds = true;
        const b = grid.bleedPt;
        rect = [
          round(slot.x - b),
          round(-b),
          round(slot.x + slot.width + b),
          round(grid.pageHeightPt + b),
        ];
        break;
      }
      case "sidebar": {
        // Outer column of a two-column grid.
        rect = columnRect(slot, { ...grid, columns: 2 }, 1, 2);
        break;
      }
      case "run-in-half":
      default: {
        const h = snapDown(band.height * 0.35, grid.baselinePt);
        rect = [
          round(slot.x + slot.marginLeft),
          round(band.top + grid.baselinePt * 4),
          round(slot.x + slot.width - slot.marginRight),
          round(band.top + grid.baselinePt * 4 + h),
        ];
        break;
      }
    }

    placements.push({ label: art.label, spread: runningSpread, rect, bleeds });
    runningSpread = Math.min(runningSpread + 1, 64);
  }

  return placements;
}

/* -------------------------------------------------------------------------- */
/* Section → thread plan                                                      */
/* -------------------------------------------------------------------------- */

export interface ThreadFramePlan {
  spread: number;
  rect: Rect;
  page: number;
}

/**
 * Plan the frame chain for one section.
 *
 * A section begins on a recto when `startOnRecto` is set. We consume spreads
 * from `startSpread`, emitting one frame per column per page. The ThreadEngine
 * then links them in order. Frame count is deliberately generous: overset
 * frames cost nothing (they are simply not created if the story fits earlier),
 * whereas a missing frame produces silent text loss.
 */
export function planSectionThread(
  grid: GridSpec,
  section: Section,
  startSpread: number,
  estimatedFrames: number
): ThreadFramePlan[] {
  const frames: ThreadFramePlan[] = [];

  // A recto start means the section's first page number is odd.
  let spread =
    section.startOnRecto && startSpread % 2 === 0 ? startSpread + 1 : startSpread;

  while (frames.length < estimatedFrames) {
    for (const slot of pageSlots(grid, spread)) {
      for (let col = 0; col < grid.columns; col++) {
        if (frames.length >= estimatedFrames) break;
        frames.push({
          spread,
          page: slot.page,
          rect: columnRect(slot, grid, col),
        });
      }
    }
    spread += 1;
  }

  return frames;
}

/* -------------------------------------------------------------------------- */
/* Numeric helpers                                                            */
/* -------------------------------------------------------------------------- */

export function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

export function snapUp(value: number, quantum: number): number {
  return round(Math.ceil(value / quantum) * quantum);
}

export function snapDown(value: number, quantum: number): number {
  return round(Math.floor(value / quantum) * quantum);
}
