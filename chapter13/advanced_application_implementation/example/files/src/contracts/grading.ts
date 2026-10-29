// src/contracts/grading.ts
import { z } from "zod";

/**
 * One colour-wheel vector. Hue and saturation are expressed with the
 * convention used by the Lumetri "Color Wheels & Match" section: hue in
 * degrees on the standard 0-360 wheel, saturation as an absolute 0-100
 * percentage, and luminance as a bipolar -100..+100 offset centred on the
 * tonal band's midpoint.
 */
export const WheelVectorSchema = z.object({
  hue: z.number().min(0).max(360).default(0),
  saturation: z.number().min(0).max(100).default(0),
  luminance: z.number().min(-100).max(100).default(0),
});
export type WheelVector = z.infer<typeof WheelVectorSchema>;

/**
 * A three-way grade. The keys mirror the exact name used in Lumetri's
 * Wheels section; the discovery step later resolves them to the concrete
 * effect parameter ids reported by the running FilmCraft binary.
 */
export const ThreeWayGradeSchema = z.object({
  shadows: WheelVectorSchema.default({ hue: 0, saturation: 0, luminance: 0 }),
  midtones: WheelVectorSchema.default({ hue: 0, saturation: 0, luminance: 0 }),
  highlights: WheelVectorSchema.default({ hue: 0, saturation: 0, luminance: 0 }),
  /** Optional midtone lift applied inside the Basic Correction section. */
  exposure: z.number().min(-5).max(5).default(0),
  /** Contrast pivots on middle-gray; the wheel handles hue, this handles bite. */
  contrast: z.number().min(-100).max(100).default(0),
});
export type ThreeWayGrade = z.infer<typeof ThreeWayGradeSchema>;

/**
 * Per-tenant grading recipe.
 *
 * The engine has no Lumetri preset command: a grade is the three wheel
 * vectors plus the two Basic Correction trims, and the discovery step
 * resolves the parameter ids that carry them.
 */
export const GradingRecipeSchema = z.object({
  grade: ThreeWayGradeSchema,
  /** Refuse to apply anything if the target clip's colorspace is unknown. */
  requireColorSpace: z.boolean().default(true),
});
export type GradingRecipe = z.infer<typeof GradingRecipeSchema>;
