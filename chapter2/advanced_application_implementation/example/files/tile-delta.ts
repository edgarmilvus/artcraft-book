// ---------------------------------------------------------------------------
// @file creative-factory/tile-delta.ts
//
// Plans the minimal sequence of `command_batch` frames needed to realise a
// creative intent. A batch is NOT a transaction: every step is its own undo
// entry. What the planner buys is round-trips and ordering — and, because the
// doc model is a 256x256 sparse copy-on-write tile store, a snapshot cost
// proportional to the union of the tiles the steps touch.
//
// The intuition: a batch that edits N layers costs only the union of the
// tiles those layers actually touch, and the snapshot cost is proportional to
// the *number of changed tiles*, not to canvas area. So the planner's real job
// is to keep change-sets tight (never touch tiles unnecessarily) and to
// minimise frames (never split one intent into two batches).
// ---------------------------------------------------------------------------

import { CommandRegistry } from "./registry.js";

export interface PlanStep {
  id: string;
  params: Record<string, unknown>;
  /**
   * Ordering hint. Steps with a strictly greater `phase` never merge into an
   * earlier batch even if they are adjacent. Use phases for structural
   * rewrite boundaries (e.g. rasterize-then-transform).
   */
  phase?: number;
}

export interface BatchFrame {
  label: string;
  steps: PlanStep[];
  /** Estimated tile-cost, in tiles, of applying this frame. */
  estimatedTileCost: number;
}

/**
 * The planner. It is intentionally conservative: correctness (never emit a
 * step out of order) beats cleverness (merging everything into one frame).
 */
export class TileDeltaPlanner {
  /** Engine-side hard limit; EffectCraft caps batches and we honour the min. */
  static readonly MAX_STEPS_PER_FRAME = 512;

  constructor(private readonly registry: CommandRegistry) {}

  /**
   * Fold `steps` into frames. Steps are kept in the given order; the only
   * transformation is that the whole run is chopped at `MAX_STEPS_PER_FRAME`
   * boundaries and at phase transitions.
   */
  plan(intentLabel: string, steps: PlanStep[]): BatchFrame[] {
    if (steps.length === 0) return [];

    // 1. Validate every step against the registry. Fail fast, before any
    //    frame reaches the wire.
    for (const s of steps) this.registry.assertValid(s.id, s.params);

    // 2. Collapse trivially redundant consecutive mutations of the same
    //    command on the same target: e.g. two `layer.setProps {opacity}`
    //    calls on the same layer in a row. Only same-id, same-target,
    //    same-param-key sets are collapsed, because anything else risks
    //    altering semantics.
    const collapsed = this.collapseConsecutive(steps);

    // 3. Chop at phase boundaries and at size limits.
    const frames: BatchFrame[] = [];
    let current: PlanStep[] = [];
    let currentPhase = collapsed[0].phase ?? 0;

    const flush = () => {
      if (current.length === 0) return;
      frames.push({
        label: frames.length === 0 ? intentLabel : `${intentLabel} (cont'd ${frames.length})`,
        steps: current,
        estimatedTileCost: this.estimateTileCost(current),
      });
      current = [];
    };

    for (const s of collapsed) {
      const phase = s.phase ?? currentPhase;
      if (phase !== currentPhase || current.length === TileDeltaPlanner.MAX_STEPS_PER_FRAME) {
        flush();
        currentPhase = phase;
      }
      current.push(s);
    }
    flush();
    return frames;
  }

  /**
   * Heuristic tile-cost estimate. The engine's actual cost is only known at
   * apply time, but this is enough to catch pathological plans at planning
   * time (e.g. a full-canvas filter applied to every layer in a 200-layer doc).
   *
   * We classify steps coarsely:
   *   - structural (no pixels written)                -> 0
   *   - local pixel ops (paint strokes, small shapes) -> small
   *   - canvas-wide ops (filters, fills, adjustments) -> large
   */
  private estimateTileCost(steps: PlanStep[]): number {
    const COST_STRUCTURAL = 0;
    const COST_LOCAL = 4;      // ~2x2 tiles
    const COST_CANVAS_WIDE = 900; // ~30x30 tiles for a 6000x4000 canvas

    let total = 0;
    for (const s of steps) {
      const id = s.id;
      if (id.startsWith("layer.new.") || id.startsWith("object.group")) {
        total += COST_STRUCTURAL;
      } else if (
        id.startsWith("filter.") ||
        id.includes("AdjustmentLayer") ||
        id === "edit.fill" ||
        id === "image.trim"
      ) {
        total += COST_CANVAS_WIDE;
      } else {
        total += COST_LOCAL;
      }
    }
    return total;
  }

  private collapseConsecutive(steps: PlanStep[]): PlanStep[] {
    const out: PlanStep[] = [];
    for (const s of steps) {
      const prev = out[out.length - 1];
      if (
        prev &&
        prev.id === s.id &&
        prev.phase === s.phase &&
        this.sameTarget(prev.params, s.params)
      ) {
        // Overwrite: the later call wins for overlapping keys.
        out[out.length - 1] = { ...prev, ...s, params: { ...prev.params, ...s.params } };
      } else {
        out.push(s);
      }
    }
    return out;
  }

  /** Two param objects target the same thing iff their `layer`/`id` match. */
  private sameTarget(
    a: Record<string, unknown>,
    b: Record<string, unknown>,
  ): boolean {
    const ka = a.layer ?? a.id;
    const kb = b.layer ?? b.id;
    return ka !== undefined && ka === kb;
  }
}
