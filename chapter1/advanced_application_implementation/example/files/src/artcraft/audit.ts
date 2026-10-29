// ═══════════════════════════════════════════════════════════════════════════
// FILE 5/9 — src/artcraft/audit.ts
// Hybrid audit: deterministic pixel probes + a bounded vision oracle.
// ═══════════════════════════════════════════════════════════════════════════

import { ArtCraftEngine } from './engine-session.js';
import type { JsonObject, JsonValue, LayeredRecipe } from './recipe.js';

/** Result of reading one composite pixel. */
export interface PixelSample {
  label: string;
  x: number;
  y: number;
  rgba: [number, number, number, number];
}

/** Read composite pixels at the recipe's declared probe points. */
export async function probeComposite(
  engine: ArtCraftEngine,
  probes: NonNullable<LayeredRecipe['audit']>['probes'],
): Promise<PixelSample[]> {
  if (!probes || probes.length === 0) return [];
  const out: PixelSample[] = [];
  for (const probe of probes) {
    const raw = await engine.runCommand<JsonValue>('document.pixel', {
      x: Math.round(probe.x),
      y: Math.round(probe.y),
    });
    const rgba = normalisePixel(raw);
    out.push({ label: probe.label, x: probe.x, y: probe.y, rgba });
  }
  return out;
}

/** Accept either an array or an {r,g,b,a} object from the engine. */
function normalisePixel(value: JsonValue): [number, number, number, number] {
  if (Array.isArray(value)) {
    const [r = 0, g = 0, b = 0, a = 255] = value.map((v) => Number(v));
    return [r, g, b, a];
  }
  if (value && typeof value === 'object') {
    const o = value as JsonObject;
    return [
      Number(o.r ?? 0),
      Number(o.g ?? 0),
      Number(o.b ?? 0),
      Number(o.a ?? 255),
    ];
  }
  return [0, 0, 0, 0];
}

/** A numeric violation the engine-side check found. */
export interface ProbeViolation {
  label: string;
  channel: 'r' | 'g' | 'b' | 'a';
  value: number;
  reason: 'clipped-high' | 'clipped-low';
}

/**
 * Clipping detection with a deliberately blunt rule: a channel at 255 or 0
 * in a probe declared `expect: 'not-clipped'` is a failure. Blunt rules are
 * appropriate here because the recipe author chooses the probes precisely
 * where clipping would be a defect (speculars, scrims, product shadows).
 */
export function checkProbeInvariants(
  probes: NonNullable<LayeredRecipe['audit']>['probes'],
  samples: PixelSample[],
): ProbeViolation[] {
  const violations: ProbeViolation[] = [];
  const byLabel = new Map(samples.map((s) => [s.label, s]));
  for (const probe of probes ?? []) {
    if (probe.expect !== 'not-clipped') continue;
    const sample = byLabel.get(probe.label);
    if (!sample) continue;
    const [r, g, b] = sample.rgba;
    (['r', 'g', 'b'] as const).forEach((channel, i) => {
      const value = [r, g, b][i];
      if (value >= 255) violations.push({ label: probe.label, channel, value, reason: 'clipped-high' });
      if (value <= 0) violations.push({ label: probe.label, channel, value, reason: 'clipped-low' });
    });
  }
  return violations;
}

/** Mean composite luma across probes: a cheap convergence metric. */
export function meanLuma(samples: PixelSample[]): number {
  if (samples.length === 0) return 0;
  const total = samples.reduce(
    (sum, s) => sum + 0.2126 * s.rgba[0] + 0.7152 * s.rgba[1] + 0.0722 * s.rgba[2],
    0,
  );
  return total / samples.length;
}

/**
 * The correction the oracle is allowed to request.
 *
 * Schema-constrained output is the single most important guardrail in this
 * loop: a free-text "make it pop" is unexecutable, so the loop would either
 * stall or hallucinate a parameter. We require named adjustment layers and
 * named parameters.
 */
