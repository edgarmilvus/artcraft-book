// ─── src/convergence.ts ──────────────────────────────────────────────────────
import { Critique, CycleRecord, DesignBrief } from './contracts.js';

export type ConvergenceDecision =
  | { kind: 'accept'; reason: string }
  | { kind: 'iterate'; reason: string }
  | { kind: 'rollback'; stepsToUndo: number; reason: string }
  | { kind: 'escalate'; reason: string };

/* ------------------------------------------------------------------ *
 * Regression detector. If the current cycle's critique is VERDICT-WORSE
 * than the previous one, or the pixel delta is close to zero, we have
 * evidence of non-progress and should roll back rather than pile on
 * more adjustments.
 *
 * Voting scheme: severity-weighted finding count. Notice how the score
 * is intentionally asymmetric — one 'block' outweighs five 'info's.
 * ------------------------------------------------------------------ */
export function severityScore(c: Critique): number {
  let s = 0;
  for (const f of c.findings) {
    if (f.severity === 'block') s += 100;
    else if (f.severity === 'warn') s += 10;
    else s += 1;
  }
  return s;
}

/**
 * Evaluate a cycle history and decide the next action.
 *
 * Rules, in priority order:
 *   1. Hard-stop on any 'escalate' verdict from the model.
 *   2. Enforce the confidence floor — a low-confidence pass is not a pass.
 *   3. Accept a confident 'pass' (even on the last allowed cycle).
 *   4. Enforce the Max Iteration Policy for work that still wants to revise.
 *   5. Detect regression (severity worsens or delta ~ 0).
 *   6. Otherwise iterate.
 *
 * @param history Ordered cycle records (oldest first, newest last).
 * @param brief   The original brief (supplies guardrail constants).
 */
export function decide(
  history: CycleRecord[],
  brief: DesignBrief,
): ConvergenceDecision {
  if (history.length === 0) {
    return { kind: 'iterate', reason: 'cold start' };
  }

  const last = history[history.length - 1];
  const prev = history.length > 1 ? history[history.length - 2] : null;

  // Rule 1 — model requested human intervention.
  if (last.critique.verdict === 'escalate') {
    return { kind: 'escalate', reason: 'model requested escalation' };
  }

  // Rule 2 — confidence floor. This runs before the accept branch so a
  // confident-looking "pass" backed by a weak signal still reaches a human.
  if (last.critique.confidence < brief.confidenceFloor) {
    return {
      kind: 'escalate',
      reason: `confidence ${last.critique.confidence.toFixed(2)} below floor ${brief.confidenceFloor}`,
    };
  }

  // Rule 3 — accept. A pass on the final permitted cycle is still a pass;
  // the cap exists to stop further revision, not to reject good work.
  if (last.critique.verdict === 'pass') {
    return { kind: 'accept', reason: `confidence ${last.critique.confidence.toFixed(2)}` };
  }

  // Rule 4 — Max Iteration Policy. This is the hard ceiling for revisions.
  if (history.length >= brief.maxCycles) {
    return { kind: 'escalate', reason: `max cycles reached (${brief.maxCycles})` };
  }

  // Rule 5 — regression detection. Only meaningful from the second cycle,
  // where there is a baseline to compare against.
  if (prev) {
    const scoreNow = severityScore(last.critique);
    const scorePrev = severityScore(prev.critique);
    const regressed = scoreNow > scorePrev;
    const stalled = last.deltaVsPrev < 0.008; // < 0.8 % mean-abs pixel change
    if (regressed) {
      return {
        kind: 'rollback',
        stepsToUndo: last.appliedSteps,
        reason: `severity regressed from ${scorePrev} to ${scoreNow}; undoing cycle ${last.cycle}`,
      };
    }
    if (stalled) {
      return {
        kind: 'rollback',
        stepsToUndo: last.appliedSteps,
        reason: `stalled (delta ${(last.deltaVsPrev * 100).toFixed(2)} % < 0.8 %)`,
      };
    }
  }

  // Rule 6 — continue.
  return { kind: 'iterate', reason: `verdict 'revise' at cycle ${last.cycle}` };
}
