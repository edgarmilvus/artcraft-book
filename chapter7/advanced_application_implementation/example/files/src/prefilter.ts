// ─── src/prefilter.ts ────────────────────────────────────────────────────────
import type { RgbaFrame } from './pixels.js';

/* ------------------------------------------------------------------ *
 * The vocabulary the pre-filter scores against. Shorter than a full
 * aesthetic evaluator but sufficient to detect catastrophic renders
 * (blown highlights, colour casts, washed blacks).
 * ------------------------------------------------------------------ */
export const PROMPTS = [
  'a professionally lit product photograph',
  'a photograph with natural balanced colour',
  'a photograph with conspicuous colour cast',
  'a photograph with severely clipped highlights',
  'a photograph with crushed black shadows',
  'an obviously out-of-focus or blurred photograph',
] as const;

export interface ClassificationScore {
  label: string;
  score: number;
}

/** Anything that can rank the prompts against a frame. */
export interface Classifier {
  classify(frame: RgbaFrame): Promise<ClassificationScore[]>;
}

/**
 * Lazily load Transformers.js and build the zero-shot classifier.
 *
 * The dependency is optional on purpose: in the container image it is
 * installed and the CLIP weights are baked into the filesystem, while a
 * unit-test or a slim CLI install can skip ~200 MB of runtime. When the
 * loader returns null the pre-filter still runs its histogram checks and
 * hands the frame to the vision model.
 */
export type ClassifierLoader = () => Promise<Classifier | null>;

async function loadTransformersClassifier(): Promise<Classifier | null> {
  // Non-literal specifier: the bundler and `tsc` must not require the
  // package to be present just to typecheck this file.
  const specifier = '@xenova/transformers';
  let mod: any;
  try {
    mod = await import(specifier);
  } catch {
    return null;
  }

  mod.env.cacheDir = process.env.TRANSFORMERS_CACHE ?? '/tmp/transformers-cache';
  mod.env.allowRemoteModels = false; // We bake the model into the image.

  try {
    const pipe = await mod.pipeline(
      'zero-shot-image-classification',
      'Xenova/clip-vit-base-patch32',
    );
    const { RawImage } = mod;
    return {
      classify: async (frame: RgbaFrame) => {
        const image = new RawImage(frame.data, frame.width, frame.height, 4);
        return (await pipe(image, [...PROMPTS])) as ClassificationScore[];
      },
    };
  } catch {
    // Weights missing or native runtime unavailable: degrade to heuristics.
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * A cheap histogram check that does not need the model at all.
 * ------------------------------------------------------------------ */
export function histogramClipping(pixels: Uint8Array): {
  shadowClip: number;
  highlightClip: number;
} {
  let shadow = 0;
  let highlight = 0;
  let total = 0;
  // Assumes 4-channel RGBA; every 4th byte starts a new pixel.
  for (let i = 0; i < pixels.length; i += 4) {
    const luma = 0.2126 * pixels[i] + 0.7152 * pixels[i + 1] + 0.0722 * pixels[i + 2];
    if (luma <= 3) shadow++;
    if (luma >= 252) highlight++;
    total++;
  }
  if (total === 0) return { shadowClip: 0, highlightClip: 0 };
  return { shadowClip: shadow / total, highlightClip: highlight / total };
}

export interface PrefilterVerdict {
  pass: boolean;
  topLabel: string;
  topScore: number;
  shadowClip: number;
  highlightClip: number;
  reason?: string;
}

export interface PrefilterOptions {
  /** Pre-computed embedding; when supplied, the model call is skipped. */
  embedding?: { data: number[] };
  /** Classifier override (tests, batch jobs that already loaded CLIP). */
  classifier?: Classifier;
  /** Loader override; defaults to the Transformers.js loader. */
  loadClassifier?: ClassifierLoader;
}

/**
 * Score an RGBA frame on cheap local heuristics. This is deliberately
 * permissive: it exists to catch catastrophic failures, not to make
 * aesthetic judgments. The vision LLM owns the latter.
 */
export async function prefilter(
  frame: RgbaFrame,
  options: PrefilterOptions = {},
): Promise<PrefilterVerdict> {
  const { shadowClip, highlightClip } = histogramClipping(frame.data);

  // Hard clip failure — no need to spend tokens on this.
  if (shadowClip > 0.18) {
    return { pass: false, topLabel: 'clip', topScore: 1, shadowClip, highlightClip,
             reason: 'shadow clipping exceeds 18 % of the frame' };
  }
  if (highlightClip > 0.22) {
    return { pass: false, topLabel: 'clip', topScore: 1, shadowClip, highlightClip,
             reason: 'highlight clipping exceeds 22 % of the frame' };
  }

  // If the caller already has an embedding (e.g. from a shared batch),
  // skip the classifier and pass — the LLM will grade.
  if (options.embedding) {
    return { pass: true, topLabel: 'embedding-supplied', topScore: 1, shadowClip, highlightClip };
  }

  const loader = options.loadClassifier ?? loadTransformersClassifier;
  let classifier = options.classifier;
  if (!classifier) {
    classifier = (await loader()) ?? undefined;
  }
  if (!classifier) {
    return { pass: true, topLabel: 'heuristic-only', topScore: 0, shadowClip, highlightClip };
  }

  let ranked: ClassificationScore[];
  try {
    ranked = await classifier.classify(frame);
  } catch {
    return { pass: true, topLabel: 'heuristic-only', topScore: 0, shadowClip, highlightClip };
  }

  const top = ranked[0] ?? { label: PROMPTS[0], score: 1 };
  const negative = ['colour cast', 'clipped highlights', 'crushed black', 'blurred'];
  const isNegative = negative.some((n) => String(top.label).includes(n));

  return {
    pass: !isNegative || Number(top.score) < 0.62,
    topLabel: String(top.label),
    topScore: Number(top.score),
    shadowClip,
    highlightClip,
    reason: isNegative ? `local model reports ${top.label} (${Number(top.score).toFixed(2)})` : undefined,
  };
}
