// src/pipeline/banner.ts
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { CraftMCPClient } from "../mcp/client.js";
import { ArtifactSchema, } from "../contracts.js";
/** Small schemas for the Craft tool replies we actually consume. */
const DocOpenResult = z.object({ index: z.number().int() }).passthrough();
const DocSaveResult = z.object({
    path: z.string(),
    bytes: z.number().optional(),
    warnings: z.array(z.string()).optional(),
}).passthrough();
const NewDocumentResult = z.object({ index: z.number().int() }).passthrough();
const FrameCreateResult = z.object({
    id: z.number().int(),
    story: z.number().int(),
}).passthrough();
// Commands that report nothing return the JSON literal `null` in the
// content block, not `{}` — a schema of `z.object({})` rejects them.
const VoidResult = z.unknown();
const ExportPngResult = z.object({
    path: z.string(),
    width: z.number().optional(),
    height: z.number().optional(),
}).passthrough();
/**
 * One `command_batch` step. `params` is required by the type even when the
 * command takes none: that is what the book's schema in §4 was missing, and
 * the engine's `additionalProperties: false` rejects anything else.
 */
const BatchStep = z.object({
    id: z.string(),
    params: z.record(z.string(), z.unknown()).optional(),
});
const BatchResult = z.object({
    completed: z.number().int(),
    failed: z.number().int(),
    results: z.array(z.unknown()).optional(),
}).passthrough();
/**
 * Execute the two-stage banner pipeline for one brief.
 * Preconditions: both clients are warm (already connected).
 * Postconditions: a PNG artifact exists under `outDir` with matching SHA-256.
 */
