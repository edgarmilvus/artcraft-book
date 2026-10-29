// src/orchestration/gradeloop.ts
import { randomUUID } from "node:crypto";
import { FileCheckpointer, type Checkpoint, type StageId } from "../infra/checkpointer.js";
import { FilmCraftSession, type FilmCraftSessionOptions } from "../mcp/session.js";
import { discoverLumetri } from "../mcp/discovery.js";
import { WheelGrader } from "../services/wheel-grader.js";
import { DuckingEngine } from "../services/ducking-engine.js";
import { LoudnessGovernor } from "../services/loudness-governor.js";
import { GradingRecipeSchema, type GradingRecipe } from "../contracts/grading.js";
import { DuckingPolicySchema, type DuckingPolicy } from "../contracts/ducking.js";
import { LoudnessTargetSchema, type LoudnessTarget } from "../contracts/loudness.js";

export interface TenantJobRequest {
  readonly tenantId: string;
  readonly sourcePath: string;           // relative to read root
  readonly sequencePath: string;         // relative to read root
  readonly outputPath: string;           // relative to write root
  readonly recipe: GradingRecipe;
  readonly ducking: DuckingPolicy;
  readonly target: LoudnessTarget;
}

export interface TenantJobResult {
  readonly jobId: string;
  readonly resumedFrom: StageId | null;
  readonly grade: Awaited<ReturnType<WheelGrader["applyGrade"]>> | null;
  readonly ducking: Awaited<ReturnType<DuckingEngine["applyPolicy"]>> | null;
  readonly loudness: Awaited<ReturnType<LoudnessGovernor["govern"]>> | null;
  readonly previewFrameBase64: string | null;
}

const STAGE_ORDER: readonly StageId[] = ["open", "grade", "duck", "loudness", "preview"];

/**
 * GradeLoop orchestrates a single tenant job end-to-end. It is safe to
 * call twice with the same jobId: the checkpointer resumes from whatever
 * stage succeeded last, and the recipe/policy/target hashes are compared
 * to detect "same job, different inputs" (a cheap mistake that would
 * otherwise silently overwrite the previous grade).
 */
export class GradeLoop {
  public constructor(
    private readonly session: FilmCraftSession,
    private readonly checkpointer: FileCheckpointer,
    private readonly binaryArgs: FilmCraftSessionOptions,
  ) {}

  public async run(job: TenantJobRequest): Promise<TenantJobResult> {
    // Validate everything up-front; nothing below can throw a validation
    // error, so failure handling only concerns engine-level errors.
    const recipe  = GradingRecipeSchema.parse(job.recipe);
    const policy  = DuckingPolicySchema.parse(job.ducking);
    const target  = LoudnessTargetSchema.parse(job.target);

    const jobId = randomUUID();
    const recipeHash = FileCheckpointer.hash(recipe);
    const policyHash = FileCheckpointer.hash(policy);
    const targetHash = FileCheckpointer.hash(target);

    const existing = await this.safeLoad(jobId);
    let resumeIndex = 0;
    if (existing) {
      if (
        existing.recipeHash !== recipeHash ||
        existing.policyHash !== policyHash ||
        existing.targetHash !== targetHash
      ) {
        throw new Error(
          `job ${jobId} exists with different inputs; refusing to overwrite`,
        );
      }
      resumeIndex = STAGE_ORDER.indexOf(existing.stage) + 1;
    }

    // The checkpoint is advanced stage by stage, so the local copy is
    // mutable even though the stored record is not.
    const checkpoint: { -readonly [K in keyof Checkpoint]: Checkpoint[K] } = {
      jobId,
      stage: existing?.stage ?? "open",
      recipeHash,
      policyHash,
      targetHash,
      startedAt: existing?.startedAt ?? Date.now(),
      lastTouchedAt: Date.now(),
    };

    const result: MutableResult = {
      jobId,
      resumedFrom: existing?.stage ?? null,
      grade: null,
      ducking: null,
      loudness: null,
      previewFrameBase64: null,
    };

    await this.session.connect();
    const discovery = await discoverLumetri(this.session);
    const grader = new WheelGrader(this.session, discovery);
    const ducker = new DuckingEngine(this.session);
    const governor = new LoudnessGovernor(this.session);

    // Stage: open — place the source and sequence on the timeline. On
    // resumption this is a no-op if the sequence is already open.
    if (resumeIndex <= 0) {
      const open = await this.session.run("file.open", {
        path: job.sequencePath,
      });
      if (!open.ok) throw new Error(`open: ${open.error}`);
      checkpoint.stage = "open";
      checkpoint.lastTouchedAt = Date.now();
      await this.checkpointer.upsert(checkpoint);
      resumeIndex = 1;
    }

    // Stage: grade — first instantiate Lumetri on the target clip. We
    // assume the first video clip on V1 is the narrative target; a
    // production deployment would resolve this via markers or metadata.
    if (resumeIndex <= 1) {
      const sequence = await this.session.sequenceInspect();
      const videoClip = sequence.video[0]?.items[0];
      if (!videoClip) throw new Error("grade: no video clip on V1");
      const grade = await grader.applyGrade(videoClip.clip, recipe);
      result.grade = grade;
      checkpoint.stage = "grade";
      checkpoint.lastTouchedAt = Date.now();
      await this.checkpointer.upsert(checkpoint);
      resumeIndex = 2;
    }

    // Stage: duck — classify and duck.
    if (resumeIndex <= 2) {
      const ducking = await ducker.applyPolicy(policy);
      result.ducking = ducking;
      checkpoint.stage = "duck";
      checkpoint.lastTouchedAt = Date.now();
      await this.checkpointer.upsert(checkpoint);
      resumeIndex = 3;
    }

    // Stage: loudness — measure, match, enforce.
    if (resumeIndex <= 3) {
      const loudness = await governor.govern(target);
      result.loudness = loudness;
      if (!loudness.withinTolerance) {
        throw new Error(
          `loudness: converged to ${loudness.integratedLufs.toFixed(2)} LUFS but target was ${target.integratedLufs} ±0.5`,
        );
      }
      checkpoint.stage = "loudness";
      checkpoint.lastTouchedAt = Date.now();
      await this.checkpointer.upsert(checkpoint);
      resumeIndex = 4;
    }

    // Stage: preview — a proof frame for the reviewer UI.
    if (resumeIndex <= 4) {
      const frame = await this.session.renderFrame(undefined, 1280);
      result.previewFrameBase64 = frame;
      checkpoint.stage = "preview";
      checkpoint.lastTouchedAt = Date.now();
      await this.checkpointer.upsert(checkpoint);
    }

    await this.session.close();
    return result;
  }

  private async safeLoad(jobId: string): Promise<Checkpoint | null> {
    try {
      return await this.checkpointer.load(jobId);
    } catch {
      return null;
    }
  }
}

interface MutableResult {
  jobId: string;
  resumedFrom: StageId | null;
  grade: Awaited<ReturnType<WheelGrader["applyGrade"]>> | null;
  ducking: Awaited<ReturnType<DuckingEngine["applyPolicy"]>> | null;
  loudness: Awaited<ReturnType<LoudnessGovernor["govern"]>> | null;
  previewFrameBase64: string | null;
}
