// ---------------------------------------------------------------------------
// contracts.ts — the wire contract between the SaaS edge and the compiler.
// ---------------------------------------------------------------------------
import { z } from "zod";

/**
 * EffectCraft expresses all times in seconds (see the runtime schema:
 * `{"time": 2.5}` on `time.set`, `add_keyframe`, `render_frame`). We accept
 * milliseconds at the edge because that is what design tools and PMs speak,
 * and convert once, at the boundary, so the compiler only ever sees seconds.
 */
export const Seconds = z.number().finite().nonnegative();

/**
 * The easing vocabulary we expose to template authors. Each identifier is
 * lowered to engine-level interpolation + influence by the ValueGraphCompiler.
 * `cubicBezier` lets a designer paste a CSS `cubic-bezier(x1,y1,x2,y2)` tuple
 * and get the closest analytic approximation EffectCraft can express.
 */
export const EasingSpec = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("linear") }),
  z.object({ kind: z.literal("hold") }),
  z.object({ kind: z.literal("bezier") }),
  z.object({ kind: z.literal("easyEase") }),
  z.object({ kind: z.literal("easyEaseIn") }),
  z.object({ kind: z.literal("easyEaseOut") }),
  z.object({
    kind: z.literal("cubicBezier"),
    // Canonical CSS control points. x must stay in [0,1]; y may overshoot,
    // which is exactly how we express "bounce" and "anticipate".
    p1x: z.number().min(0).max(1),
    p1y: z.number(),
    p2x: z.number().min(0).max(1),
    p2y: z.number(),
  }),
]);

export type EasingSpec = z.infer<typeof EasingSpec>;

/** A single authored keyframe on a scalar or vector property. */
export const KeyframeSpec = z.object({
  /** Offset from the layer's own start, in milliseconds. */
  atMs: z.number().finite().nonnegative(),
  /** Number for 1-D properties, [x,y] / [x,y,z] for vectors, string for menus. */
  value: z.union([z.number(), z.array(z.number()), z.string(), z.boolean()]),
  /** Easing applied *leaving* this key (out-interpolation). */
  out: EasingSpec.default({ kind: "easyEase" }),
  /** Easing applied *arriving into* the next key (in-interpolation). */
  in: EasingSpec.default({ kind: "easyEase" }),
});

export type KeyframeSpec = z.infer<typeof KeyframeSpec>;

/** Brand tokens are the only tenant-supplied values that reach the compiler. */
export const BrandTokens = z.object({
  primary: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  accent: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  ink: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  surface: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  fontFamily: z.string().min(1),
  /** Variable-font axis overrides, e.g. { wght: 650, wdth: 95 }. */
  fontVariations: z.record(z.string(), z.number()).default({}),
});

export type BrandTokens = z.infer<typeof BrandTokens>;

/** Structural description of the lower-third the template builds. */
export const LowerThirdSpec = z.object({
  eyebrow: z.string().default(""),
  headline: z.string().min(1),
  subhead: z.string().default(""),
  /** How long the whole card stays on screen, in milliseconds. */
  holdMs: z.number().int().min(400).max(30_000).default(2600),
  /** Entry animation duration, in milliseconds. */
  enterMs: z.number().int().min(80).max(3000).default(680),
  /** Exit animation duration, in milliseconds. */
  exitMs: z.number().int().min(80).max(3000).default(420),
});

export const TemplateRequest = z.object({
  requestId: z.string().uuid(),
  tenantId: z.string().min(1),
  templateId: z.literal("lower-third/v3"),
  width: z.number().int().min(320).max(8192).default(1920),
  height: z.number().int().min(240).max(8192).default(1080),
  frameRate: z.number().positive().max(240).default(30),
  tokens: BrandTokens,
  content: LowerThirdSpec,
  /** Optional override for the render deliverable. */
  deliverable: z
    .object({
      format: z.enum(["h264", "hevc", "prores", "png"]).default("h264"),
      quality: z.number().int().min(1).max(100).default(85),
      transparent: z.boolean().default(false),
    })
    .default({ format: "h264", quality: 85, transparent: false }),
});

export type TemplateRequest = z.infer<typeof TemplateRequest>;
