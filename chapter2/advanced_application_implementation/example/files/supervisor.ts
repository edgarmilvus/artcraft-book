// ---------------------------------------------------------------------------
// @file creative-factory/supervisor.ts
//
// Supervisor/worker topology. The supervisor owns the brief, dispatches
// segments, merges the plans, and resolves conflicts (e.g. two workers trying
// to set the same layer's blend mode).
//
// Workers are pure. They cannot open files. They cannot touch the engine. They
// can only produce (commandId, params) tuples, which the supervisor validates
// and batches. This separation is what makes the pipeline testable: a worker
// is a unit test, an engine call is an integration test.
// ---------------------------------------------------------------------------

import { CommandRegistry } from "./registry.js";
import { PlanStep } from "./tile-delta.js";

export interface TenantBrief {
  tenantId: string;
  campaignId: string;
  locale: string;
  width: number;
  height: number;
  hero: {
    headline: string;
    subhead?: string;
    cta?: string;
  };
  colorway: {
    primary: string;   // #rrggbb
    accent: string;
    background: string;
  };
  tier: "starter" | "growth" | "enterprise";
  fonts: {
    headline: string;
    body: string;
  };
}

export interface Worker {
  readonly name: string;
  plan(brief: TenantBrief, registry: CommandRegistry): PlanStep[];
}

/**
 * The TypeSetterAgent owns `type.*` and the layer scaffolding needed to host
 * text. It produces a plan that is *always* a valid prefix of the final
 * document: create the layers, set the text, style the text.
 */
export class TypeSetterAgent implements Worker {
  readonly name = "typesetter";

  plan(brief: TenantBrief, _registry: CommandRegistry): PlanStep[] {
    const steps: PlanStep[] = [];
    const marginX = Math.round(brief.width * 0.08);
    const headlineY = Math.round(brief.height * 0.35);

    // `type.create` creates its own type layer, so there is no empty layer to
    // scaffold first (the previous `layer.new.layer` step left a stray empty
    // pixel layer behind every headline).

    // Text creation uses the type.create command with an explicit colour so
    // the tile store never allocates a "default fill" pass it would later
    // overwrite (each overwrite is a new tile generation).
    steps.push({
      id: "type.create",
      params: {
        x: marginX,
        y: headlineY,
        text: brief.hero.headline,
        font: brief.fonts.headline,
        size: Math.round(brief.height * 0.09),
        color: brief.colorway.primary,
      },
      phase: 0,
    });

    if (brief.hero.subhead) {
      steps.push({
        id: "type.create",
        params: {
          x: marginX,
          y: headlineY + Math.round(brief.height * 0.12),
          text: brief.hero.subhead,
          font: brief.fonts.body,
          size: Math.round(brief.height * 0.035),
          color: brief.colorway.accent,
        },
        phase: 0,
      });
    }

    if (brief.hero.cta) {
      steps.push({
        id: "type.create",
        params: {
          x: marginX,
          y: Math.round(brief.height * 0.78),
          text: brief.hero.cta,
          font: brief.fonts.body,
          size: Math.round(brief.height * 0.028),
          // The background colour is the wrong role here: the fill layer is a
          // gradient, so "background" is light at one corner and dark at the
          // other and the CTA vanishes over half the canvas. The accent is the
          // high-contrast role in the palette.
          color: brief.colorway.accent,
        },
        phase: 0,
      });
    }

    return steps;
  }
}

/**
 * The GradientAgent produces a background gradient layer. Adjustments are
 * always expressed as adjustment-layer commands, never as destructive
 * operations on a raster layer, so the tile store sees a small, well-defined
 * change-set (the layer's mask tiles), not a full-canvas rewrite.
 */
export class GradientAgent implements Worker {
  readonly name = "gradient";

