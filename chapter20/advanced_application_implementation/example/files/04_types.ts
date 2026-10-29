// src/04_types.ts
import { z } from "zod";

export const BriefSchema = z.object({
  campaignId: z.string().uuid(),
  product: z.object({
    name: z.string().min(1),
    tagline: z.string().min(1),
    priceUsd: z.number().positive(),
    keyBenefits: z.array(z.string().min(1)).min(2).max(6),
    heroImagePath: z.string().optional(),
    palette: z
      .object({
        primary: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
        neutral: z.string().regex(/^#[0-9a-fA-F]{6}$/),
      })
      .optional(),
  }),
  audience: z.string().min(1),
  tone: z.enum(["confident", "playful", "premium", "technical", "warm"]),
  channels: z
    .array(
      z.enum([
        "instagram-post",
        "email-hero",
        "web-banner",
        "tiktok-reel",
        "print-flyer",
        "pdf-onepager",
      ]),
    )
    .min(1),
  deadlineIso: z.string().datetime().optional(),
});

export type Brief = z.infer<typeof BriefSchema>;

/** The channels a campaign can ask for. */
export type Channel = Brief["channels"][number];

/**
 * The shape a copy model must return. The studio validates the model's
 * answer against this schema, because a language model's output is
 * untrusted input no matter which vendor produced it.
 */
export const CopyDraftSchema = z.object({
  headline: z.string().min(4).max(90),
  subhead: z.string().min(4).max(160),
  bullets: z.array(z.string().min(4).max(140)).min(3).max(6),
  cta: z.string().min(2).max(40),
});

export type CopyDraft = z.infer<typeof CopyDraftSchema>;

/**
 * The shape a vision model must return. `status: "fix"` asks the auditor
 * for one corrective adjustment layer; the model names the correction.
 */
export const VisionVerdictSchema = z.object({
  status: z.enum(["ok", "fix"]),
  fix: z.enum(["levels", "curves", "exposure"]).optional(),
  gamma: z.number().min(0.01).max(9.99).optional(),
  reason: z.string().min(1).max(280).optional(),
});

export type VisionVerdict = z.infer<typeof VisionVerdictSchema>;

/**
 * The language model, injected.
 *
 * The studio never calls a model directly: it is handed a closure. The
 * closure receives the brief and returns the model's raw answer, which the
 * agent then validates. A production deployment passes a closure that
 * calls a hosted model; a test passes one that returns a fixed draft.
 */
export type CopyModel = (brief: Brief) => Promise<unknown>;

/**
 * The vision model, injected on the same terms. It receives the rendered
 * PNG as base64 and returns the model's raw answer, which the auditor
 * validates against {@link VisionVerdictSchema}.
 */
export type VisionModel = (input: {
  readonly mimeType: string;
  /** Base64-encoded PNG bytes, without a data-URL prefix. */
  readonly base64: string;
  readonly prompt: string;
}) => Promise<unknown>;

/** A rendered, ready-to-publish creative asset plus its provenance. */
export interface AssetArtefact {
  readonly id: string;
  readonly channel: Channel;
  /** Absolute path to the file written beneath the write root. */
  readonly path: string;
  /** MIME type, e.g. "image/png" or "application/pdf". */
  readonly mime: string;
  /** Agent that produced it ("visual", "motion", "publisher", "copywriter"). */
  readonly producer: string;
  /** Which ArtCraft dialect produced it, for provenance and audit. */
  readonly binary: string;
  readonly dimensions: { width: number; height: number } | null;
  readonly bytes: number;
  /** Vision-audit verdict (null until audited). */
  readonly audit: AuditVerdict | null;
  readonly createdAtIso: string;
}

export interface AuditVerdict {
  readonly passed: boolean;
  readonly score: number; // 0..1
  readonly reasons: string[];
  readonly corrections: AuditCorrection[];
  /** The name of the injected model that produced the verdict. */
  readonly auditorModel: string;
}

export interface AuditCorrection {
  readonly kind: "levels" | "curves" | "exposure" | "recompose" | "none";
  readonly gamma?: number;
  readonly points?: Array<[number, number]>;
}

export interface CopyBlock {
  readonly headline: string;
  readonly subhead: string;
  readonly bullets: readonly string[];
  readonly cta: string;
  readonly docxPath: string;
}

export interface CampaignState {
  readonly brief: Brief;
  copy: CopyBlock | null;
  readonly hero: {
    path: string;
    palette: { primary: string; accent: string; neutral: string };
  } | null;
  readonly assets: AssetArtefact[];
  readonly auditLog: Array<{
    readonly atIso: string;
    readonly agent: string;
    readonly message: string;
    readonly commandsSpent: number;
  }>;
  commandsSpent: number;
}
