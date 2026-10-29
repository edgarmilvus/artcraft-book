// ---------------------------------------------------------------------------
// shape.ts — builds a shape layer rig with a two-phase trim-path animation.
// ---------------------------------------------------------------------------
import type { EffectCraftSession } from "./session.js";
import type { PropertyPathResolver } from "./resolver.js";
import type { EasingSpec } from "./contracts.js";

/** Result of building a shape rig, ready for keyframe emission. */
export interface ShapeRig {
  layer: number;
  /** Canonical paths resolved after construction. */
  paths: {
    trimStart: string;
    trimEnd: string;
    trimOffset: string;
    strokeWidth: string;
  };
}

/** A shape item as returned by `layer.addShapeItem`. */
interface ShapeItemRef {
  uid: number;
  path: string;
}

/**
 * Creates a stroked rectangle shape layer with a trim-path operator.
 *
 * @param session  Live MCP session.
 * @param resolver Path resolver, invalidated after construction.
 * @param opts     Geometry in composition pixels, plus paint.
 *
 * Construction notes:
 *  - The rectangle primitive is created WITHOUT a fill (`fill: null`) and
 *    with a stroke, because a filled rectangle would visually occlude its own
 *    trim animation. `kind: "rect"` on `layer.newShape` gives us the layer
 *    and the primitive in one command.
 *  - `layer.addShapeItem` with `kind: "stroke"` is unnecessary when
 *    `strokeWidth` is passed to the constructor, but we add it explicitly so
 *    the stroke is a *separate item* we can address and animate later.
 *  - The trim operator is added LAST so it applies to everything above it in
 *    the shape stack, which is the standard AE/EffectCraft operator ordering.
 */
export async function buildTrimmedRect(
  session: EffectCraftSession,
  resolver: PropertyPathResolver,
  opts: {
    name: string;
    position: [number, number];
    size: [number, number];
    strokeColor: string;
    strokeWidth: number;
    /** Corner radius; non-zero switches to the rounded variant. */
    cornerRadius?: number;
  },
): Promise<ShapeRig> {
  // One batch, one undo step: create the layer, append the stroke and the
  // trim operator, and hand back the trim operator's path. The `$1.layer`
  // interpolation syntax is what lets step 2 address the layer that step 1
  // just created, without a second round trip to read the reply.
  const created = await session.batch<Record<string, unknown>>(
    [
      {
        command: "layer.newShape",
        params: {
          kind: opts.cornerRadius ? "rounded" : "rect",
          name: opts.name,
          size: opts.size,
          fill: null,                       // stroke-only: no occlusion
          stroke: opts.strokeColor,
          strokeWidth: opts.strokeWidth,
          position: opts.position,
        },
      },
      {
        command: "layer.addShapeItem",
        params: { layer: "$1.layer", kind: "stroke" },
      },
      {
        command: "layer.addShapeItem",
        params: { layer: "$1.layer", kind: "trim" },
      },
    ],
    `Build shape rig: ${opts.name}`,
    /* atomic */ true,
  );

  const layerId = (created.results[0] as { layer: number }).layer;
  const trimItem = created.results[2] as unknown as ShapeItemRef;

  // The layer tree changed structurally; any previously cached paths for
  // this layer are stale. Invalidate before resolving.
  resolver.invalidate(layerId);

  // Resolve child properties BY NAME rather than by positional suffix. The
  // trim operator's children are named "Trim Start", "Trim End" and
  // "Trim Offset" in the engine's property tree; matching on those names
  // survives any future change to how `addShapeItem` numbers its children.
  const [trimStart, trimEnd, trimOffset] = await Promise.all([
    resolver.resolvePath(layerId, /^contents\/trim\/start$/i),
    resolver.resolvePath(layerId, /^contents\/trim\/end$/i),
    resolver.resolvePath(layerId, /^contents\/trim\/offset$/i),
  ]);

  // Sanity assertion: the resolved paths must live under the trim item we
  // just created. This catches the case where a template author has built a
  // shape with TWO trim operators and we have silently grabbed the wrong one.
  for (const p of [trimStart, trimEnd, trimOffset]) {
    if (!p.startsWith(`${trimItem.path}/`)) {
      throw new Error(
        `Resolved '${p}' does not belong to trim operator '${trimItem.path}'`,
      );
    }
  }

  const strokeWidth = await resolver.resolvePath(layerId, /^contents\/stroke\/width$/i);

  return {
    layer: layerId,
    paths: { trimStart, trimEnd, trimOffset, strokeWidth },
  };
}

