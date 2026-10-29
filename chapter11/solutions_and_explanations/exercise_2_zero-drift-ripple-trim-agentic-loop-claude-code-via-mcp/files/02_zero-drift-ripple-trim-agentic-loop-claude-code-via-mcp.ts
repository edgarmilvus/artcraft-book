import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ─── Exact constants ────────────────────────────────────────────────────────
export const TICKS_PER_MS   = 254_016_000n;                 // 254_016_000_000 / 1000
export const FRAME_TICKS_23976 = 10_594_584_000n;           // 254_016_000_000 × 1001 / 24000
const SLOT_TOLERANCE_MS = 0n;                         // strict

// ─── Round-half-to-even on BigInt rationals ─────────────────────────────────
// Given n/d > 0, return nearest integer with banker's rounding.
export function bankerRound(n: bigint, d: bigint): bigint {
  const q = n / d;            // trunc toward zero (both positive here)
  const r = n - q * d;        // remainder in [0, d)
  const twice = 2n * r;
  if (twice > d) return q + 1n;
  if (twice < d) return q;
  return (q % 2n === 0n) ? q : q + 1n;   // tie → even
}

export function snapToFrameTick(ms: number): bigint {
  if (!Number.isInteger(ms)) throw new Error("ms must be integer");
  const rawTick = BigInt(ms) * TICKS_PER_MS;         // exact lift
  // Nearest multiple of FRAME_TICKS using round-half-to-even on rawTick/frame.
  return bankerRound(rawTick, FRAME_TICKS_23976) * FRAME_TICKS_23976;
}

export interface TrimTarget {
  wordIndex: number;
  transcriptMs: number;
  direction: "extendPrev" | "pullNext";
}

export interface RippleAuditRow {
  wordIndex: number; fromTick: string; toTick: string;
  trimmedTicks: string; invariantPassed: boolean;
}
export interface RippleAudit {
  rows: RippleAuditRow[];
  totalDriftTicks: number;
  finalDurationTicks: string;
  frameTicksAt23976: string;
  blocked?: { missingMediaPaths: string[]; wouldRunCommands: string[] };
}

// ─── MCP helpers ────────────────────────────────────────────────────────────
async function mc<T = any>(client: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await client.callTool({ name, arguments: args });
  const txt = (r.content as any[]).find(c => c.type === "text")?.text ?? "{}";
  return JSON.parse(txt) as T;
}

// ─── Sum of clip durations in the active sequence ───────────────────────────
export function totalDurationTicks(seq: any): bigint {
  let total = 0n;
  for (const track of seq.tracks ?? []) {
    for (const clip of track.clips ?? []) {
      total += BigInt(clip.durationTicks ?? 0);
    }
  }
  return total;
}

// ─── Pure audit builder (the engine loop wraps this same invariant) ─────────
export function buildRippleAudit(
  targets: TrimTarget[],
  preTotal: bigint,
  postTotal: bigint,
  preTick: bigint,
  postTick: bigint,
): RippleAudit {
  const trimmed = preTick >= postTick ? preTick - postTick : postTick - preTick;
  const expected = preTotal - trimmed;
  const passed = postTotal === expected;
  const rows: RippleAuditRow[] = targets.map((target) => ({
    wordIndex: target.wordIndex,
    fromTick: preTick.toString(),
    toTick: postTick.toString(),
    trimmedTicks: (preTick - postTick).toString(),
    invariantPassed: passed,
  }));
  return {
    rows,
    totalDriftTicks: rows.filter((row) => !row.invariantPassed).length,
    finalDurationTicks: postTotal.toString(),
    frameTicksAt23976: FRAME_TICKS_23976.toString(),
  };
}

