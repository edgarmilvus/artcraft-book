// gfx-factory/brand.ts
import { z } from "zod";

export const ColorTokenSchema = z
  .string()
  .regex(/^#?[0-9a-fA-F]{6}$/)
  // The hex form is part of the type: the engine's document tools take a
  // colour literal, and a token that is not one cannot be handed over.
  .transform((value) => (value.startsWith("#") ? value : `#${value}`) as `#${string}`)
  .transform((v): `#${string}` => (v.startsWith("#") ? v : `#${v}`) as `#${string}`);

export const BrandKitSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Palette tokens referenced by role, never by literal hex in recipes. */
  palette: z.object({
    primary: ColorTokenSchema,
    onPrimary: ColorTokenSchema,
    surface: ColorTokenSchema,
    onSurface: ColorTokenSchema,
    accent: ColorTokenSchema,
    muted: ColorTokenSchema,
  }),
  fonts: z.object({
    headline: z.string().min(1),
    body: z.string().min(1),
    price: z.string().min(1),
  }),
  /** Default CTA copy per locale-ish channel. */
  cta: z.string().min(1).max(24).default("Shop Now"),
  /** Optional logo asset path resolved by the AssetResolver. */
  logoUrl: z.string().url().optional(),
  /** Padding rules as a fraction of the shorter banner axis. */
  safeZone: z
    .object({
      top: z.number().min(0).max(0.4).default(0.06),
      bottom: z.number().min(0).max(0.4).default(0.06),
      left: z.number().min(0).max(0.4).default(0.06),
      right: z.number().min(0).max(0.4).default(0.06),
    })
    .default({ top: 0.06, bottom: 0.06, left: 0.06, right: 0.06 }),
  /** Optional shadow config for the hero asset. */
  heroShadow: z
    .object({
      on: z.boolean().default(true),
      opacity: z.number().min(0).max(100).default(35),
      distance: z.number().min(0).default(28),
      size: z.number().min(0).default(40),
      angle: z.number().default(90),
    })
    .default({ on: true, opacity: 35, distance: 28, size: 40, angle: 90 }),
});
export type BrandKit = z.infer<typeof BrandKitSchema>;

/**
 * A placement is a delivery target: name + canvas + layout bias.
 * `layout` is a directive, not a hardcoded HTML metaphor:
 *   - "hero-left"    → product on left, copy stack on right
 *   - "hero-center"  → product centered, copy overlay beneath
 *   - "hero-top"     → product upper, copy lower
 */
export const PlacementSchema = z.object({
  id: z.string().min(1),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  layout: z.enum(["hero-left", "hero-center", "hero-top", "hero-bottom"]),
  /** Optional maximum number of selling points on this placement. */
  maxSellingPoints: z.number().int().min(0).max(4).default(3),
  /** Show the compare-at price as a strikethrough block. */
  showStrikeThrough: z.boolean().default(true),
  /** Optional typographic scale (headline pt on a 1000px canvas). */
  headlineScale: z.number().min(0.02).max(0.2).default(0.08),
  priceScale: z.number().min(0.02).max(0.2).default(0.075),
});
export type Placement = z.infer<typeof PlacementSchema>;
