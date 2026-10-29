// ─── src/compiler.ts ─────────────────────────────────────────────────────────
import { BatchStep, Critique, Finding } from './contracts.js';

type Axis = Finding['axis'];

/* ------------------------------------------------------------------ *
 * Region helpers. Vision findings carry normalised coordinates
 * [x0, y0, x1, y1] in the 0..1 range; PhotoCraft commands take
 * pixel rectangles. The doc size is passed in at compile time.
 * ------------------------------------------------------------------ */
export function regionToPixels(
  region: [number, number, number, number],
  docWidth: number,
  docHeight: number,
): [number, number, number, number] {
  const [x0, y0, x1, y1] = region;
  return [
    Math.round(x0 * docWidth),
    Math.round(y0 * docHeight),
    Math.round(x1 * docWidth),
    Math.round(y1 * docHeight),
  ];
}

/* ------------------------------------------------------------------ *
 * Severity gate: we never apply corrections for "info" findings.
 * Those are advisory, and churning on polish risks regressing a
 * passing result. Only warn and block compile into commands.
 * ------------------------------------------------------------------ */
function isActionable(f: Finding): boolean {
  return f.severity === 'warn' || f.severity === 'block';
}

/* ------------------------------------------------------------------ *
 * The main compiler. Pure function: (Critique, size) → BatchStep[].
 * No side effects. Safe to call speculatively.
 * ------------------------------------------------------------------ */
