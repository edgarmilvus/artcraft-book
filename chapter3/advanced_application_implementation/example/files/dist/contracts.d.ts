import { z } from "zod";
/**
 * The public design brief accepted by POST /v1/render.
 * Field names are stable; the schema is the source of truth for both
 * the HTTP edge (fastify route) and the internal pipeline.
 */
export declare const DesignBriefSchema: z.ZodObject<{
    tenantId: z.ZodString;
    headline: z.ZodString;
    subhead: z.ZodOptional<z.ZodString>;
    price: z.ZodString;
    productImagePath: z.ZodString;
    canvas: z.ZodDefault<z.ZodObject<{
        width: z.ZodNumber;
        height: z.ZodNumber;
    }, z.core.$strip>>;
    accentColor: z.ZodDefault<z.ZodString>;
}, z.core.$strip>;
export type DesignBrief = z.infer<typeof DesignBriefSchema>;
/**
 * The artifact descriptor returned to the caller and persisted to the
 * release manifest. `sha256` is computed over the final PNG bytes.
 */
export declare const ArtifactSchema: z.ZodObject<{
    path: z.ZodString;
    format: z.ZodLiteral<"PNG">;
    width: z.ZodNumber;
    height: z.ZodNumber;
    bytes: z.ZodNumber;
    sha256: z.ZodString;
    renderMs: z.ZodNumber;
    stages: z.ZodArray<z.ZodObject<{
        name: z.ZodString;
        ms: z.ZodNumber;
        ok: z.ZodBoolean;
    }, z.core.$strip>>;
}, z.core.$strip>;
export type Artifact = z.infer<typeof ArtifactSchema>;
/**
 * Union type for MCP tool failures wrapped by CraftMCPClient.
 * Using a discriminated union rather than throwing lets the caller
 * decide whether a failure is retryable, fatal or fallback-able.
 */
export type ToolOutcome<T> = {
    readonly ok: true;
    readonly value: T;
} | {
    readonly ok: false;
    readonly error: string;
    readonly retryable: boolean;
};
