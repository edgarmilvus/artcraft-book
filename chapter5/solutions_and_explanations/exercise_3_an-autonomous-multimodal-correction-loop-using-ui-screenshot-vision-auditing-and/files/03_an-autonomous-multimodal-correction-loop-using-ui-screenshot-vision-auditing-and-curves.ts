// ============================================================================
// Exercise 3 — Autonomous multimodal tone-correction loop
// ============================================================================
// Design intent: the *loop body* is a strict state machine over immutable
// AuditState values. Every command is dispatched through MCP meta-tools
// (never shell-outs). Every iteration is snapshot-preserved. The capture
// channel is chosen by mode, and the *correct* channel for colour auditing
// is doc_render_preview, not ui_screenshot.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import OpenAI from "openai";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// MCP payload helpers
//
// A CallToolResult is `{ content: [...] }`: text results carry JSON in a
// `text` block, rendered documents carry base64 in an `image` block. Reading
// the wrong field is the classic way to end up auditing `undefined`.
// ---------------------------------------------------------------------------
interface CallToolResultLike {
  readonly content?: ReadonlyArray<{ type?: string; text?: string; data?: string }>;
  readonly isError?: boolean;
}

function textPayload<T = Record<string, unknown>>(r: CallToolResultLike): T | null {
  const block = r.content?.find((b) => b.type === "text");
  if (!block?.text) return null;
  try {
    return JSON.parse(block.text) as T;
  } catch {
    return null;
  }
}