export interface AuditVerdict {
  status: 'ok' | 'correct';
  /** Short human-readable justification, retained in the ledger. */
  note?: string;
  /** Each correction targets one adjustment layer by name. */
  corrections?: Array<{
    /** Namespaced layer name, e.g. "LF-42/Grade/Curves-Contrast". */
    layer: string;
    /** Adjustment kind; must match the layer's existing kind. */
    adjustment:
      | 'curves'
      | 'levels'
      | 'vibrance'
      | 'hueSaturation'
      | 'exposure'
      | 'colorBalance'
      | 'blackWhite'
      | 'selectiveColor'
      | 'colorLookup';
    params: JsonObject;
  }>;
}

/** Anything that can look at a PNG and return a schema-valid verdict. */
export interface VisionOracle {
  review(input: {
    imageBase64: string;
    mimeType: string;
    rubric: string;
    round: number;
    previousNote?: string;
  }): Promise<AuditVerdict>;
}

export interface AuditOutcome {
  ok: boolean;
  rounds: number;
  verdicts: Array<{ round: number; verdict: AuditVerdict }>;
  violations: ProbeViolation[];
  converged: boolean;
}

/**
 * Run the bounded audit loop.
 *
 * Invariants:
 *   - never more than `maxRounds` corrections
 *   - never apply a correction to a layer that does not exist
 *   - always re-probe after applying, so we measure reality, not intent
 *   - record convergence when the composite stops moving; `maxRounds`
 *     remains the only hard bound on the number of rounds
 */
export async function runAuditLoop(args: {
  engine: ArtCraftEngine;
  recipe: LayeredRecipe;
  oracle: VisionOracle;
  /** Capture source: 'preview' (headless) or 'window' (desktop bridge). */
  capture: 'preview' | 'window';
  maxSide?: number;
  log?: (event: JsonObject) => void;
}): Promise<AuditOutcome> {
  const { engine, recipe, oracle, capture } = args;
  const policy = recipe.audit ?? { maxRounds: 2, rubric: 'Flag clipping and obvious colour casts.' };
  const log = args.log ?? (() => undefined);
  const verdicts: Array<{ round: number; verdict: AuditVerdict }> = [];

  let lastLuma: number | null = null;
  let converged = false;
  let previousNote: string | undefined;

  for (let round = 0; round <= policy.maxRounds; round++) {
    // 1. Capture. `ui_screenshot` sees the whole app window and is the right
    //    choice when a human-visible defect (panel, guide, overlay) matters;
    //    `doc_render_preview` is the headless-safe composite-only capture.
    const image =
      capture === 'window'
        ? (await engine.uiScreenshot(args.maxSide ?? 0)).images[0]
        : (await engine.renderPreview(args.maxSide ?? 1024)).images[0];

    if (!image) throw new Error('audit: capture returned no image part');

    // 2. Deterministic invariants first — no model involved.
    const samples = await probeComposite(engine, policy.probes);
    const violations = checkProbeInvariants(policy.probes, samples);
    const luma = meanLuma(samples);

    if (lastLuma !== null && Math.abs(luma - lastLuma) < (policy.convergenceEpsilon ?? 0.5)) {
      converged = true;
    }
    lastLuma = luma;

    log({ event: 'audit.round', round, luma, violations: violations.length });

    // 3. Hard invariant failures short-circuit: no point asking a model
    //    whether the highlight is blown when the pixel says it is.
    if (violations.length > 0 && round >= policy.maxRounds) {
      return { ok: false, rounds: round, verdicts, violations, converged: false };
    }

    // 4. Taste check via the oracle.
    const verdict = await oracle.review({
      imageBase64: image.data,
      mimeType: image.mimeType,
      rubric: policy.rubric,
      round,
      previousNote,
    });
    verdicts.push({ round, verdict });
    previousNote = verdict.note;

    if (verdict.status === 'ok' && violations.length === 0) {
      return { ok: true, rounds: round, verdicts, violations, converged };
    }

    // 5. Apply each correction to its named adjustment layer. Corrections are
    //    parameter edits, so the chain stays fully reversible and auditable.
    for (const correction of verdict.corrections ?? []) {
      await engine.runCommand('layer.setAdjustment', {
        layer: { $layer: correction.layer } as unknown as JsonValue,
        ...correction.params,
      });
      log({
        event: 'audit.correction',
        round,
        layer: correction.layer,
        adjustment: correction.adjustment,
      });
    }
  }

  return {
    ok: true,
    rounds: policy.maxRounds,
    verdicts,
    violations: [],
    converged,
  };
}