/**
 * Emits the draw-on / retract-from-the-right trim animation.
 *
 * Phase 1 (0 → drawEnd):  Trim End   0% → 100%
 * Phase 2 (holdEnd):      nothing moves; the bar is fully drawn
 * Phase 3 (holdEnd → retractEnd): Trim Start 0% → 100%
 *
 * The counter-intuitive part is phase 3. Animating `Trim Start` upward
 * erases the *leading* portion of the path, so the visible remnant shrinks
 * from the right while its left edge remains anchored — the correct gesture
 * for a lower-third that has finished being read.
 */
export async function animateTrim(
  session: EffectCraftSession,
  rig: ShapeRig,
  timing: {
    drawStartMs: number;
    drawEndMs: number;
    retractStartMs: number;
    retractEndMs: number;
  },
  easing: { draw: EasingSpec; retract: EasingSpec },
  layerStart = 0,
): Promise<void> {
  const toSec = (ms: number) => layerStart + ms / 1000;

  await session.batch(
    [
      // ---- Phase 1: draw on. Two keys on Trim End. ----
      {
        command: "prop.addKey",
        params: {
          layer: rig.layer,
          path: rig.paths.trimEnd,
          time: toSec(timing.drawStartMs),
          value: 0,
        },
      },
      {
        command: "prop.addKey",
        params: {
          layer: rig.layer,
          path: rig.paths.trimEnd,
          time: toSec(timing.drawEndMs),
          value: 100,
        },
      },
      // ---- Phase 3: retract from the right, via Trim Start. ----
      {
        command: "prop.addKey",
        params: {
          layer: rig.layer,
          path: rig.paths.trimStart,
          time: toSec(timing.retractStartMs),
          value: 0,
        },
      },
      {
        command: "prop.addKey",
        params: {
          layer: rig.layer,
          path: rig.paths.trimStart,
          time: toSec(timing.retractEndMs),
          value: 100,
        },
      },
    ],
    "Trim path: draw and retract",
    /* atomic */ true,
  );

  // Fine-grained easing is applied AFTER the keys exist, because influence is
  // a property of a keyframe node, not of the request that created it. We set
  // the outgoing side of each leading key and the incoming side of each
  // trailing key, mirroring the segment/junction model from compileTrack().
  await session.batch(
    [
      {
        command: "keys.setEase",
        params: {
          layer: rig.layer,
          path: rig.paths.trimEnd,
          time: toSec(timing.drawStartMs),
          side: "out",
          influence: easeInfluence(easing.draw),
        },
      },
      {
        command: "keys.setEase",
        params: {
          layer: rig.layer,
          path: rig.paths.trimEnd,
          time: toSec(timing.drawEndMs),
          side: "in",
          influence: easeInfluence(easing.draw),
        },
      },
      {
        command: "keys.setEase",
        params: {
          layer: rig.layer,
          path: rig.paths.trimStart,
          time: toSec(timing.retractStartMs),
          side: "out",
          influence: easeInfluence(easing.retract),
        },
      },
      {
        command: "keys.setEase",
        params: {
          layer: rig.layer,
          path: rig.paths.trimStart,
          time: toSec(timing.retractEndMs),
          side: "in",
          influence: easeInfluence(easing.retract),
        },
      },
    ],
    "Trim path: easing",
    /* atomic */ true,
  );
}

/** Extracts a scalar influence from any easing spec, defaulting to 33.33%. */
function easeInfluence(e: EasingSpec): number {
  switch (e.kind) {
    case "linear":
    case "hold":
      return 0;
    case "easyEase":
    case "easyEaseIn":
    case "easyEaseOut":
      return 33.33;
    case "bezier":
      return 50;
    case "cubicBezier": {
      const x = e.p1x <= 1 / 3 ? (e.p1x / (1 / 3)) * 33.33 : 33.33 + ((e.p1x - 1 / 3) / (2 / 3)) * 66.67;
      return Math.min(100, Math.max(0, x));
    }
    default: {
      const never: never = e;
      throw new Error(`Unhandled easing: ${JSON.stringify(never)}`);
    }
  }
}
