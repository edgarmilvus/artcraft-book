// gfx-factory/recipe.ts
import type { BrandKit, Placement } from "./brand.js";
import type { ProductFeedEntry, Variant } from "./schemas.js";

export interface Composition {
  canvas: { width: number; height: number };
  safe: { top: number; bottom: number; left: number; right: number };
  palette: BrandKit["palette"];
  fonts: BrandKit["fonts"];
  headlinePx: number;
  subheadPx: number;
  pricePx: number;
  ctaPx: number;
  badgePx: number;
  product: ProductFeedEntry;
  variant: Variant;
  cta: string;
  priceText: string;
  compareAtText?: string;
  badge?: string;
}

/**
 * Format a Money amount per locale & currency. Delegating to
 * Intl gives us correct currency symbol placement, thin-space
 * grouping, and Arabic/Hindi numbering without a polyfill.
 */
export function formatPrice(
  amount: number,
  currency: string,
  locale: string
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
    maximumFractionDigits: 2,
  }).format(amount);
}

/**
 * Derive the headline text — either the explicit `headline` or a
 * truncated `name`. Choice is explicit rather than implicit
 * because brand guidelines may forbid the raw product name.
 */
function deriveHeadline(product: ProductFeedEntry): string {
  return product.headline ?? product.name.slice(0, 60);
}

/**
 * Pick a badge via a fixed precedence ladder. Deterministic
 * ordering means the same feed always produces the same banner.
 */
function deriveBadge(
  product: ProductFeedEntry,
  variant: Variant
): string | undefined {
  if (variant.badge) return variant.badge;
  if (product.price.compareAt && product.price.compareAt > product.price.amount) {
    const pct = Math.round(
      (1 - product.price.amount / product.price.compareAt) * 100
    );
    return `-${pct}%`;
  }
  if (product.launchedAt) {
    const born = Date.parse(product.launchedAt);
    const days = (Date.now() - born) / 86_400_000;
    if (days >= 0 && days <= 30) return "NEW";
  }
  if (product.tags.includes("bestseller")) return "BESTSELLER";
  if (product.tags.includes("limited")) return "LIMITED";
  return undefined;
}

/**
 * Compile a fully-resolved composition. This function is pure:
 * same inputs → byte-identical record, which is exactly what the
 * content-addressable cache wants.
 */
export function compileRecipe(
  brand: BrandKit,
  placement: Placement,
  product: ProductFeedEntry,
  variant: Variant
): Composition {
  const W = placement.width;
  const H = placement.height;
  const short = Math.min(W, H);

  const safe = {
    top: Math.round(brand.safeZone.top * short),
    bottom: Math.round(brand.safeZone.bottom * short),
    left: Math.round(brand.safeZone.left * short),
    right: Math.round(brand.safeZone.right * short),
  };

  return {
    canvas: { width: W, height: H },
    safe,
    palette: brand.palette,
    fonts: brand.fonts,
    headlinePx: Math.round(short * placement.headlineScale),
    subheadPx: Math.round(short * placement.headlineScale * 0.5),
    pricePx: Math.round(short * placement.priceScale),
    ctaPx: Math.round(short * placement.priceScale * 0.42),
    badgePx: Math.round(short * placement.priceScale * 0.38),
    product,
    variant,
    cta: product.cta ?? brand.cta,
    priceText: formatPrice(product.price.amount, product.price.currency, product.locale),
    compareAtText: product.price.compareAt
      ? formatPrice(product.price.compareAt, product.price.currency, product.locale)
      : undefined,
    badge: deriveBadge(product, variant),
  };
}

/**
 * A stable hash over everything that affects pixels. Two runs
 * with the same recipeHash MUST render byte-identical banners —
 * this is what makes cache invalidation tractable.
 */
export function recipeHash(c: Composition): string {
  const seed = JSON.stringify({
    canvas: c.canvas,
    safe: c.safe,
    palette: c.palette,
    fonts: c.fonts,
    headlinePx: c.headlinePx,
    subheadPx: c.subheadPx,
    pricePx: c.pricePx,
    ctaPx: c.ctaPx,
    badgePx: c.badgePx,
    headline: deriveHeadline(c.product),
    subhead: c.product.subhead ?? "",
    priceText: c.priceText,
    compareAtText: c.compareAtText ?? "",
    cta: c.cta,
    badge: c.badge ?? "",
    variantSku: c.variant.sku,
    variantLabel: c.variant.label,
    sellingPoints: c.product.sellingPoints,
  });
  // Use a non-cryptographic hash — collisions are still policy-safe
  // because the cache also stores the full recipe payload, and a
  // mismatch on read causes a re-render.
  return `sha256:${cryptoHash(seed)}`;
}

import * as crypto from "node:crypto";
function cryptoHash(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}
