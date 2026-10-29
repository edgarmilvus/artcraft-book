// src/pipelines/brand-hero.ts
import { StudioGovernor } from "../governor.js";

/**
 * Produce a brand hero image, an SVG lockup, and a design spread from a brief,
 * with a vision audit at the end. Runs on the SaaS backend under a policy that
 * grants this agent the "producer" role.
 *
 * The three engines do not share a vocabulary, and that is the point of the
 * example: PhotoCraft's meta-tools are `doc_new` / `command_run` / `doc_save`,
 * VectorCraft has no `doc_new` at all (its document is created with the
 * `file.new` *command*), and DesignCraft's are `new_document` / `execute` /
 * `save_document`. The governance layer is what makes that heterogeneity
 * survivable: the policy names the command ids, and the governor checks them
 * before the call ever reaches an engine.
 */
export async function runBrandHeroPipeline(
  gov: StudioGovernor,
  brief: { title: string; tagline: string; hex: string },
  outDir: string,
): Promise<{ raster: string; vector: string; spread: string; audit: string }> {
  const s = await gov.session("claude-code:brand-producer");
  try {
    // ── 1. Raster hero in PhotoCraft ──────────────────────────────────────
    const photo = s.craft("photocraft");
    await photo.call("doc_new", {
      width: 2400, height: 1350, mode: "rgb", depth: 8, background: "#0b0e14",
    });
    await photo.call("command_run", {
      id: "type.create",
      params: {
        text: brief.title.toUpperCase(),
        font: "Inter-Bold",
        size: 180,
        color: brief.hex,
        x: 200, y: 720,
      },
    });
    await photo.call("command_run", {
      id: "type.create",
      params: {
        text: brief.tagline,
        font: "Inter-Regular",
        size: 64,
        color: "#c7c9d1",
        x: 200, y: 880,
      },
    });
    await photo.call("command_run", {
      id: "layer.newAdjustmentLayer.curves",
      params: { points: [[0, 0], [64, 52], [192, 208], [255, 255]] },
    });
    await photo.call("command_run", {
      id: "filter.blur.gaussianBlur",
      params: { radius: 0.8 },
    });
    await photo.call("doc_save", { path: `${outDir}/hero.png`, format: "png" });

    // ── 2. Vision audit (multimodal loop) ────────────────────────────────
    const shot = await photo.call<Array<{ type: string; data?: string }>>(
      "ui_screenshot",
      { max_side: 1024 },
    );
    const balanced = await auditWithVisionLLM(shot);
    if (!balanced.ok) {
      await photo.call("command_run", {
        id: "layer.newAdjustmentLayer.levels",
        params: { gamma: balanced.suggestedGamma },
      });
      await photo.call("doc_save", { path: `${outDir}/hero.png`, format: "png" });
    }

    // ── 3. Vector lockup in VectorCraft ──────────────────────────────────
    // VectorCraft has no `doc_new` meta-tool: the document is created by
    // running the `file.new` command, and the text command is `text.create`.
    const vector = s.craft("vectorcraft");
    await vector.call("command_run", {
      id: "file.new",
      params: { width: 512, height: 512, backgroundContents: "transparent" },
    });
    await vector.call("command_run", {
      id: "shape.rectangle",
      params: { x: 32, y: 32, width: 448, height: 448, radius: 48 },
    });
    await vector.call("command_run", {
      id: "paint.setFill",
      params: { color: brief.hex },
    });
    await vector.call("command_run", {
      id: "text.create",
      params: { x: 80, y: 280, text: brief.title.slice(0, 1), size: 288, font: "Inter-Bold", color: "#0b0e14" },
    });
    await vector.call("command_run", {
      id: "document.export",
      params: { path: `${outDir}/mark.svg`, format: "svg", outlineText: true },
    });

    // ── 4. Design spread in DesignCraft ──────────────────────────────────
    // DesignCraft's meta-tools are `new_document` / `execute` / `save_document`,
    // and `place_image` is a meta-tool rather than a command.
    const design = s.craft("designcraft");
    await design.call("new_document", {
      preset: "A4", pages: 1, facingPages: false, margins: 36,
    });
    await design.call("execute", {
      command: "frame.create",
      params: { rect: [36, 36, 559, 330], content: "text", text: brief.title },
    });
    await design.call("execute", {
      command: "type.char",
      params: { attrs: { fontFamily: "Inter", fontStyle: "Bold", size: 72 } },
    });
    await design.call("execute", {
      command: "frame.create",
      params: { rect: [36, 380, 559, 400], content: "graphic" },
    });
    await design.call("place_image", { frame: 2, path: `${outDir}/hero.png` });
    await design.call("save_document", { path: `${outDir}/spread.designcraft` });

    // ── 5. Return the audit tail so the caller can anchor the receipt ────
    const tail = gov.auditTail;
    return {
      raster: `${outDir}/hero.png`,
      vector: `${outDir}/mark.svg`,
      spread: `${outDir}/spread.designcraft`,
      audit: `sha256:${tail.hash}`,
    };
  } finally {
    await s.close();
  }
}

/**
 * The multimodal audit stub. In production this forwards the base64 image to
 * an LLM with a JSON-Schema response format. We return a small policy-shaped
 * decision here so the pipeline compiles in isolation.
 */
async function auditWithVisionLLM(
  _shot: Array<{ type: string; data?: string }>,
): Promise<{ ok: boolean; suggestedGamma: number }> {
  return { ok: true, suggestedGamma: 1.0 };
}
