// src/contracts/loudness.ts
import { z } from "zod";

/**
 * Loudness targets follow the EBU R128 / ATSC A/85 conventions but are
 * exposed as plain numbers so tenants can pick streaming masters (-14)
 * or broadcast masters (-23) with the same schema.
 */
export const LoudnessTargetSchema = z.object({
  /** Integrated loudness target in LUFS (LKFS). */
  integratedLufs: z.number().min(-40).max(-5),
  /** True-peak ceiling in dBTP — never exceeded, enforced post-encode. */
  truePeakDbTP: z.number().min(-10).max(0).default(-1),
  /** Loudness range tolerance in LU, for EBU R128 style validation. */
  maxLoudnessRangeLu: z.number().min(0).max(30).default(12),
  /**
   * The dialogue anchor offset. Premiere's "Auto-Match Loudness" pulls
   * dialogue to -23 LUFS by default; streaming mixes typically want the
   * dialogue anchor one or two LU hotter than the integrated target so
   * that speech sits forward of music and effects.
   */
  dialogueAnchorOffsetLu: z.number().min(-6).max(6).default(0),
  /** Which Essential Sound type the anchor tracks carry. */
  anchorType: z.enum(["dialogue", "music", "sfx", "ambience"]).default("dialogue"),
});
export type LoudnessTarget = z.infer<typeof LoudnessTargetSchema>;
