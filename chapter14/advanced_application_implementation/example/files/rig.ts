// ---------------------------------------------------------------------------
// rig.ts — builds the parent hierarchy that the animated properties drive.
// ---------------------------------------------------------------------------
import type { EffectCraftSession } from "./session.js";

/** Identifiers for every node in the lower-third rig. */
export interface LowerThirdRig {
  compId: number | string;
  /** Master null: animating this slides the whole card. */
  master: number;
  /** Sub-null for the text column, so it can be nudged independently. */
  textColumn: number;
  eyebrow: number;
  headline: number;
  subhead: number;
  accentBar: number;
  /** The full-frame solid used as a subtle scrim behind the card. */
  scrim: number;
}

/** A layer creation reply, as returned by `layer.new*` commands. */
interface LayerCreated {
  layer: number;
}

/**
 * Builds the entire parenting topology in one atomic batch.
 *
 * Ordering matters and is enforced by the sequence below:
 *   1. The master null is created first and positioned at the card's origin.
 *   2. The sub-null is created and parented to the master.
 *   3. Content layers are created and parented to the appropriate null.
 *   4. The scrim is created LAST and sent to the back, so it never occludes
 *      the content during the brief window before `object.arrange` runs.
 *
 * Because the whole construction is one `batch` with `atomic: true`, a
 * failure at any step — a missing font, a malformed colour — rolls the
 * document back to its pre-rig state. There is no partially-built card.
 */
export async function buildLowerThirdRig(
  session: EffectCraftSession,
  opts: {
    originX: number;
    originY: number;
    cardWidth: number;
    primaryInk: string;
    accentColor: string;
    fontFamily: string;
    eyebrowText: string;
    headlineText: string;
    subheadText: string;
    scrimColor: string;
  },
): Promise<LowerThirdRig> {
  const result = await session.batch<LayerCreated | Record<string, unknown>>(
    [
      // --- 1. Master null ------------------------------------------------
      {
        command: "layer.newNull",
        params: { name: "RIG · Master" },
      },
      {
        command: "prop.set",
        params: {
          layer: "$1.layer",
          path: "transform/position",
          value: [opts.originX, opts.originY],
        },
      },

      // --- 2. Text-column sub-null ---------------------------------------
      {
        command: "layer.newNull",
        params: { name: "RIG · TextColumn" },
      },
      {
        command: "layer.setParent",
        params: { layers: ["$3.layer"], parent: "$1.layer" },
      },

      // --- 3a. Eyebrow (small caps label) --------------------------------
      {
        command: "layer.newText",
        params: {
          text: opts.eyebrowText,
          name: "TXT · Eyebrow",
          position: [0, -74],
          font: opts.fontFamily,
          size: 26,
          fill: opts.accentColor,
          tracking: 120,
          allCaps: true,
        },
      },
      {
        command: "layer.setParent",
        params: { layers: ["$5.layer"], parent: "$3.layer" },
      },

      // --- 3b. Headline ---------------------------------------------------
      {
        command: "layer.newText",
        params: {
          text: opts.headlineText,
          name: "TXT · Headline",
          position: [0, -8],
          font: opts.fontFamily,
          size: 92,
          fill: opts.primaryInk,
          leading: 100,
        },
      },
      {
        command: "layer.setParent",
        params: { layers: ["$7.layer"], parent: "$3.layer" },
      },

      // --- 3c. Subhead ----------------------------------------------------
      {
        command: "layer.newText",
        params: {
          text: opts.subheadText,
          name: "TXT · Subhead",
          position: [0, 52],
          font: opts.fontFamily,
          size: 38,
          fill: opts.primaryInk,
        },
      },
      {
        command: "prop.set",
        params: { layer: "$9.layer", path: "transform/opacity", value: 82 },
      },
      {
        command: "layer.setParent",
        params: { layers: ["$9.layer"], parent: "$3.layer" },
      },

      // --- 3d. Accent bar (parented to master, not the text column) -------
      {
        command: "layer.newShape",
        params: {
          kind: "rect",
          name: "SHAPE · AccentBar",
          size: [4, 132],
          fill: opts.accentColor,
          position: [-opts.cardWidth / 2 - 28, 0],
        },
      },
      {
        command: "layer.setParent",
        params: { layers: ["$12.layer"], parent: "$1.layer" },
      },

      // --- 4. Scrim solid, then arrange to the very back ------------------
      {
        command: "layer.newSolid",
        params: {
          name: "SOLID · Scrim",
          color: opts.scrimColor,
          width: 1920,
          height: 1080,
        },
      },
      {
        command: "prop.set",
        params: { layer: "$14.layer", path: "transform/opacity", value: 0 },
      },
      {
        command: "layer.arrange",
        params: { layers: ["$14.layer"], to: "back" },
      },
    ],
    "Rig: build lower-third topology",
    /* atomic */ true,
  );

  // The batch reply is index-aligned with the steps we sent. Extracting by
  // index rather than by searching the document is both faster and more
  // honest: it makes the coupling between step order and extraction explicit,
  // so reordering a step is a visible change rather than a silent one.
  const layerIdAt = (step: number): number =>
    (result.results[step] as unknown as LayerCreated).layer;

  return {
    compId: "active",
    master: layerIdAt(0),
    textColumn: layerIdAt(2),
    eyebrow: layerIdAt(4),
    headline: layerIdAt(6),
    subhead: layerIdAt(8),
    accentBar: layerIdAt(11),
    scrim: layerIdAt(13),
  };
}