export async function runBannerPipeline(brief, deps) {
    const stageTimings = [];
    const t0 = Date.now();
    // --- Stage A: raster normalization in PhotoCraft ---------------------
    const stageA = await timed(stageTimings, "photocraft.normalize", async () => {
        // A.1 — open the raw product image so PhotoCraft owns its bytes.
        const opened = await deps.photocraft.call("doc_open", { path: brief.productImagePath }, z.object({ path: z.string() }), DocOpenResult);
        if (!opened.ok)
            throw new Error(`doc_open: ${opened.error}`);
        // A.2 — auto-tone, auto-contrast, cut the subject out and add a gentle
        //       levels layer. All four ids exist in the registry (`photocraft-cli
        //       commands --filter image.auto` lists the first two), and they run
        //       in one round-trip. The batch is NOT a transaction: `failed` is a
        //       count of the steps that did not apply, so we check it explicitly.
        const normalized = await deps.photocraft.call("command_batch", {
            stop_on_error: true,
            steps: [
                { id: "image.autoTone", params: {} },
                { id: "image.autoContrast", params: {} },
                { id: "layer.removeBackground", params: { refine: true } },
                { id: "layer.newAdjustmentLayer.levels", params: { gamma: 1.05 } },
            ],
        }, z.object({
            steps: z.array(BatchStep),
            stop_on_error: z.boolean().optional(),
        }), BatchResult);
        if (!normalized.ok)
            throw new Error(`normalize batch: ${normalized.error}`);
        if (normalized.value.failed > 0) {
            // `failed` is only a count; the per-step verdicts are in `results`,
            // one entry per attempted step, in order.
            const failed = (normalized.value.results ?? [])
                .map((r, i) => ({ i, r }))
                .filter(({ r }) => r.ok === false)
                .map(({ i, r }) => `#${i}: ${JSON.stringify(r.error ?? r)}`);
            throw new Error(`normalize batch: ${normalized.value.failed} step(s) failed — ${failed.join(", ")}`);
        }
        // A.3 — export the normalized image as PNG into the shared scratch
        //       directory. `doc_save` respects --automation-write-root, so the
        //       path must be relative to it, and the reply echoes that relative
        //       path (never an absolute one).
        const normalizedRel = `stage-a/${brief.tenantId}-${Date.now()}.png`;
        const saved = await deps.photocraft.call("doc_save", { path: normalizedRel, format: "png" }, z.object({ path: z.string(), format: z.string().optional() }), DocSaveResult);
        if (!saved.ok)
            throw new Error(`doc_save (stage A): ${saved.error}`);
        return saved.value.path; // relative to the write root
    });
    // --- Stage B: layout composition in DesignCraft ----------------------
    // A box, not a `let`: TypeScript narrows a `let` assigned inside a
    // closure to `null` at the read site, so the box keeps the type honest.
    const exportBox = { value: null };
    await timed(stageTimings, "designcraft.compose", async () => {
        const { width: w, height: h } = brief.canvas;
        // B.1 — create a new page-sized document with the brief's canvas.
        const created = await deps.designcraft.call("new_document", { width: w, height: h, pages: 1, title: `Banner-${brief.tenantId}` }, z.object({
            width: z.number().int(),
            height: z.number().int(),
            pages: z.number().int().optional(),
            title: z.string().optional(),
        }), NewDocumentResult);
        if (!created.ok)
            throw new Error(`new_document: ${created.error}`);
        // B.2 — place the normalized image into a left-hand graphic frame. The
        //       path is the PhotoCraft-relative one: both CLIs share the write
        //       root, DesignCraft simply resolves it against its cwd.
        const imageWidth = Math.round(w * 0.5);
        const placedImage = await deps.designcraft.call("place_image", { path: stageA, x: Math.round(w * 0.04), y: Math.round(h * 0.1), width: imageWidth }, z.object({ path: z.string(), x: z.number(), y: z.number(), width: z.number() }), 
        // The reply does not always name the frame; the id is only needed
        // if a caller wants to re-target it, so it stays optional.
        z.object({ frame: z.number().int().optional() }).passthrough());
        if (!placedImage.ok)
            throw new Error(`place_image: ${placedImage.error}`);
        // B.3 — the accent colour must be a real swatch. `type.char`'s `fill`
        //       takes a swatch *name*, and an unknown one (a hex string, say) is
        //       accepted silently and renders as no fill at all.
        const swatchName = "Brand/Accent";
        const swatch = await deps.designcraft.call("execute", { command: "swatch.create", params: { name: swatchName, color: brief.accentColor } }, z.object({ command: z.string(), params: z.record(z.string(), z.unknown()) }), VoidResult);
        if (!swatch.ok)
            throw new Error(`swatch.create: ${swatch.error}`);
        // B.4 — compose the type stack. `frame.create` returns `{id, story}` and
        //       `type.char` only applies to a *selection*, so each block is
        //       create → select the story's range → set the character attributes.
        //       These three calls depend on ids the engine hands back one at a
        //       time, which is why they are separate warm round-trips rather than
        //       one batch: the batch API cannot reference a story created mid-batch.
        const textX = Math.round(w * 0.58);
        const textWidth = w - textX - Math.round(w * 0.04);
        const blocks = [
            {
                rect: [textX, Math.round(h * 0.2), textX + textWidth, Math.round(h * 0.34)],
                text: brief.headline.toUpperCase(),
                size: 64,
                fill: "[Black]",
                bold: true,
            },
            {
                rect: [textX, Math.round(h * 0.38), textX + textWidth, Math.round(h * 0.46)],
                text: brief.subhead ?? "",
                size: 22,
                fill: "[Black]",
            },
            {
                rect: [textX, Math.round(h * 0.62), textX + textWidth, Math.round(h * 0.76)],
                text: brief.price,
                size: 44,
                fill: swatchName,
                bold: true,
            },
        ];
        const argsSchema = z.object({
            command: z.string(),
            params: z.record(z.string(), z.unknown()),
        });
        for (const block of blocks) {
            if (block.text.length === 0)
                continue;
            const frame = await deps.designcraft.call("execute", { command: "frame.create",
                params: { rect: block.rect, content: "text", text: block.text } }, argsSchema, FrameCreateResult);
            if (!frame.ok)
                throw new Error(`frame.create: ${frame.error}`);
            const selected = await deps.designcraft.call("execute", 
            // UTF-8 byte offsets, not character counts.
            { command: "text.select",
                params: { story: frame.value.story, anchor: 0,
                    focus: Buffer.byteLength(block.text, "utf8") } }, argsSchema, VoidResult);
            if (!selected.ok)
                throw new Error(`text.select: ${selected.error}`);
            const styled = await deps.designcraft.call("execute", { command: "type.char",
                params: { attrs: { size: block.size, fill: block.fill,
                        ...(block.bold === true ? { fontStyle: "Bold" } : {}) } } }, argsSchema, VoidResult);
            if (!styled.ok)
                throw new Error(`type.char: ${styled.error}`);
        }
        // B.5 — export the composed page as PNG at 2x for retina delivery.
        //       `page` is 0-based; `scale` is pixels per point (default 2).
        const outRel = `banners/${brief.tenantId}-${Date.now()}.png`;
        const exported = await deps.designcraft.call("export_png", { path: outRel, page: 0, scale: 2 }, z.object({ path: z.string(), page: z.number().int().optional(), scale: z.number().optional() }), ExportPngResult);
        if (!exported.ok)
            throw new Error(`export_png: ${exported.error}`);
        exportBox.value = { path: exported.value.path,
            width: exported.value.width,
            height: exported.value.height };
    });
    // --- Finalize: hash the artifact and validate the descriptor ---------
    const exportResult = exportBox.value;
    if (exportResult === null)
        throw new Error("stage B produced no export");
    const absPath = resolve(deps.outDir, outRelFromAbs(exportResult.path, deps.outDir));
    const bytes = await fs.readFile(absPath);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const artifact = ArtifactSchema.parse({
        path: absPath,
        format: "PNG",
        // Trust the exporter's own numbers: `scale` is a float, so `canvas * 2`
        // is only right by coincidence.
        width: exportResult.width ?? brief.canvas.width * 2,
        height: exportResult.height ?? brief.canvas.height * 2,
        bytes: bytes.byteLength,
        sha256,
        renderMs: Date.now() - t0,
        stages: stageTimings,
    });
    return artifact;
}
/**
 * Wrap an async stage in a stopwatch that records into the shared
 * stageTimings array whether the stage succeeded or threw.
 */
async function timed(out, name, fn) {
    const start = Date.now();
    try {
        const v = await fn();
        out.push({ name, ms: Date.now() - start, ok: true });
        return v;
    }
    catch (err) {
        out.push({ name, ms: Date.now() - start, ok: false });
        throw err;
    }
}
/** Normalize the CLI-returned path (may be absolute under write root)
 *  to a path relative to `outDir`, tolerant of trailing separators. */
function outRelFromAbs(p, outDir) {
    return p.startsWith(outDir) ? p.slice(outDir.length).replace(/^\/+/, "") : p;
}
//# sourceMappingURL=banner.js.map