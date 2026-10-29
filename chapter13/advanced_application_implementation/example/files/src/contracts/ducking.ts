// src/contracts/ducking.ts
import { z } from "zod";

/**
 * Ducking policy. All timings are seconds because FilmCraft's automation
 * engine accepts seconds at the clip-mixer layer; the runtime converts
 * them to its internal tick base (254016000000 ticks per second).
 */
export const DuckingPolicySchema = z.object({
  reduceDb: z.number().min(-30).max(0).default(-12),
  attackSeconds: z.number().min(0.02).max(2).default(0.15),
  releaseSeconds: z.number().min(0.05).max(4).default(0.6),
  holdSeconds: z.number().min(0).max(3).default(0.25),
  /** If true, music/SFX are also mood-ducked against ambient beds. */
  applyToSfx: z.boolean().default(false),
  /** Fail (rather than skip) if the target sequence has no dialogue clip. */
  requireDialogue: z.boolean().default(true),
});
export type DuckingPolicy = z.infer<typeof DuckingPolicySchema>;
