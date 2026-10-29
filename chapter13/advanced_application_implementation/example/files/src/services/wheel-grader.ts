// src/services/wheel-grader.ts
import { randomUUID } from "node:crypto";
import type { FilmCraftSession } from "../mcp/session.js";
import type { LumetriDiscovery, WheelBand } from "../mcp/discovery.js";
import type { GradingRecipe } from "../contracts/grading.js";
import { GradingRecipeSchema } from "../contracts/grading.js";

export interface GradeReport {
  readonly jobId: string;
  readonly clipId: number;
  readonly stepsDispatched: number;
  readonly stepsFailed: number;
  readonly previewFrameBase64: string;
}

/**
 * GradingService applies a three-way colour grade to exactly one clip.
 * It owns the ordering discipline: preset → section toggle → nine wheel
 * writes → exposure / contrast trims. Ordering matters because Lumetri
 * treats the wheel section independently from Basic Correction, and if
 * the section is disabled the wheel writes are silently discarded by the
 * engine. The service therefore enables the section first.
 */
export class WheelGrader {
  constructor(
    private readonly session: FilmCraftSession,
    private readonly discovery: LumetriDiscovery,
  ) {}

  /**
   * Apply a grade. The recipe is re-validated here so that callers can
   * never bypass validation by constructing objects that look correct.
   */
  public async applyGrade(
    clipId: number,
    rawRecipe: unknown,
  ): Promise<GradeReport> {
    const recipe: GradingRecipe = GradingRecipeSchema.parse(rawRecipe);
    const jobId = randomUUID();

    const steps: Array<{ id: string; params: Record<string, unknown> }> = [];

    // 1. The effect has to be on the clip before a parameter can be written.
    //    `effects.apply` accepts the display name, while `effects.setParam`
    //    only accepts the effect id — the discovery resolves both.
    steps.push({
      id: this.discovery.applyEffectId,
      params: { clips: [clipId], effect: this.discovery.effectName },
    });

    // 2. The wheel section has to be on, or the wheel writes are discarded.
    steps.push({
      id: this.discovery.setParamId,
      params: {
        clip: clipId,
        effect: this.discovery.effectId,
        param: "wheels_on",
        value: true,
        merge: false,
      },
    });

    // 3. Six wheel writes, in a fixed order: one colour vector and one
    //    luma offset per band. The engine stores a band as a single vector,
    //    so hue and saturation travel together.
    for (const band of ["shadows", "midtones", "highlights"] as const) {
      const vector = recipe.grade[band];
      const params = this.wheelParamsFor(band);
      steps.push({
        id: this.discovery.setParamId,
        params: {
          clip: clipId,
          effect: this.discovery.effectId,
          param: params.colour,
          // The engine wants the colour as [hue, saturation], normalised to
          // 0..1. The contract speaks in degrees and per cent.
          value: [vector.hue / 360, vector.saturation / 100],
          merge: false,
        },
      });
      steps.push({
        id: this.discovery.setParamId,
        params: {
          clip: clipId,
          effect: this.discovery.effectId,
          param: params.luma,
          value: vector.luminance / 100,
          merge: false,
        },
      });
    }

    // 4. Exposure and contrast trims ride on Basic Correction.
    steps.push({
      id: this.discovery.setParamId,
      params: {
        clip: clipId,
        effect: this.discovery.effectId,
        param: "exposure",
        value: recipe.grade.exposure,
        merge: false,
      },
    });
    steps.push({
      id: this.discovery.setParamId,
      params: {
        clip: clipId,
        effect: this.discovery.effectId,
        param: "contrast",
        value: recipe.grade.contrast / 100,
        merge: false,
      },
    });

    // 5. Dispatch atomically-ish. `stop_on_error: true` prevents a broken
    //    wheel write from cascading; the invariant "all or nothing" is
    //    enforced by the caller rolling back history on partial failure.
    const results = await this.session.batch(steps, true);
    const failed = results.filter((r) => !r.ok).length;
    if (failed > 0) {
      // Caller (orchestrator) is responsible for undo; we surface the
      // count so it can decide whether to abandon the tenant job.
      throw new GradeDispatchError(jobId, clipId, failed, results);
    }

    // 6. Produce a proof frame so the reviewer UI can surface the grade
    //    before the pipeline continues into the audio stage.
    const frame = await this.session.renderFrame(undefined, 960);
    return {
      jobId,
      clipId,
      stepsDispatched: steps.length,
      stepsFailed: 0,
      previewFrameBase64: frame,
    };
  }

  private wheelParamsFor(band: WheelBand): { colour: string; luma: string } {
    const entry = this.discovery.wheelParams[band];
    if (!entry) {
      throw new Error(`wheel parameters missing for ${band}`);
    }
    return entry;
  }
}

export class GradeDispatchError extends Error {
  public constructor(
    public readonly jobId: string,
    public readonly clipId: number,
    public readonly failureCount: number,
    public readonly results: ReadonlyArray<{ ok: boolean; error?: string }>,
  ) {
    super(`grade dispatch failed for clip ${clipId}: ${failureCount} step(s)`);
    this.name = "GradeDispatchError";
  }
}
