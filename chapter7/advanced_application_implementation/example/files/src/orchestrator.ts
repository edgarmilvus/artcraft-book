// ─── src/orchestrator.ts ─────────────────────────────────────────────────────
import { PhotoCraftSession, ApertureSession, BatchOutcome, SaveOutcome } from './session.js';
import { compileBaseEdit } from './base-edit.js';
import { prefilter, PrefilterVerdict } from './prefilter.js';
import { auditFrame, AuditFn } from './audit.js';
import { compileCorrections } from './compiler.js';
import { decide, ConvergenceDecision } from './convergence.js';
import { SnapshotRing } from './snapshots.js';
import {
  CHANNEL_PROFILES, Critique, CycleRecord, DesignBrief, DesignBriefSchema,
} from './contracts.js';
import { decodePngToRgba, meanAbsoluteDelta, RgbaFrame } from './pixels.js';

/** The loop should never run longer than this, even if a guardrail breaks. */
const MAX_SAFETY_CYCLES = 12;

export interface ApertureDeps {
  /** Pre-built session, e.g. a pooled one or a test double. */
  session?: ApertureSession;
  /** Vision auditor; defaults to GPT-4o. */
  audit?: AuditFn;
  /** Local pre-filter; defaults to histogram + optional CLIP. */
  prefilter?: (frame: RgbaFrame) => Promise<PrefilterVerdict>;
  /** Injectable clock, so tests can pin timestamps. */
  now?: () => number;
}

export interface ApertureRun {
  outcome:
    | 'accepted'
    | 'escalated'
    | 'rolled-back-then-escalated'
    | 'base-edit-failed'
    | 'safety-cap';
  history: CycleRecord[];
  artifactPath?: string;
  saved?: SaveOutcome;
  baseEdit?: BatchOutcome;
  finalDecision?: ConvergenceDecision;
}

/**
 * Run the full closed loop for one brief. Returns the final cycle
 * history and the outcome. Side effects: writes the artifact under the
 * target path whenever the run ends with a document worth keeping.
 */
export async function runApertureLoop(
  rawBrief: unknown,
  deps: ApertureDeps = {},
): Promise<ApertureRun> {
  const brief: DesignBrief = DesignBriefSchema.parse(rawBrief);
  const profile = CHANNEL_PROFILES[brief.channelProfile];

  const session: ApertureSession =
    deps.session ??
    new PhotoCraftSession(
      process.env.PC_READ_ROOT  ?? process.cwd(),
      process.env.PC_WRITE_ROOT ?? process.cwd(),
    );
  const audit = deps.audit ?? auditFrame;
  const runPrefilter = deps.prefilter ?? ((frame: RgbaFrame) => prefilter(frame));
  const now = deps.now ?? (() => Date.now());

  await session.boot();

  const snapshots = new SnapshotRing(4);
  const history: CycleRecord[] = [];

  try {
    // ── 1. Open the source and run the deterministic base edit ─────────
    const opened = await session.docOpen(brief.sourcePath);
    const baseEdit = await session.runCorrectionBatch(
      compileBaseEdit(brief, { width: opened.width, height: opened.height }),
    );
    if (baseEdit.failed > 0) {
      // A broken base edit is not something a vision model can repair.
      return { outcome: 'base-edit-failed', history, baseEdit };
    }

    // ── 2. The loop ────────────────────────────────────────────────────
    for (let cycle = 0; cycle < MAX_SAFETY_CYCLES; cycle++) {
      const startedAt = new Date(now()).toISOString();
      const t0 = now();

      // Capture the rendered frame (headless canvas, no window chrome).
      const shot = await session.preview(1536);
      const before = decodePngToRgba(shot.base64);

      // Cheap local pre-filter. A rejection skips the vision call and
      // becomes a synthetic block finding, which the compiler turns into
      // a conservative correction.
      const pre = await runPrefilter(before);
      const critique: Critique = pre.pass
        ? await audit(shot.base64, {
            brief,
            channel: { width: profile.width, height: profile.height },
            cycleIndex: cycle,
            priorFindings: history[history.length - 1]?.critique.findings,
          })
        : syntheticCritique(pre);

      // Compile into a command batch — allowlist-enforced in the session.
      const { steps } = compileCorrections(critique, profile.width, profile.height);

      // Record snapshot BEFORE applying, so rollback is possible.
      await snapshots.take(session, cycle);

      // Apply. The session turns a partial batch failure into a full
      // rollback and reports completed = 0.
      const applied = await session.runCorrectionBatch(steps);

      // Measure what this cycle's own edits changed, for the regression
      // detector. No edits → no delta.
      let deltaVsPrev = 0;
      if (applied.completed > 0) {
        const after = await session.preview(1536);
        const afterFrame = decodePngToRgba(after.base64);
        deltaVsPrev = meanAbsoluteDelta(before.data, afterFrame.data);
      }

      history.push({
        cycle,
        screenshot: shot.base64,
        critique,
        appliedSteps: applied.completed,
        deltaVsPrev,
        durationMs: Math.max(0, now() - t0),
        startedAt,
      });

      // Decide.
      const decision = decide(history, brief);
      switch (decision.kind) {
        case 'accept': {
          const saved = await session.save(brief.targetPath);
          return { outcome: 'accepted', history, artifactPath: saved.path, saved, baseEdit, finalDecision: decision };
        }

        case 'rollback': {
          await session.undo(decision.stepsToUndo);
          // After rollback, escalate — we do not attempt a further cycle
          // from a rolled-back state; the human decides.
          const saved = await session.save(brief.targetPath);
          return {
            outcome: 'rolled-back-then-escalated',
            history,
            artifactPath: saved.path,
            saved,
            baseEdit,
            finalDecision: decision,
          };
        }

        case 'escalate': {
          const saved = await session.save(brief.targetPath);
          return { outcome: 'escalated', history, artifactPath: saved.path, saved, baseEdit, finalDecision: decision };
        }

        case 'iterate':
          // Continue — the for-loop increments the cycle counter.
          break;
      }
    }

    // Unreachable while the reducer is correct; kept as a last resort so a
    // bug can never turn into an unbounded render loop.
    const saved = await session.save(brief.targetPath);
    return {
      outcome: 'safety-cap',
      history,
      artifactPath: saved.path,
      saved,
      baseEdit,
      finalDecision: { kind: 'escalate', reason: `safety cap at ${MAX_SAFETY_CYCLES} cycles` },
    };
  } finally {
    await session.shutdown();
    snapshots.clear();
  }
}

/** A pre-filter rejection expressed in the same vocabulary as the model. */
function syntheticCritique(pre: PrefilterVerdict): Critique {
  return {
    verdict: 'revise',
    confidence: 0.9,
    findings: [{
      axis: pre.topLabel.includes('clip') ? 'exposure' : 'artifacts',
      severity: 'block',
      message: pre.reason ?? 'pre-filter rejected frame',
    }],
    corrections: [],
    reviewerNote: 'pre-filter rejection',
  };
}
