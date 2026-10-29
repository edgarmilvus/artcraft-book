// src/vision-loop.ts
/**
 * Multimodal visual feedback loop.
 *
 * The loop is the reason the loopback channel exists: it lets a vision
 * model audit a render, and lets the same session commit a corrective
 * command in tens of milliseconds — no HTTP round-trip, no file save /
 * reload, no lost in-memory state.
 *
 * Flow:
 *  1. Ask the engine for a `ui.screenshot` (base64 PNG).
 *  2. Hand the PNG to a vision-capable LLM with a strict JSON contract.
 *  3. If the model says "fix", dispatch an ArtCraft command via the same
 *     authenticated session.
 *  4. Repeat until the model is satisfied or the iteration budget runs out.
 */
import type { CraftControlSession } from './session.js';

/** Contract expected from the vision model. */
type AuditDecision =
  | { status: 'ok' }
  | {
      status: 'fix';
      command: string;
      params: Record<string, unknown>;
      rationale?: string;
    };

/** Signature of the vision model call. */
export type VisionAuditor = (
  pngBase64: string,
  context: { iteration: number; documentSummary: string },
) => Promise<AuditDecision>;

export interface VisionLoopOptions {
  /** Maximum number of corrective iterations. */
  maxIterations?: number;
  /** Max side of the screenshot fed to the model. Defaults to 1024. */
  screenshotMaxSide?: number;
  /** Emit each iteration to the console for observability. */
  verbose?: boolean;
}

/**
 * Run the audit loop against a live session.
 *
 * @example
 *   const session = new CraftControlSession({ port: 7878, token });
 *   await session.connect();
 *   await session.executeCommand('layer.newAdjustmentLayer.curves', {
 *     points: [[0, 0], [64, 40], [192, 215], [255, 255]],
 *   });
 *   await runVisionLoop(session, myAuditor, { maxIterations: 4 });
 */
export async function runVisionLoop(
  session: CraftControlSession,
  auditor: VisionAuditor,
  opts: VisionLoopOptions = {},
): Promise<{ iterations: number; lastDecision: AuditDecision }> {
  const maxIterations = opts.maxIterations ?? 4;
  const maxSide = opts.screenshotMaxSide ?? 1024;
  const verbose = opts.verbose ?? false;

  let lastDecision: AuditDecision = { status: 'ok' };

  // Snapshot a coarse document summary once; the model uses it as context.
  const summary = await session.executeCommand<Record<string, unknown>>(
    'document.inspect',
    {},
  );
  const documentSummary = JSON.stringify({
    layers: (summary as { layers?: unknown }).layers,
    selection: (summary as { selection?: unknown }).selection,
  });

  for (let i = 0; i < maxIterations; i++) {
    if (verbose) {
      // eslint-disable-next-line no-console
      console.log(`[vision-loop] iteration ${i + 1}/${maxIterations}`);
    }

    // 1. Capture the current frame.
    const { dataBase64 } = await session.screenshot({
      maxSide,
    });

    // 2. Ask the model what to do.
    const decision = await auditor(dataBase64, {
      iteration: i,
      documentSummary,
    });
    lastDecision = decision;

    if (decision.status === 'ok') {
      if (verbose) {
        // eslint-disable-next-line no-console
        console.log('[vision-loop] model satisfied');
      }
      return { iterations: i + 1, lastDecision: decision };
    }

    // 3. Dispatch the corrective command.
    if (verbose) {
      // eslint-disable-next-line no-console
      console.log(
        `[vision-loop] applying ${decision.command} — ${decision.rationale ?? ''}`,
      );
    }
    await session.executeCommand(decision.command, decision.params);
  }

  return { iterations: maxIterations, lastDecision };
}
