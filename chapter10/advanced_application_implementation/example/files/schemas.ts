// gfx-factory/schemas.ts
import { z } from "zod";

/**
 * BCP-47 locale tag. Kept permissive — a stricter regex belongs
 * in a policy service, not the graphics worker.
 */
export const LocaleSchema = z.string().min(2).max(35);

/**
 * Normalized currency: 3-letter ISO 4217. We do not encode
 * amounts here because price formatting is a *presentation*
 * concern delegated to `formatPrice()`.
 */
export const MoneySchema = z.object({
  amount: z.number().nonnegative().finite(),
  currency: z.string().length(3).toUpperCase(),
  /** Optional strike-through price for discount badges. */
  compareAt: z.number().nonnegative().finite().optional(),
});

/**
 * One variant of a product — a colourway, size tier or SKU that
 * carries its own hero image. A product without variants renders
 * exactly one banner set.
 */
export const VariantSchema = z.object({
  sku: z.string().min(1),
  label: z.string().min(1).max(48),
  /** Fully-qualified URL or relative CDN path. */
  imageUrl: z.string().url(),
  /** Optional per-variant override of the marketing badge. */
  badge: z.string().max(28).optional(),
  colorway: z
    .object({ hex: z.string().regex(/^#?[0-9a-fA-F]{6}$/) })
    .optional(),
});

/**
 * The canonical feed record. Everything a banner may reference
 * is on this object; nothing else is looked up at render time.
 */
export const ProductFeedEntrySchema = z.object({
  /** Stable catalog identifier; used as the cache shard. */
  id: z.string().min(1),
  name: z.string().min(1).max(120),
  /** Short marketing headline — falls back to `name`. */
  headline: z.string().max(64).optional(),
  /** Optional secondary line shown under the headline. */
  subhead: z.string().max(96).optional(),
  brand: z.string().min(1),
  category: z.string().min(1),
  price: MoneySchema,
  /** Marketing bullets often rendered as a 3-dot strip. */
  sellingPoints: z.array(z.string().max(48)).max(4).default([]),
  /** Discovery tags drive dynamic badge selection. */
  tags: z.array(z.string()).default([]),
  /** Locale of the copy itself (independent of money locale). */
  locale: LocaleSchema.default("en-US"),
  /** Optional CTA override; brand config wins if omitted. */
  cta: z.string().max(24).optional(),
  /** ISO-8601 date; used for "new" and seasonal badges. */
  launchedAt: z.string().datetime().optional(),
  variants: z.array(VariantSchema).min(1),
});

export const ProductFeedSchema = z.object({
  version: z.literal(1),
  /** Feed generation timestamp; feeds are append-only by contract. */
  generatedAt: z.string().datetime(),
  products: z.array(ProductFeedEntrySchema).min(1),
});

export type ProductFeedEntry = z.infer<typeof ProductFeedEntrySchema>;
export type ProductFeed = z.infer<typeof ProductFeedSchema>;
export type Variant = z.infer<typeof VariantSchema>;
export type Money = z.infer<typeof MoneySchema>;
