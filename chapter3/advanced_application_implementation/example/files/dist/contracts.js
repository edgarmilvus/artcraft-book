// src/contracts.ts
import { z } from "zod";
/**
 * The public design brief accepted by POST /v1/render.
 * Field names are stable; the schema is the source of truth for both
 * the HTTP edge (fastify route) and the internal pipeline.
 */
export const DesignBriefSchema = z.object({
    /** Tenant identifier used for artifact namespacing and quota accounting. */
    tenantId: z.string().min(1).max(64).regex(/^[a-z0-9-]+$/),
    /** Headline rendered at the top of the banner. */
    headline: z.string().min(1).max(120),
    /** Optional sub-headline. */
    subhead: z.string().max(160).optional(),
    /** Price string (kept as string so currency formatting is caller-owned). */
    price: z.string().min(1).max(24),
    /** Path to the product image inside the read root; relative paths
     *  resolve against that root. */
    productImagePath: z.string().min(1),
    /** Output canvas dimensions in pixels. */
    canvas: z.object({
        width: z.number().int().min(256).max(8192),
        height: z.number().int().min(256).max(8192),
    }).default({ width: 1920, height: 1080 }),
    /** Brand color applied to accent strokes and the price tag. */
    accentColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).default("#d97706"),
});
/**
 * The artifact descriptor returned to the caller and persisted to the
 * release manifest. `sha256` is computed over the final PNG bytes.
 */
export const ArtifactSchema = z.object({
    path: z.string(),
    format: z.literal("PNG"),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    renderMs: z.number().nonnegative(),
    stages: z.array(z.object({
        name: z.string(),
        ms: z.number().nonnegative(),
        ok: z.boolean(),
    })),
});
//# sourceMappingURL=contracts.js.map