export function compileCorrections(
  critique: Critique,
  docWidth: number,
  docHeight: number,
): { steps: BatchStep[]; dropped: string[] } {
  const steps: BatchStep[] = [];
  const dropped: string[] = [];

  /* 1. Model-authored suggestions have priority. They encode the model's
   *    own reasoning about what to fix, and they tend to be more surgical
   *    than our fallback heuristics. We only honour a suggestion if it
   *    maps to a known compiler pattern below. */
  const coveredAxes = new Set<Axis>();
  for (const c of critique.corrections) {
    const mapped = mapSuggestionToStep(c.command, c.params, docWidth, docHeight);
    if (mapped) {
      steps.push(mapped.step);
      if (mapped.axis) coveredAxes.add(mapped.axis);
    } else {
      dropped.push(c.command);
    }
  }

  /* 2. Fallback: heuristic compilation from findings. Guarantees the loop
   *    makes progress even when the model returns no suggestions. Axes
   *    already addressed by a suggestion are skipped, so a "warm" finding
   *    plus a warm_up suggestion does not produce two warming layers. */
  const findings = critique.findings.filter(isActionable);

  // Region findings → select the rectangle first, so the adjustment
  // layers created next inherit it as a layer mask. Clear the selection
  // afterwards so later global adjustments are not silently masked too.
  const regionFindings = findings.filter((f) => f.region != null);
  for (const f of regionFindings) {
    if (coveredAxes.has(f.axis)) continue;
    const [x0, y0, x1, y1] = regionToPixels(f.region!, docWidth, docHeight);
    steps.push({
      id: 'select.rect',
      params: { x: x0, y: y0, width: x1 - x0, height: y1 - y0, mode: 'replace' },
    });
    for (const step of heuristicFor(f, docWidth, docHeight)) steps.push(step);
    steps.push({ id: 'select.deselect', params: {} });
    coveredAxes.add(f.axis);
  }

  // Global findings (no region) apply to the whole frame.
  const globalFindings = findings.filter((f) => f.region == null);
  for (const f of globalFindings) {
    if (coveredAxes.has(f.axis)) continue;
    for (const step of heuristicFor(f, docWidth, docHeight)) steps.push(step);
    coveredAxes.add(f.axis);
  }

  /* 3. Ensure the batch is not empty on "revise". If we drop everything
   *    the loop will spin; instead we emit a conservative micro-contrast
   *    nudge (which is almost never brand-harmful) as a "safe move". */
  if (critique.verdict === 'revise' && steps.length === 0) {
    steps.push({
      id: 'layer.newAdjustmentLayer.brightnessContrast',
      params: { brightness: 0, contrast: 4, legacy: false },
    });
  }

  // Identical commands from two paths would double the effect.
  const unique: BatchStep[] = [];
  const seen = new Set<string>();
  for (const step of steps) {
    const key = `${step.id}:${JSON.stringify(step.params)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(step);
  }

  return { steps: unique, dropped };
}

/* ------------------------------------------------------------------ *
 * Map a model-authored correction into a concrete BatchStep. We only
 * accept a small vocabulary of command names — the model is told to
 * use plain English, and this is where the translation lives. The
 * second return value tells the heuristic pass which axis the
 * suggestion already covered.
 * ------------------------------------------------------------------ */
function mapSuggestionToStep(
  command: string,
  params: Record<string, unknown>,
  docW: number,
  docH: number,
): { step: BatchStep; axis?: Axis } | null {
  const key = command.toLowerCase().trim();

  switch (key) {
    case 'warm_up':
      return {
        axis: 'color',
        step: {
          id: 'layer.newAdjustmentLayer.photoFilter',
          params: {
            filter: 'warming81',
            density: clamp(params.amount as number ?? 12, 4, 30),
            preserveLuminosity: true,
          },
        },
      };
    case 'cool_down':
      return {
        axis: 'color',
        step: {
          id: 'layer.newAdjustmentLayer.photoFilter',
          params: {
            filter: 'cooling80',
            density: clamp(params.amount as number ?? 12, 4, 30),
            preserveLuminosity: true,
          },
        },
      };
    case 'lift_shadows':
      return {
        axis: 'exposure',
        step: {
          id: 'layer.newAdjustmentLayer.curves',
          params: {
            points: [
              [0, clamp(params.lift as number ?? 14, 4, 28)],
              [64, 64 + clamp(params.lift as number ?? 8, 2, 20)],
              [192, 192],
              [255, 255],
            ],
          },
        },
      };
    case 'recover_highlights':
      return {
        axis: 'exposure',
        step: {
          id: 'layer.newAdjustmentLayer.levels',
          params: {
            inBlack: 0,
            gamma: 1,
            inWhite: clamp((params.white as number) ?? 244, 220, 252),
          },
        },
      };
    case 'add_contrast':
      return {
        axis: 'exposure',
        step: {
          id: 'layer.newAdjustmentLayer.brightnessContrast',
          params: {
            brightness: clamp((params.brightness as number) ?? 0, -20, 20),
            contrast: clamp((params.contrast as number) ?? 10, 3, 30),
            legacy: false,
          },
        },
      };
    case 'increase_vibrance':
      return {
        axis: 'color',
        step: {
          id: 'layer.newAdjustmentLayer.vibrance',
          params: {
            vibrance: clamp((params.amount as number) ?? 12, 4, 30),
            saturation: clamp((params.saturation as number) ?? 0, -15, 15),
          },
        },
      };
    case 'desaturate':
      return {
        axis: 'color',
        step: {
          id: 'layer.newAdjustmentLayer.hueSaturation',
          params: {
            hue: 0,
            saturation: -clamp((params.amount as number) ?? 12, 4, 40),
            lightness: 0,
            colorize: false,
          },
        },
      };
    case 'sharpen':
      return {
        axis: 'artifacts',
        step: {
          id: 'filter.sharpen.unsharpMask',
          params: {
            amount: clamp((params.amount as number) ?? 60, 30, 140),
            radius:  clamp((params.radius as number) ?? 0.8, 0.4, 2.4),
            threshold: 3,
          },
        },
      };
    case 'denoise':
      return {
        axis: 'artifacts',
        step: {
          id: 'filter.noise.reduceNoise',
          params: {
            strength: clamp((params.strength as number) ?? 5, 2, 9),
            preserveDetails: 60,
            reduceColorNoise: 45,
            sharpenDetails: 20,
            removeJpegArtifact: false,
          },
        },
      };
    case 'soften_background':
      return {
        axis: 'composition',
        step: {
          id: 'filter.blur.surfaceBlur',
          params: {
            radius: clamp((params.radius as number) ?? 4, 2, 8),
            threshold: 15,
          },
        },
      };
    case 'add_vignette':
      // A radial gradient with rising transparency: transparent in the
      // middle, 35 % black at the edge, multiplied over the frame.
      return {
        axis: 'composition',
        step: {
          id: 'gradient.fill.create',
          params: {
            from: [Math.round(docW / 2), Math.round(docH / 2)],
            to: [Math.round(docW * 0.7), Math.round(docH * 0.7)],
            style: 'radial',
            stops: [[0, '#000000'], [1, '#000000']],
            transparency: [[0, 0], [0.7, 0], [1, 100]],
            opacity: 35,
            mode: 'multiply',
            dither: true,
          },
        },
      };
    case 'crop_tighten':
      return {
        axis: 'composition',
        step: {
          id: 'image.crop',
          params: {
            x: Math.round((params.x as number ?? 0.04) * docW),
            y: Math.round((params.y as number ?? 0.04) * docH),
            width:  Math.round((params.w as number ?? 0.92) * docW),
            height: Math.round((params.h as number ?? 0.92) * docH),
            deleteCroppedPixels: false,
          },
        },
      };
    default:
      return null;
  }
}

/* ------------------------------------------------------------------ *
 * Fallback heuristics indexed by finding axis. These are the guaranteed
 * progress path if the model returns no suggestions.
 * ------------------------------------------------------------------ */
function heuristicFor(f: Finding, docW: number, docH: number): BatchStep[] {
  switch (f.axis) {
    case 'exposure': {
      const lower = f.message.toLowerCase();
      if (lower.includes('clip') && lower.includes('highlight')) {
        return [{ id: 'layer.newAdjustmentLayer.levels',
                  params: { inWhite: 244, gamma: 1 } }];
      }
      if (lower.includes('dark') || lower.includes('shadow')) {
        return [{ id: 'layer.newAdjustmentLayer.curves',
                  params: { points: [[0, 12], [64, 72], [192, 194], [255, 255]] } }];
      }
      return [{ id: 'layer.newAdjustmentLayer.brightnessContrast',
                params: { brightness: 4, contrast: 6, legacy: false } }];
    }
    case 'color': {
      const lower = f.message.toLowerCase();
      if (lower.includes('warm') || lower.includes('yellow')) {
        return [{ id: 'layer.newAdjustmentLayer.photoFilter',
                  params: { filter: 'cooling80', density: 10, preserveLuminosity: true } }];
      }
      if (lower.includes('cool') || lower.includes('blue')) {
        return [{ id: 'layer.newAdjustmentLayer.photoFilter',
                  params: { filter: 'warming81', density: 10, preserveLuminosity: true } }];
      }
      return [{ id: 'layer.newAdjustmentLayer.vibrance',
                params: { vibrance: 10, saturation: 0 } }];
    }
    case 'composition':
      // Trim a 2 % border: enough to tighten, small enough to be safe.
      return [{ id: 'image.crop',
                params: {
                  x: Math.round(docW * 0.02),
                  y: Math.round(docH * 0.02),
                  width: Math.round(docW * 0.96),
                  height: Math.round(docH * 0.96),
                  deleteCroppedPixels: false,
                } }];
    case 'typography':
      // Handled by the type pipeline; not corrected inline.
      return [];
    case 'artifacts':
      return [{ id: 'filter.noise.reduceNoise',
                params: { strength: 4, preserveDetails: 70, reduceColorNoise: 40,
                          sharpenDetails: 10, removeJpegArtifact: true } }];
    case 'brand':
      // Brand-colour mismatches are compiled by the caller into a solid colour
      // overlay via `paint.setFill` on the brand swatch — not a heuristic.
      return [];
    case 'geometry':
      // Geometry is owned by the deterministic base edit (crop + resize).
      // Rotating a hero image because the model dislikes the frame would
      // be worse than escalating, so this axis compiles to nothing.
      return [];
  }
}

function clamp(n: unknown, lo: number, hi: number): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? n : lo;
  return Math.max(lo, Math.min(hi, v));
}