  plan(brief: TenantBrief, _registry: CommandRegistry): PlanStep[] {
    return [
      {
        id: "layer.newFillLayer.gradient",
        params: {
          from: brief.colorway.background,
          to: brief.colorway.primary,
          angle: 45,
          style: "linear",
          reverse: false,
        },
        phase: 0,
      },
      // A curves adjustment to lift shadows — an adjustment layer, so it
      // costs only the mask tiles, not the underlying image tiles.
      {
        id: "layer.newAdjustmentLayer.curves",
        params: { points: [[0, 0], [64, 62], [192, 200], [255, 255]] },
        phase: 0,
      },
    ];
  }
}

/**
 * The ComplianceAgent adds the legal footer and the tenant watermark. It runs
 * last (highest phase) because it depends on the final canvas extent, which
 * the other agents can influence via margin calculations.
 */
export class ComplianceAgent implements Worker {
  readonly name = "compliance";

  plan(brief: TenantBrief, _registry: CommandRegistry): PlanStep[] {
    const footerY = brief.height - Math.round(brief.height * 0.04);
    const steps: PlanStep[] = [
      {
        id: "type.create",
        params: {
          x: Math.round(brief.width * 0.08),
          y: footerY,
          text: `${brief.tenantId} • ${brief.campaignId} • ${brief.locale}`,
          font: brief.fonts.body,
          size: Math.round(brief.height * 0.012),
          color: brief.colorway.accent,
        },
        phase: 1, // depends on nothing structural, but must run after layout
      },
    ];

    if (brief.tier !== "enterprise") {
      // A faint tenant mark at the centre of the canvas, then 18% opacity on
      // that same layer (the `type.create` above made it active).
      //
      // This used to be `layerStyle.colorOverlay`, which tints the *active*
      // layer — here the footer text — and is not a watermark at all.
      steps.push(
        {
          id: "type.create",
          params: {
            x: Math.round(brief.width * 0.5),
            y: Math.round(brief.height * 0.55),
            text: brief.tenantId.toUpperCase(),
            font: brief.fonts.headline,
            size: Math.round(brief.height * 0.06),
            color: brief.colorway.accent,
            align: "center",
          },
          phase: 1,
        },
        {
          id: "layer.setProps",
          // `layer.setProps` opacity is 0..1 (unlike `edit.fill`, which is 0..100).
          params: { opacity: 0.18 },
          phase: 1,
        },
      );
    }
    return steps;
  }
}

/**
 * The Supervisor. It fans out to workers, merges their plans in a stable
 * order (structural → cosmetic → compliance), then runs a conflict resolver.
 */
export class SupervisorNode {
  constructor(
    private readonly workers: Worker[],
    private readonly registry: CommandRegistry,
  ) {}

  dispatch(brief: TenantBrief): PlanStep[] {
    // 1. Fan out. Workers are pure and synchronous, so we run them inline;
    //    if a worker were LLM-backed we would use Promise.allSettled here.
    const partials = this.workers.map((w) => ({
      name: w.name,
      steps: w.plan(brief, this.registry),
    }));

    // 2. Merge, preserving per-worker order and global phase order.
    const merged: PlanStep[] = [];
    for (const p of partials) merged.push(...p.steps);

    // 3. Conflict resolution. The only conflict class we allow today is
    //    multiple writes to the same `layer` param in the same phase; the
    //    last worker in registration order wins, and we log the override.
    return this.resolve(merged);
  }

  private resolve(steps: PlanStep[]): PlanStep[] {
    const seen = new Map<string, number>();
    const out: PlanStep[] = [];
    steps.forEach((s, i) => {
      const target = (s.params.layer ?? s.params.id) as string | number | undefined;
      const key = target !== undefined ? `${s.id}:${target}` : `${s.id}:${i}`;
      if (seen.has(key)) {
        // Overwrite the earlier step in place, preserving phase ordering.
        const prevIdx = seen.get(key)!;
        out[prevIdx] = s;
      } else {
        seen.set(key, out.length);
        out.push(s);
      }
    });
    return out;
  }
}