// ─── Main agent ─────────────────────────────────────────────────────────────
export async function runRipplePass(
  targets: TrimTarget[],
  workRoot: string,
): Promise<RippleAudit> {
  const transport = new StdioClientTransport({
    command: "filmcraft-cli",
    args: ["mcp",
           "--automation-read-root",  workRoot,
           "--automation-write-root", workRoot],
  });
  const client = new Client({ name: "ripple-agent", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  // ─── Precondition gate: doc_inspect finds missing media ────────────────
  const doc = await mc<any>(client, "doc_inspect");
  const missing: string[] = (doc.missingMedia ?? []).map((m: any) => m.path);
  if (missing.length > 0) {
    // Refuse to run — return the blocked record with the *planned* commands.
    const wouldRun = targets.map(t => {
      const tick = snapToFrameTick(t.transcriptMs).toString();
      const id = t.direction === "extendPrev"
        ? "trim.ripplePrevious" : "trim.rippleNext";
      return JSON.stringify({ id, params: { targetTick: tick } });
    });
    return {
      rows: [], totalDriftTicks: 0, finalDurationTicks: "0",
      frameTicksAt23976: FRAME_TICKS_23976.toString(),
      blocked: { missingMediaPaths: missing, wouldRunCommands: wouldRun },
    };
  }

  const seqBefore = await mc<any>(client, "sequence_inspect");
  const initialTotal = totalDurationTicks(seqBefore);
  const rows: RippleAuditRow[] = [];

  // ─── Batch-of-8 pass with stop_on_error and post-batch invariant ────────
  const BATCH = 8;
  for (let i = 0; i < targets.length; i += BATCH) {
    const slice = targets.slice(i, i + BATCH);
    const checkpoint = await mc<any>(client, "doc_inspect");
    const preTotal   = totalDurationTicks(checkpoint.activeSequence);
    const preTick    = BigInt(checkpoint.activeSequence.playheadTicks ?? 0);

    const steps = slice.map(t => {
      const snapped = snapToFrameTick(t.transcriptMs);
      const id = t.direction === "extendPrev"
        ? "trim.ripplePrevious" : "trim.rippleNext";
      // timeline.trim takes delta ticks r.t. current edges; we pass the
      // *absolute* target tick via trim.selectNearest + trim.extendToPlayhead
      // for the engine's "extend to playhead" semantics.
      return {
        id,
        params: { targetTick: Number(snapped), mode: "ripple" },
      };
    });

    const res = await mc<any>(client, "command_batch", { steps, stop_on_error: true });
    if (!res.ok) { await mc(client, "command_run", { id: "edit.undo", params: {} }); break; }

    const seqAfter = await mc<any>(client, "sequence_inspect");
    const postTotal = totalDurationTicks(seqAfter);
    const postTick  = BigInt(seqAfter.playheadTicks ?? 0);
    const trimmedInBatch = preTick - postTick;   // extend-prev shrinks leftward

    // Zero-tolerance invariant: postTotal must equal preTotal - trimmed.
    // (For pullNext, sign convention flips; both directions shrink the
    //  *sum* by exactly the trimmed amount.)
    const expected = preTotal - (trimmedInBatch < 0n ? -trimmedInBatch : trimmedInBatch);
    const passed   = (postTotal === expected);

    for (const t of slice) {
      const from = preTick;
      const to   = postTick;   // engine's playhead after the ripple
      rows.push({
        wordIndex: t.wordIndex,
        fromTick:  from.toString(),
        toTick:    to.toString(),
        trimmedTicks: (from - to).toString(),
        invariantPassed: passed,
      });
    }

    if (!passed) {
      // Roll the *entire* batch back and abort the pass.
      for (let k = 0; k < slice.length; k++) {
        await mc(client, "command_run", { id: "edit.undo", params: {} });
      }
      break;
    }
  }

  const seqFinal = await mc<any>(client, "sequence_inspect");
  const finalDuration = totalDurationTicks(seqFinal);

  // ─── Visual proof: last frame and one tick before ──────────────────────
  const lastTick = finalDuration - 1n;
  await mc(client, "render_frame", { seconds: Number(lastTick) / 254016000000 });
  await mc(client, "render_frame", { seconds: Number(finalDuration) / 254016000000 });

  await client.close();

  const totalDrift = rows.reduce((a, r) =>
    a + (r.invariantPassed ? 0 : 1), 0);
  return {
    rows, totalDriftTicks: totalDrift,
    finalDurationTicks: finalDuration.toString(),
    frameTicksAt23976: FRAME_TICKS_23976.toString(),
  };
}
