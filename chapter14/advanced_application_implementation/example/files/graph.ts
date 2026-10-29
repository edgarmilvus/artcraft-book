// ---------------------------------------------------------------------------
// graph.ts — lowering authored easing onto EffectCraft's value graph.
// ---------------------------------------------------------------------------
import type { EasingSpec, KeyframeSpec } from "./contracts.js";

/** Engine-level interpolation identifiers, mirroring the runtime schema. */
type EngineInterpolation =
  | "linear"
  | "bezier"
  | "hold"
  | "easyEase"
  | "easyEaseIn"
  | "easyEaseOut";

/** What one side of a key needs. `null` means "leave the node alone". */
interface SideEase {
  interpolation: EngineInterpolation;
  /** Percent, 0–100. Omitted when the interpolation carries its own shape. */
  influence?: number;
  /** Units/second. Omitted unless the author asked for an explicit ramp. */
  speed?: number;
}

/**
 * Converts a cubic-Bezier control pair into an EffectCraft influence value.
 *
 * EffectCraft expresses a Bezier handle as a *percentage of the segment*
 * rather than as an absolute control point. The geometric intuition: a
 * handle that reaches 33.33% along the segment reproduces the classic
 * "easy ease" look; a handle reaching 75% produces a much flatter, slower
 * ramp. We map the horizontal component of each control point directly,
 * because that is the dimension that governs *timing* — the vertical
 * component governs *magnitude*, which the keyframe values already encode.
 *
 * @param x  Horizontal control-point coordinate, already validated to [0,1].
 * @returns  Influence in percent, clamped to the engine's representable band.
 */
function controlPointToInfluence(x: number): number {
  // Piecewise-linear remap from CSS control space to influence space.
  // Below 1/3 we compress (fast starts need small influences to stay crisp);
  // above 1/3 we expand toward the engine's practical ceiling of 100%.
  const influence = x <= 1 / 3 ? (x / (1 / 3)) * 33.33 : 33.33 + ((x - 1 / 3) / (2 / 3)) * 66.67;
  return Math.min(100, Math.max(0, influence));
}

/**
 * Lowers one authored easing into engine interpolation params.
 *
 * `exhaustive` switches over the discriminated union mean that adding a new
 * easing variant to the contract is a *compile error* here, not a silent
 * fall-through to linear at runtime. That guarantee is the entire reason
 * `EasingSpec` is modelled as a discriminated union rather than as a bag of
 * optional numbers.
 */
function lowerEasing(easing: EasingSpec): SideEase {
  switch (easing.kind) {
    case "linear":
      return { interpolation: "linear" };

    case "hold":
      return { interpolation: "hold" };

    case "bezier":
      return { interpolation: "bezier" };

    case "easyEase":
      return { interpolation: "easyEase", influence: 33.33 };

    case "easyEaseIn":
      return { interpolation: "easyEaseIn", influence: 33.33 };

    case "easyEaseOut":
      return { interpolation: "easyEaseOut", influence: 33.33 };

    case "cubicBezier": {
      // The outgoing ramp is governed by the FIRST control point; the
      // incoming ramp by the SECOND. That asymmetry is why a single CSS
      // curve produces two different engine calls per key.
      const outInfluence = controlPointToInfluence(easing.p1x);
      const inInfluence = controlPointToInfluence(1 - easing.p2x);
      return {
        interpolation: "bezier",
        influence: (outInfluence + inInfluence) / 2,
      };
    }

    /* istanbul ignore next — unreachable thanks to exhaustive checking */
    default: {
      const never: never = easing;
      throw new Error(`Unhandled easing: ${JSON.stringify(never)}`);
    }
  }
}

/**
 * Compiled form of one property's animation, ready for emission.
 */
export interface CompiledTrack {
  path: string;
  engineInterpolation: EngineInterpolation;
  keys: Array<{ time: number; value: unknown }>;
  /** Per-key, per-side fine control applied after the keys exist. */
  eases: Array<{
    time: number;
    side: "in" | "out";
    influence: number;
    speed?: number | undefined;
    interpolation: EngineInterpolation;
  }>;
}

/**
 * Compiles an authored keyframe list for one property into a {@link CompiledTrack}.
 *
 * @param path      Canonical engine path, supplied by PropertyPathResolver.
 * @param frames    Authored keys, times already in milliseconds.
 * @param layerStart Layer in-point in seconds; authored times are relative.
 * @param timingScale Multiplier for tempo control (1 = as authored).
 */
export function compileTrack(
  path: string,
  frames: readonly KeyframeSpec[],
  layerStart: number,
  timingScale = 1,
): CompiledTrack {
  if (frames.length === 0) {
    throw new Error(`compileTrack(${path}) received no keyframes`);
  }

  // Authored order is not guaranteed; sort defensively. A duplicate time is
  // a hard authoring error — two keys at the same instant are ambiguous in
  // every evaluator, so we refuse rather than pick arbitrarily.
  const sorted = [...frames].sort((a, b) => a.atMs - b.atMs);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i]?.atMs === sorted[i - 1]?.atMs) {
      throw new Error(`Duplicate keyframe time ${sorted[i]?.atMs}ms on ${path}`);
    }
  }

  const keys = sorted.map((k) => ({
    time: layerStart + (k.atMs / 1000) * timingScale,
    value: k.value,
  }));

  // The track's coarse interpolation is taken from the FIRST key's outgoing
  // easing. It is only a starting point: the per-key pass below refines each
  // side individually, which is what actually produces the intended curve.
  const first = lowerEasing(sorted[0]!.out);

  const eases: CompiledTrack["eases"] = [];
  sorted.forEach((k, i) => {
    const time = layerStart + (k.atMs / 1000) * timingScale;

    // Outgoing side: governed by THIS key's `out` spec, ignored on the last key.
    if (i < sorted.length - 1) {
      const out = lowerEasing(k.out);
      eases.push({
        time,
        side: "out",
        influence: out.influence ?? 33.33,
        speed: out.speed,
        interpolation: out.interpolation,
      });
    }

    // Incoming side: governed by THIS key's `in` spec, ignored on the first key.
    if (i > 0) {
      const incoming = lowerEasing(k.in);
      eases.push({
        time,
        side: "in",
        influence: incoming.influence ?? 33.33,
        speed: incoming.speed,
        interpolation: incoming.interpolation,
      });
    }
  });

  return {
    path,
    engineInterpolation: first.interpolation,
    keys,
    eases,
  };
}
