// src/11_auditor.ts
import type { CraftClient } from "./03_craft-client.js";
import type { Budget } from "./06_budget.js";
import { VisionVerdictSchema, type AuditCorrection, type AuditVerdict, type VisionModel } from "./04_types.js";

/**
 * The vision auditor: a closed loop that renders the active document, asks
 * an injected model whether the tones are right, and applies one corrective
 * adjustment layer when they are not.
 *
 * The model is injected as a `VisionModel` closure, exactly like the
 * copywriter's. That keeps the studio free of a vendor dependency, keeps
 * the loop deterministic under test, and means the auditor's answer is
 * validated against a schema before it is allowed to steer an engine.
 *
 * The loop is bounded: three attempts by default. The iteration cap is the
 * first line of defence against a model that never says "ok"; the budget
 * guardrail is the second.
 */
export class VisionAuditor {
  public constructor(
    private readonly photocraft: CraftClient,
    private readonly budget: Budget,
    private readonly visionModel: VisionModel,
    /** The name recorded in the verdict, for the audit trail. */
    private readonly modelName = "injected-vision",
  ) {}

  /**
   * Audit the active PhotoCraft document and, when the model asks for it,
   * apply a corrective adjustment layer. Returns the final verdict after
   * at most `maxAttempts` corrections.
   */
  public async auditAndCorrect(maxAttempts = 3): Promise<AuditVerdict> {
    let last: AuditVerdict | null = null;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const image = await this.snapshotActiveDoc();
      const verdict = VisionVerdictSchema.parse(
        await this.visionModel({
          mimeType: image.mimeType,
          base64: image.data,
          prompt: AUDIT_PROMPT,
        }),
      );
      this.budget.spendTokens(estimateTokens(image.data.length));

      if (verdict.status === "ok") {
        const passed: AuditVerdict = {
          passed: true,
          score: 1,
          reasons: [verdict.reason ?? "The vision auditor reports balanced tones."],
          corrections: last?.corrections ?? [],
          auditorModel: this.modelName,
        };
        return passed;
      }

      const correction = correctionFor(verdict);
      await this.applyCorrection(correction);
      last = {
        passed: false,
        score: 0.5,
        reasons: [verdict.reason ?? "The vision auditor requested a correction."],
        corrections: [correction],
        auditorModel: this.modelName,
      };
    }

    return (
      last ?? {
        passed: false,
        score: 0,
        reasons: ["The audit loop ran out of attempts without a passing verdict."],
        corrections: [],
        auditorModel: this.modelName,
      }
    );
  }

  /** Render the active document and return it as image bytes. */
  private async snapshotActiveDoc(): Promise<{ mimeType: string; data: string }> {
    const image = await this.photocraft.renderPreview(1024);
    return { mimeType: image.mimeType, data: image.data };
  }

  private async applyCorrection(correction: AuditCorrection): Promise<void> {
    if (correction.kind === "levels") {
      await this.photocraft.runCommand("layer.newAdjustmentLayer.levels", {
        gamma: correction.gamma ?? 1.1,
      });
      this.budget.spendCommands(1);
    } else if (correction.kind === "curves" && correction.points) {
      await this.photocraft.runCommand("layer.newAdjustmentLayer.curves", {
        points: correction.points,
      });
      this.budget.spendCommands(1);
    } else if (correction.kind === "exposure") {
      await this.photocraft.runCommand("layer.newAdjustmentLayer.exposure", {
        exposure: 0.05,
        offset: 0,
        gamma: 1,
      });
      this.budget.spendCommands(1);
    }
  }
}

/** The instruction the auditor sends with the rendered PNG. */
const AUDIT_PROMPT =
  'Audit this marketing image. If the shadows are clipped, answer ' +
  '{"status":"fix","fix":"levels","gamma":1.15,"reason":"..."}. If the ' +
  'exposure is off, answer {"status":"fix","fix":"exposure","reason":"..."}. ' +
  'If the contrast is flat, answer {"status":"fix","fix":"curves","reason":"..."}. ' +
  'If the image is fine, answer {"status":"ok"}.';

/** Map a model's verdict onto the adjustment layer that answers it. */
function correctionFor(verdict: {
  fix?: "levels" | "curves" | "exposure" | undefined;
  gamma?: number | undefined;
}): AuditCorrection {
  if (verdict.fix === "levels") {
    return { kind: "levels", gamma: verdict.gamma ?? 1.15 };
  }
  if (verdict.fix === "curves") {
    return { kind: "curves", points: [[0, 0], [64, 48], [192, 210], [255, 255]] };
  }
  return { kind: "exposure" };
}

/**
 * A conservative token estimate for one image. A vision model bills by
 * the tile count rather than the byte count, and the studio cannot know
 * the vendor's rate, so the budget is charged on a fixed cost per
 * rendered image plus the prompt.
 */
function estimateTokens(base64Length: number): number {
  return 800 + Math.ceil(base64Length / 4096) * 85;
}
