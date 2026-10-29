// gfx-factory/compose.ts
import { PhotoCraftMcpClient } from "./mcp-client.js";
import type { Composition } from "./recipe.js";

/**
 * Issue all composition commands for a single banner. Returns the
 * native document index (from session_list) so callers can save or
 * preview it. Every command inside is a pure function of the
 * `Composition`; ordering is fixed.
 */
export async function composeBanner(
  mcp: PhotoCraftMcpClient,
  c: Composition,
  heroRelativePath: string,
  logoRelativePath?: string
): Promise<void> {
  const W = c.canvas.width;
  const H = c.canvas.height;

  // -- 1. Fresh scene ------------------------------------------------
  await mcp.newDoc({
    width: W,
    height: H,
    background: c.palette.surface,
    name: `banner-${c.variant.sku}-${W}x${H}`,
  });

  // -- 2. Background gradient overlay (subtle depth) -----------------
  //  We paint a slightly-accented rectangle over the surface so the
  //  banner doesn't read as flat. This is a brand-agnostic flourish.
  await mcp.run("layer.new.layer", {
    name: "bg-accent",
    opacity: 0.08,
  });
  await mcp.run("edit.fill", {
    contents: "color",
    color: c.palette.accent,
    mode: "normal",
    opacity: 100,
  });

  // -- 3. Hero image -------------------------------------------------
  //  `doc_place` auto-fits a larger image; we pass `fit: true` so
  //  the smart object lands inside the canvas without extra math.
  await mcp.place({
    path: heroRelativePath,
    fit: true,
    center: [W / 2, H / 2],
  });

  // Rename the placed layer so later steps can address it by name.
  await mcp.run("layer.setProps", { name: "hero", locked: false });

  // -- 4. Hero drop shadow ------------------------------------------
  if (c.palette) {
    await mcp.run("layer.layerStyle.dropShadow", {
      color: c.palette.muted,
      opacity: 35,
      blend: "multiply",
      angle: 90,
      useGlobalLight: true,
      distance: Math.round(Math.min(W, H) * 0.02),
      spread: 0,
      size: Math.round(Math.min(W, H) * 0.05),
      antiAlias: true,
      noise: 0,
      knocksOut: false,
      add: false,
    });
  }

  // -- 5. Headline ---------------------------------------------------
  const headline = (c.product.headline ?? c.product.name).toUpperCase();
  const headlineX = c.safe.left;
  const headlineY = Math.round(c.safe.top + c.headlinePx * 1.05);
  await mcp.run("type.create", {
    x: headlineX,
    y: headlineY,
    text: headline,
    name: "headline",
    font: c.fonts.headline,
    size: c.headlinePx,
    color: c.palette.onSurface,
    orientation: "horizontal",
    align: "left",
  });

  // -- 6. Subhead ----------------------------------------------------
  if (c.product.subhead) {
    await mcp.run("type.create", {
      x: headlineX,
      y: headlineY + Math.round(c.subheadPx * 1.8),
      text: c.product.subhead,
      name: "subhead",
      font: c.fonts.body,
      size: c.subheadPx,
      color: c.palette.muted,
      orientation: "horizontal",
    });
  }

  // -- 7. Selling points (up to 3, deterministic) -------------------
  const points = c.product.sellingPoints.slice(0, 3);
  await mcp.batch(
    points.flatMap((pt, i) => {
      const y =
        headlineY +
        Math.round(c.subheadPx * 2.2) +
        i * Math.round(c.subheadPx * 1.6);
      return [
        {
          id: "type.create",
          params: {
            x: headlineX,
            y,
            text: `•  ${pt}`,
            name: `point-${i}`,
            font: c.fonts.body,
            size: c.subheadPx,
            color: c.palette.onSurface,
            orientation: "horizontal",
          },
        },
      ];
    })
  );

  // -- 8. Price band -------------------------------------------------
  //  Anchored to the bottom-left safe corner, above the CTA row.
  const priceY = H - c.safe.bottom - Math.round(c.ctaPx * 3.2);
  await mcp.run("type.create", {
    x: headlineX,
    y: priceY,
    text: c.priceText,
    name: "price",
    font: c.fonts.price,
    size: c.pricePx,
    color: c.palette.primary,
    orientation: "horizontal",
  });

  if (c.compareAtText) {
    await mcp.run("type.create", {
      x: headlineX + Math.round(c.pricePx * 4.6),
      y: priceY + Math.round(c.pricePx * 0.25),
      text: c.compareAtText,
      name: "compareAt",
      font: c.fonts.price,
      size: Math.round(c.pricePx * 0.42),
      color: c.palette.muted,
      orientation: "horizontal",
    });
  }

  // -- 9. CTA chip ---------------------------------------------------
  const ctaW = Math.round(c.ctaPx * 8.5);
  const ctaH = Math.round(c.ctaPx * 2.2);
  const ctaX = headlineX;
  const ctaY = H - c.safe.bottom - ctaH;
  await mcp.run("layer.new.layer", { name: "cta-bg" });
  await mcp.run("edit.fill", {
    contents: "color",
    color: c.palette.primary,
    mode: "normal",
    opacity: 100,
  });
  // Resize the CTA layer to an exact rectangle: use canvasSize-safe
  // semantics via edit.transform with a rect that matches the layer's
  // rasterized bounds. For portability we drive the shape via fill
  // then translate.
  await mcp.run("layer.translate", {
    layer: undefined, // operates on the active cta-bg layer
    dx: ctaX,
    dy: ctaY,
  });
  await mcp.run("type.create", {
    x: ctaX + Math.round(ctaW * 0.2),
    y: ctaY + Math.round(ctaH * 0.65),
    text: c.cta.toUpperCase(),
    name: "cta-text",
    font: c.fonts.headline,
    size: c.ctaPx,
    color: c.palette.onPrimary,
    orientation: "horizontal",
  });

  // -- 10. Badge chip ------------------------------------------------
  if (c.badge) {
    const bx = W - c.safe.right - Math.round(c.badgePx * 5);
    const by = c.safe.top;
    await mcp.run("layer.new.layer", { name: "badge-bg" });
    await mcp.run("edit.fill", {
      contents: "color",
      color: c.palette.accent,
      mode: "normal",
      opacity: 100,
    });
    await mcp.run("layer.translate", { dx: bx, dy: by });
    await mcp.run("type.create", {
      x: bx + Math.round(c.badgePx * 0.6),
      y: by + Math.round(c.badgePx * 1.4),
      text: c.badge,
      name: "badge-text",
      font: c.fonts.headline,
      size: c.badgePx,
      color: c.palette.onPrimary,
      orientation: "horizontal",
    });
  }

  // -- 11. Logo ------------------------------------------------------
  if (logoRelativePath) {
    await mcp.place({
      path: logoRelativePath,
      scale: 100,
      center: [W - c.safe.right - 60, c.safe.top + 30],
    });
    await mcp.run("layer.setProps", { name: "logo" });
  }
}
