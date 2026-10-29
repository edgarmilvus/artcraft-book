// ─── src/base-edit.ts ────────────────────────────────────────────────────────
import { BatchStep, CHANNEL_PROFILES, DesignBrief } from './contracts.js';

export interface SourceSize {
  width: number;
  height: number;
}

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Centre-crop rectangle for a target aspect ratio. The crop is computed
 * from the source pixels, so a 3:2 photograph lands in a 2:1 hero slot
 * without stretching: we cut the sides first, then resample.
 */
export function centreCrop(source: SourceSize, targetAspect: number): CropRect {
  const sourceAspect = source.width / source.height;
  let width = source.width;
  let height = source.height;
  if (sourceAspect > targetAspect) {
    width = Math.round(source.height * targetAspect);
  } else if (sourceAspect < targetAspect) {
    height = Math.round(source.width / targetAspect);
  }
  width = Math.max(1, Math.min(width, source.width));
  height = Math.max(1, Math.min(height, source.height));
  return {
    x: Math.floor((source.width - width) / 2),
    y: Math.floor((source.height - height) / 2),
    width,
    height,
  };
}

/**
 * Produce the deterministic first-pass command batch for a brief. The
 * output is a BatchStep[] that the session can execute verbatim. No
 * vision model is involved at this stage — this is the "greenfield"
 * render the audit loop will judge.
 *
 * The document is already open (see `PhotoCraftSession.docOpen`), so the
 * batch starts with geometry, never with a file-open step.
 *
 * @param brief  Validated DesignBrief from the SaaS API.
 * @param source Pixel dimensions reported by `doc_open`.
 * @returns      An ordered batch of PhotoCraft registry commands.
 */
export function compileBaseEdit(brief: DesignBrief, source: SourceSize): BatchStep[] {
  const profile = CHANNEL_PROFILES[brief.channelProfile];
  const steps: BatchStep[] = [];

  // 1. Fit the source to the channel aspect ratio by cropping, not by
  //    squashing. `deleteCroppedPixels: false` keeps the cut pixels
  //    recoverable if a later cycle needs to widen the frame.
  const crop = centreCrop(source, profile.width / profile.height);
  steps.push({
    id: 'image.crop',
    params: { ...crop, deleteCroppedPixels: false },
  });

  // 2. Resample the crop into the channel's exact pixel box.
  steps.push({
    id: 'image.imageSize',
    params: {
      width: profile.width,
      height: profile.height,
      resample: 'bicubicSharper',
    },
  });

  // 3. Normalise tone. A gentle S-curve lifts shadows without milking the file.
  steps.push({
    id: 'layer.newAdjustmentLayer.curves',
    params: {
      points: [[0, 0], [64, 52], [192, 208], [255, 255]],
    },
  });

  // 4. Brand-consistent warm/cool bias derived from the primary brand colour.
  //    We map the primary hex to a hue-balance vector by hand here; in a
  //    larger service this would be a lookup table.
  const tone = brief.brandKit.tone;
  const photoFilterParams: Record<string, unknown> =
    tone === 'warm_lifestyle'
      ? { filter: 'warmingLBA', density: 18, preserveLuminosity: true }
      : tone === 'high_contrast_tech'
      ? { filter: 'cooling80', density: 12, preserveLuminosity: true }
      : tone === 'pastel_soft'
      ? { filter: 'coolingLBB', density: 8, preserveLuminosity: true }
      : { filter: 'warming81', density: 4, preserveLuminosity: true };

  steps.push({ id: 'layer.newAdjustmentLayer.photoFilter', params: photoFilterParams });

  // 5. Micro-contrast via a high-pass overlay. Duplicating the pixel
  //    layer first keeps the original untouched: the filter runs on the
  //    copy, which is then blended back as Overlay at reduced opacity.
  steps.push({ id: 'layer.selectBottom', params: {} });
  steps.push({ id: 'layer.duplicate', params: { name: 'High Pass' } });
  steps.push({
    id: 'filter.other.highPass',
    params: { radius: 2.4 },
  });
  steps.push({
    id: 'layer.layerStyle.blendingOptions',
    params: { blend: 'overlay', opacity: 60 },
  });

  return steps;
}
