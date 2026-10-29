// ─── src/contracts.ts ────────────────────────────────────────────────────────
import { z } from 'zod';

/* ------------------------------------------------------------------ *
 * The brief that arrives from the SaaS admin panel.
 * ------------------------------------------------------------------ */
export const DesignBriefSchema = z.object({
  jobId: z.string().uuid(),
  /** Path beneath the automation read-root, e.g. "input/hero.png". */
  sourcePath: z.string().min(1),
  /** Output path written beneath the automation write-root. */
  targetPath: z.string().min(1),
  /** "instagram_story" | "shopify_hero" | "amazon_a_plus" | "print_a4" | … */
  channelProfile: z.enum(['shopify_hero', 'instagram_story', 'amazon_a_plus', 'print_a4']),
  /** Free-form brand guardrails rendered into the audit prompt. */
  brandKit: z.object({
    primaryHex: z.string().regex(/^#[0-9a-fA-F]{6}$/),
    forbiddenHex: z.array(z.string().regex(/^#[0-9a-fA-F]{6}$/)).default([]),
    tone: z.enum(['editorial_clean', 'warm_lifestyle', 'high_contrast_tech', 'pastel_soft']),
  }),
  /** Maximum acceptable number of audit→refine cycles before escalation. */
  maxCycles: z.number().int().min(1).max(8).default(3),
  /** Below this confidence, the run escalates even if verdict === 'pass'. */
  confidenceFloor: z.number().min(0).max(1).default(0.62),
  /** Human-in-the-loop webhook fired on escalation. */
  escalationWebhook: z.string().url().optional(),
});
export type DesignBrief = z.infer<typeof DesignBriefSchema>;

/* ------------------------------------------------------------------ *
 * Channel geometry presets. The source is centre-cropped to the
 * profile's aspect ratio, then resampled into this exact pixel box by
 * `compileBaseEdit` — see base-edit.ts.
 * ------------------------------------------------------------------ */
export const CHANNEL_PROFILES = {
  shopify_hero:    { width: 2048, height: 1024 },
  instagram_story: { width: 1080, height: 1920 },
  amazon_a_plus:   { width: 1464, height: 600 },
  print_a4:        { width: 2480, height: 3508 },
} as const;
export type ChannelProfile = keyof typeof CHANNEL_PROFILES;

/* ------------------------------------------------------------------ *
 * The structured critique returned by the vision LLM. This is the
 * contract that makes the loop safe: the model can ONLY produce these
 * shapes, and the compiler can ONLY emit commands it recognises.
 * ------------------------------------------------------------------ */
export const FindingAxis = z.enum([
  'exposure', 'color', 'composition', 'typography', 'artifacts', 'brand', 'geometry',
]);

export const FindingSchema = z.object({
  axis: FindingAxis,
  severity: z.enum(['info', 'warn', 'block']),
  /** Short imperative English, e.g. "shadow detail clipped under the bottle". */
  message: z.string().min(4).max(400),
  /** [x0, y0, x1, y1] in normalised 0..1 image coordinates, optional. */
  region: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
});
export type Finding = z.infer<typeof FindingSchema>;

export const CritiqueSchema = z.object({
  verdict: z.enum(['pass', 'revise', 'escalate']),
  confidence: z.number().min(0).max(1),
  findings: z.array(FindingSchema).max(32),
  /** Model-authored corrective actions, validated against the compiler allowlist. */
  corrections: z
    .array(
      z.object({
        command: z.string().min(1),
        params: z.record(z.string(), z.unknown()),
        rationale: z.string().max(240).optional(),
      }),
    )
    .max(16)
    .default([]),
  /** Free-form note surfaced to the human reviewer on escalation. */
  reviewerNote: z.string().max(800).optional(),
});
export type Critique = z.infer<typeof CritiqueSchema>;

/* ------------------------------------------------------------------ *
 * The compiler's output — one command_batch step.
 * ------------------------------------------------------------------ */
export const BatchStepSchema = z.object({
  id: z.string().min(1),               // registry command id, e.g. "layer.newAdjustmentLayer.curves"
  params: z.record(z.string(), z.unknown()),       // validated against the allowlist below
});
export type BatchStep = z.infer<typeof BatchStepSchema>;

/* ------------------------------------------------------------------ *
 * Outcome of one full cycle, used by the convergence controller.
 * ------------------------------------------------------------------ */
export const CycleRecordSchema = z.object({
  cycle: z.number().int().min(0),
  screenshot: z.string(),              // base64 PNG of the post-edit frame
  critique: CritiqueSchema,
  appliedSteps: z.number().int(),
  /** Mean-absolute pixel delta vs. previous cycle (0..1). */
  deltaVsPrev: z.number().min(0).max(1),
  durationMs: z.number().int(),
  startedAt: z.string().datetime(),
});
export type CycleRecord = z.infer<typeof CycleRecordSchema>;
