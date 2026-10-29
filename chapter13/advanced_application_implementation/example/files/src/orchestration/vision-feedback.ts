// src/orchestration/vision-feedback.ts (agentic loop, abridged)
import type { FilmCraftSession } from "../mcp/session.js";
import type { WheelGrader } from "../services/wheel-grader.js";
import type { ThreeWayGrade } from "../contracts/grading.js";

export interface VisionCorrection {
  readonly balanced: boolean;
  readonly adjust?: Partial<ThreeWayGrade>;
}

/**
 * A minimal, self-contained vision feedback loop. The pipeline calls this
 * after the initial grade when `agenticReview: true` was requested. The
 * callback returns a correction in the same shape the initial grade took,
 * so the loop is a fixed-point iteration on wheel vectors.
 */
export async function reviewAndCorrect(
  session: FilmCraftSession,
  grader: WheelGrader,
  clipId: number,
  initial: ThreeWayGrade,
  askVision: (png: string) => Promise<VisionCorrection>,
  maxIterations = 3,
): Promise<{ iterations: number; grade: ThreeWayGrade }> {
  let grade = initial;
  let iterations = 0;
  for (let i = 0; i < maxIterations; i += 1) {
    iterations = i + 1;
    const png = await session.renderFrame(undefined, 960);
    const verdict = await askVision(png);
    if (verdict.balanced || !verdict.adjust) break;
    grade = mergeGrade(grade, verdict.adjust);
    await grader.applyGrade(clipId, {
      grade,
      presetAmount: 100,
      requireColorSpace: true,
    });
  }
  return { iterations, grade };
}

function mergeGrade(base: ThreeWayGrade, adjustment: Partial<ThreeWayGrade>): ThreeWayGrade {
  const merge = (band: keyof ThreeWayGrade) => {
    const b = base[band] as { hue: number; saturation: number; luminance: number };
    const a = adjustment[band] as { hue?: number; saturation?: number; luminance?: number } | undefined;
    if (!a) return b;
    return {
      hue: (b.hue + (a.hue ?? 0)) % 360,
      saturation: clamp(b.saturation + (a.saturation ?? 0), 0, 100),
      luminance: clamp(b.luminance + (a.luminance ?? 0), -100, 100),
    };
  };
  return {
    shadows: merge("shadows"),
    midtones: merge("midtones"),
    highlights: merge("highlights"),
    exposure: clamp(base.exposure + (adjustment.exposure ?? 0), -5, 5),
    contrast: clamp(base.contrast + (adjustment.contrast ?? 0), -100, 100),
  };
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