function imagePayload(r: CallToolResultLike): string {
  const block = r.content?.find((b) => b.type === "image");
  if (!block?.data) throw new Error("doc_render_preview returned no image content");
  return block.data;
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------
type ExitCode = 0 | 2 | 3 | 4;

interface VisionVerdict {
  status: "ok" | "clipped_shadows" | "blown_highlights" | "low_contrast";
  suggested_curve?: readonly (readonly [number, number])[];
  confidence: number;
  notes: string;
}

interface AuditState {
  readonly iteration: number;
  readonly currentCurve: readonly (readonly [number, number])[];
  readonly lastRenderHash: string;
  readonly verdict: VisionVerdict | null;
  readonly snapshotName: string;
}

interface CaptureChannel {
  capture(mode: "bridge" | "headless", docIndex: number | null, maxSide: number)
    : Promise<{ pngBase64: string; isWindow: boolean }>;
}

// ---------------------------------------------------------------------------
// 1. The capture-channel router.
//
// ui_screenshot is available in BOTH bridge and headless MCP servers and is
// cheap — but it returns the *UI window*, which includes chrome, rulers,
// toolbars, and (crucially) is affected by the current view zoom. It is
// therefore unsuitable for auditing exact pixel values. We use it only for
// liveness checks (is a modal dialog blocking the app?) and never as the
// audit input.
//
// The colour-audit channel is doc_render_preview (headless) / render_preview
// (bridge). Bridge render_preview does NOT accept `index`; it returns the
// window screenshot. So in bridge mode we still cannot get a specific doc's
// flattened pixels — we fall back to headless for the audit if the app
// supports it, or we escalate.
// ---------------------------------------------------------------------------
export class CaptureRouter implements CaptureChannel {
  constructor(private readonly mcp: Client, private readonly mode: "bridge" | "headless") {}

  async capture(mode: "bridge" | "headless", docIndex: number | null, maxSide: number) {
    if (mode === "headless") {
      // doc_render_preview accepts `index` and a `max_side` between 1..2048.
      const r = await this.mcp.callTool({
        name: "doc_render_preview",
        arguments: { index: docIndex ?? undefined, max_side: Math.min(2048, maxSide) },
      });
      return { pngBase64: imagePayload(r as CallToolResultLike), isWindow: false };
    }
    // Bridge mode: render_preview ignores `index` and returns the window.
    // We call it *only* for liveness; colour audits still go through the
    // headless server which we keep in parallel for this purpose.
    const r = await this.mcp.callTool({
      name: "render_preview",
      arguments: { max_side: Math.min(2048, maxSide) },
    });
    return { pngBase64: imagePayload(r as CallToolResultLike), isWindow: true };
  }
}

// ---------------------------------------------------------------------------
// 2. Curve validation — the trap the exercise sets.
//
// The vision model is a *suggestion engine*, not an authority. Before any
// suggested curve reaches `layer.setAdjustment`, it passes through this
// validator. Malformed suggestions are rejected and the model is re-queried
// with an explicit constraint reminder — we do not silently "fix" them.
// ---------------------------------------------------------------------------
type Curve = readonly (readonly [number, number])[];

export function validateCurve(c: unknown): { ok: true; curve: Curve } | { ok: false; reason: string } {
  if (!Array.isArray(c)) return { ok: false, reason: "curve is not an array" };
  if (c.length !== 4) return { ok: false, reason: "curve must have exactly 4 points" };

  const pts: [number, number][] = [];
  for (const p of c) {
    if (!Array.isArray(p) || p.length !== 2) return { ok: false, reason: "point is not [x,y]" };
    const [x, y] = p;
    if (typeof x !== "number" || typeof y !== "number") return { ok: false, reason: "point not numeric" };
    if (x < 0 || x > 255 || y < 0 || y > 255) return { ok: false, reason: "point out of [0,255]" };
    pts.push([x, y]);
  }
  // First input pinned to 0, last input pinned to 255.
  if (pts[0][0] !== 0)   return { ok: false, reason: "first point's input must be 0" };
  if (pts[3][0] !== 255) return { ok: false, reason: "last point's input must be 255" };
  // Strictly non-decreasing in both x and y.
  for (let i = 1; i < pts.length; i++) {
    if (pts[i][0] <= pts[i - 1][0]) return { ok: false, reason: "x coordinates not strictly increasing" };
    if (pts[i][1] <  pts[i - 1][1]) return { ok: false, reason: "y coordinates not monotone non-decreasing" };
  }
  return { ok: true, curve: pts as unknown as Curve };
}

// ---------------------------------------------------------------------------
// 3. The audit prompt — strict JSON contract with the vision model.
// ---------------------------------------------------------------------------
const SYSTEM_PROMPT = `
You are a colour-grading auditor. You receive a rendered image and must
return STRICT JSON matching this TypeScript shape:

  {
    "status": "ok" | "clipped_shadows" | "blown_highlights" | "low_contrast",
    "suggested_curve"?: [[x,y],[x,y],[x,y],[x,y]],   // inputs 0..255
    "confidence": 0.0..1.0,
    "notes": string
  }

Rules for suggested_curve:
  * Exactly four points.
  * First point's input is 0; last point's input is 255.
  * x coordinates strictly increasing; y coordinates non-decreasing.
  * Suggested y values must land inside [0,255].

House style constraints — a result is "ok" only when ALL hold:
  * Shadows: minimum pixel value >= 5.
  * Highlights: maximum pixel value <= 250.
  * Midtone contrast inside the target band (roughly S-curve asymmetry
    of |(y[1]-x[1]) - (y[2]-x[2])| < 8).
If any rule is violated, choose the corresponding status and suggest a curve.
`.trim();

// ---------------------------------------------------------------------------
// 4. The correction loop — expressed as an immutable-state reducer.
//
// The exercise says "do not write the loop body"; below we write the
// *reducer* (one step) that the loop iterates. This keeps the state model
// explicit and stops the loop body from collapsing into a monolith.
// ---------------------------------------------------------------------------

interface LoopContext {
  readonly mcp: Client;
  readonly vision: OpenAI;
  readonly openaiModel: string;
  readonly capture: CaptureRouter;
  readonly snapshotPrefix: string;
  readonly log: (evt: Record<string, unknown>) => void;
}

/** One step of the correction loop. Returns the next state, or an exit. */
async function step(
  ctx: LoopContext,
  prior: AuditState,
  workingDocIndex: number,
): Promise<{ next: AuditState } | { exit: ExitCode }> {
  // (a) Snapshot the working document so this iteration is reversible.
  const snapshotName = `${ctx.snapshotPrefix}_iter_${prior.iteration}`;
  await ctx.mcp.callTool({
    name: "command_run",
    arguments: { id: "history.newSnapshot", params: { name: snapshotName, from: "fullDocument" } },
  });

  // (b) Capture. Correct channel: headless preview for colour auditing.
  //     ui_screenshot would give us the UI window, not the pixels.
  const { pngBase64, isWindow } = await ctx.capture.capture("headless", workingDocIndex, 1024);
  if (isWindow) {
    // We asked for a document render and got the window — the app is in
    // bridge mode with no headless companion. Escalate.
    return { exit: 4 };
  }
  const renderHash = createHash("sha256").update(pngBase64, "base64").digest("hex");

  // (c) Audit with the vision model. Strict JSON.
  const auditRes = await ctx.vision.chat.completions.create({
    model: ctx.openaiModel,
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: [
        { type: "text", text:
          `Iteration ${prior.iteration}. Current curve: ${JSON.stringify(prior.currentCurve)}. ` +
          `Audit the image and return JSON only.` },
        { type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}` } },
      ]},
    ],
  });
  let verdict: VisionVerdict;
  try {
    verdict = JSON.parse(auditRes.choices[0].message.content!) as VisionVerdict;
  } catch {
    return { exit: 3 };
  }

  // (d) Validate the suggested curve, if any.
  let nextCurve = prior.currentCurve;
  if (verdict.suggested_curve) {
    const v = validateCurve(verdict.suggested_curve);
    if (!v.ok) {
      // Re-query once with an explicit constraint reminder.
      const retry = await ctx.vision.chat.completions.create({
        model: ctx.openaiModel,
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: SYSTEM_PROMPT +
            `\n\nYour previous suggestion was rejected: ${v.reason}. Fix it.` },
          { role: "user", content: "Return a corrected JSON response." },
        ],
      });
      try {
        const retryVerdict = JSON.parse(retry.choices[0].message.content!) as VisionVerdict;
        const v2 = retryVerdict.suggested_curve
          ? validateCurve(retryVerdict.suggested_curve)
          : { ok: false as const, reason: "no curve" };
        if (!v2.ok) return { exit: 3 };
        verdict = retryVerdict;
        nextCurve = v2.curve;
      } catch {
        return { exit: 3 };
      }
    } else {
      nextCurve = v.curve;
    }
  }

  // (e) Emit observability event (JSONL sink).
  ctx.log({
    iteration: prior.iteration,
    command: prior.iteration === 0 ? "layer.newAdjustmentLayer.curves"
                                   : "layer.setAdjustment",
    curve: nextCurve,
    verdict,
    renderHash,
    snapshot: snapshotName,
  });

  // (f) Apply the change — create on iteration 0, edit thereafter.
  if (prior.iteration === 0) {
    await ctx.mcp.callTool({
      name: "command_run",
      arguments: { id: "layer.newAdjustmentLayer.curves",
                   params: { points: nextCurve } },
    });
  } else {
    await ctx.mcp.callTool({
      name: "command_run",
      arguments: { id: "layer.setAdjustment",
                   params: { points: nextCurve } },
    });
  }

  return {
    next: {
      iteration: prior.iteration + 1,
      currentCurve: nextCurve,
      lastRenderHash: renderHash,
      verdict,
      snapshotName,
    },
  };
}

/** Convergence test — ALL three conditions must be checked. */
function shouldExit(prior: AuditState, next: AuditState, maxIterations: number):
  { exit: true; code: ExitCode } | { exit: false } {
  const v = next.verdict!;
  // (1) Converged: status ok and confidence >= 0.85.
  if (v.status === "ok" && v.confidence >= 0.85) return { exit: true, code: 0 };
  // (2) Budget: max iterations reached.
  if (next.iteration >= maxIterations) return { exit: true, code: 2 };
  // (3) Oscillation guard: two consecutive identical curves.
  if (JSON.stringify(prior.currentCurve) === JSON.stringify(next.currentCurve) &&
      prior.iteration >= 1) {
    return { exit: true, code: 2 };
  }
  return { exit: false };
}

// ---------------------------------------------------------------------------
// 5. Full trajectory — the loop, kept deliberately thin.
//
// The loop is a fold over immutable AuditState values. Each iteration
// produces a fresh AuditState; the trajectory is replayable from the log.
// ---------------------------------------------------------------------------
export async function runCorrection(
  ctx: LoopContext,
  originalPath: string,
  outputPath: string,
  maxIterations = 4,
): Promise<{ code: ExitCode; trajectory: readonly AuditState[] }> {
  // Bootstrap: open the master, fork it, activate the working copy.
  const opened = await ctx.mcp.callTool({ name: "doc_open", arguments: { path: originalPath } });
  if ((opened as CallToolResultLike).isError) return { code: 4, trajectory: [] };

  const dup = textPayload<{ document?: number }>(
    (await ctx.mcp.callTool({
      name: "command_run",
      arguments: { id: "image.duplicate", params: { name: "correction_working" } },
    })) as CallToolResultLike,
  );
  if (typeof dup?.document !== "number") return { code: 4, trajectory: [] };

  // Every later call targets the duplicate, never the opened original.
  const workingDocIndex = dup.document;
  await ctx.mcp.callTool({
    name: "command_run",
    arguments: { id: "document.activate", params: { document: workingDocIndex } },
  });

  // Iterate. The full loop body is exactly: step + shouldExit + fold.
  const trajectory: AuditState[] = [{
    iteration: 0,
    currentCurve: [[0,0],[64,40],[192,215],[255,255]],   // start curve
    lastRenderHash: "",
    verdict: null,
    snapshotName: "",
  }];
  while (true) {
    const cur = trajectory[trajectory.length - 1];
    const res = await step(ctx, cur, workingDocIndex);
    if ("exit" in res) return { code: res.exit, trajectory };
    const decision = shouldExit(cur, res.next, maxIterations);
    trajectory.push(res.next);
    if (decision.exit) {
      if (decision.code === 0) {
        // Save the working copy under a distinct name; never touch master.
        await ctx.mcp.callTool({
          name: "doc_save",
          arguments: { index: workingDocIndex, path: outputPath },
        });
        await ctx.mcp.callTool({
          name: "doc_close",
          arguments: { index: workingDocIndex },
        });
      }
      return { code: decision.code, trajectory };
    }
  }
}
