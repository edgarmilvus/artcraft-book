import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const TICKS_PER_SAMPLE = 5_292_000n;               // 254_016_000_000 / 48_000
export const PASS_THRESHOLD   = 10_584_000n;              // 2 samples @ 48 kHz

export interface SyncAnchor { anchorId: string; anchorTick: number; description: string; }

export interface SyncAnchorResult {
  anchorId: string;
  visualEventTick: number | null;
  audioTransientTick: number | null;
  driftTicks: number | null;
  rejected: boolean;
  rejectReason?: "llm_out_of_bounds" | "no_event_found" | "audio_envelope_flat";
}

export interface SyncQcReport {
  anchors: SyncAnchorResult[];
  maxDriftTicks: number;
  passThresholdTicks: number;
  rejectedAnchors: number;
  systematicOffsetCorrection: {
    applied: boolean; deltaTicks: number;
    residualBefore: number; residualAfter: number;
  };
  verdict: "pass" | "fail" | "inconclusive";
  rationale: string;
}

async function mc<T = any>(c: Client, name: string, args: Record<string, unknown> = {}): Promise<T> {
  const r = await c.callTool({ name, arguments: args });
  const txt = (r.content as any[]).find(x => x.type === "text")?.text ?? "{}";
  return JSON.parse(txt) as T;
}
async function mcImage(c: Client, name: string, args: Record<string, unknown>): Promise<Buffer> {
  const r = await c.callTool({ name, arguments: args });
  const img = (r.content as any[]).find(x => x.type === "image");
  return Buffer.from(img.data, "base64");
}

// ─── Deterministic pixel→tick: scale to a common *integer* denominator ──────
// visualTick = anchor + ((pxX − W/2) / W) × visibleDurationTicks
// We rewrite as: visualTick = anchor + ( (2*pxX − W) * visibleDuration ) / (2*W)
// with every term an integer; final division is exact (W divides by construction).
export function pixelXToTick(
  anchorTick: bigint, pxX: number, pageW: number, pageH: number,
  visibleDurationTicks: bigint,
): bigint {
  if (!Number.isInteger(pxX) || !Number.isInteger(pageW) || !Number.isInteger(pageH))
    throw new Error("pixel/rect values must be integral");
  const Wb = BigInt(pageW);
  const num = (2n * BigInt(pxX) - Wb) * visibleDurationTicks;
  const den = 2n * Wb;
  // Round-half-to-even for stability.
  const q = num / den, r = num - q * den, twice = (r < 0n ? -r : r) * 2n;
  const absDen = den < 0n ? -den : den;
  const rounded = (twice > absDen) ? (q + (num >= 0n ? 1n : -1n))
                : (twice < absDen) ? q
                : ((q & 1n) === 0n ? q : q + 1n);
  return anchorTick + rounded;
}

// ─── Vision LLM helper (must send base64, must validate bounds) ─────────────
async function askVision(
  pngBase64: string,
  pageRect: { x: number; y: number; width: number; height: number; },
  description: string,
): Promise<{ x: number; y: number } | null> {
  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "gpt-4o",
      response_format: { type: "json_object" },
      messages: [{
        role: "user",
        content: [
          { type: "text", text:
              `Locate the ${description} in this Program-monitor frame. ` +
              `Return {"x": <int>, "y": <int>, "confidence": 0..1} or ` +
              `{"x": null, "y": null} if not present. Coordinates are ` +
              `within the ${pageRect.width}×${pageRect.height} image.` },
          { type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}` } },
        ],
      }],
    }),
  });
  const j: any = await resp.json();
  const parsed = JSON.parse(j.choices[0].message.content);
  if (parsed.x == null || parsed.y == null) return null;
  if (parsed.x < 0 || parsed.x >= pageRect.width ||
      parsed.y < 0 || parsed.y >= pageRect.height) return null;
  return { x: Math.trunc(parsed.x), y: Math.trunc(parsed.y) };
}

// ─── Read audio transient tick from sequence waveform peaks ─────────────────
async function audioTransientTickNear(
  c: Client, anchorTick: bigint, searchRadiusTicks: bigint,
): Promise<bigint | null> {
  const seq = await mc<any>(c, "sequence_inspect");
  const peaks: { tick: string; peakDb: number }[] = seq.waveformPeaks ?? [];
  let best: bigint | null = null;
  for (const p of peaks) {
    const t = BigInt(p.tick);
    const d = t > anchorTick ? t - anchorTick : anchorTick - t;
    if (d > searchRadiusTicks) continue;
    if (best === null || (t > best ? t - anchorTick : anchorTick - t) <
                         (best > anchorTick ? best - anchorTick : anchorTick - best)) {
      best = t;
    }
  }
  return best;
}

// ─── Pure report builder (the bridge loop calls it after measuring) ───────
export function buildSyncReport(
  anchors: SyncAnchorResult[],
  threshold: bigint = PASS_THRESHOLD,
): SyncQcReport {
  const valid = anchors.filter((anchor) => !anchor.rejected && anchor.driftTicks !== null);
  const maxDrift = valid.length ? Math.max(...valid.map((anchor) => anchor.driftTicks!)) : 0;
  const rejected = anchors.filter((anchor) => anchor.rejected).length;
  const ratio = anchors.length ? rejected / anchors.length : 1;
  const correction = {
    applied: false, deltaTicks: 0,
    residualBefore: maxDrift, residualAfter: maxDrift,
  };
  let verdict: "pass" | "fail" | "inconclusive";
  let rationale: string;
  if (ratio > 0.20) {
    verdict = "inconclusive";
    rationale = `${rejected}/${anchors.length} anchors were rejected, so the residual is not representative.`;
  } else if (BigInt(maxDrift) <= threshold) {
    verdict = "pass";
    rationale = `Maximum drift ${maxDrift} ticks is below the two-sample threshold ${threshold}.`;
  } else {
    verdict = "fail";
    rationale = `Maximum drift ${maxDrift} ticks exceeds the two-sample threshold ${threshold}.`;
  }
  return {
    anchors, maxDriftTicks: maxDrift, passThresholdTicks: Number(threshold),
    rejectedAnchors: rejected, systematicOffsetCorrection: correction,
    verdict, rationale,
  };
}

// ─── Main loop ──────────────────────────────────────────────────────────────
export async function runSyncQc(
  anchors: SyncAnchor[],
  bridgePort: number,
): Promise<SyncQcReport> {
  const transport = new StdioClientTransport({
    command: "filmcraft-cli",
    args: ["mcp", "--connect", String(bridgePort)],
  });
  const client = new Client({ name: "sync-qc", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  async function measureOnce(): Promise<SyncAnchorResult[]> {
    const ui = await mc<any>(client, "ui_inspect");
    const pageRect = ui.programMonitorRect as { x: number; y: number; width: number; height: number };
    // visibleDurationTicks = zoom × TPS, where zoom is "seconds visible".
    const visibleDurationTicks = BigInt(Math.round(ui.zoomVisibleSeconds * 254_016_000_000));
    const results: SyncAnchorResult[] = [];
    for (const a of anchors) {
      const anchorTick = BigInt(a.anchorTick);
      await mc(client, "command_run", {
        id: "playhead.set", params: { ticks: Number(anchorTick) },
      });
      const png = await mcImage(client, "ui_screenshot", { panel: "Program" });
      const vision = await askVision(png.toString("base64"), pageRect, a.description);
      if (!vision) {
        results.push({
          anchorId: a.anchorId, visualEventTick: null, audioTransientTick: null,
          driftTicks: null, rejected: true, rejectReason: "no_event_found",
        });
        continue;
      }
      const visualTick = pixelXToTick(
        anchorTick, vision.x, pageRect.width, pageRect.height, visibleDurationTicks);
      const audioTick = await audioTransientTickNear(client, anchorTick, visibleDurationTicks / 4n);
      if (audioTick === null) {
        results.push({
          anchorId: a.anchorId, visualEventTick: Number(visualTick),
          audioTransientTick: null, driftTicks: null, rejected: true,
          rejectReason: "audio_envelope_flat",
        });
        continue;
      }
      const drift = visualTick > audioTick ? visualTick - audioTick : audioTick - visualTick;
      results.push({
        anchorId: a.anchorId, visualEventTick: Number(visualTick),
        audioTransientTick: Number(audioTick), driftTicks: Number(drift),
        rejected: false,
      });
    }
    return results;
  }

  const before = await measureOnce();
  const valid = before.filter(r => !r.rejected && r.driftTicks !== null);
  const maxBefore = valid.length ? Math.max(...valid.map(r => r.driftTicks!)) : 0;

  let correction = {
    applied: false, deltaTicks: 0,
    residualBefore: maxBefore, residualAfter: maxBefore,
  };

  // Systematic check: are at least 3 anchors drifting in the *same* direction?
  const signed = valid
    .map(r => r.visualEventTick! - r.audioTransientTick!)
    .filter(v => v !== 0);
  const allEarly  = signed.length >= 3 && signed.every(v => v > 0);
  const allLate   = signed.length >= 3 && signed.every(v => v < 0);

  if ((allEarly || allLate) && maxBefore >= Number(PASS_THRESHOLD)) {
    const meanSigned = Math.round(signed.reduce((a, b) => a + b, 0) / signed.length);
    // Apply a single timeline-wide offset to all audio clips on the dialogue
    // track, in one atomic undoable batch. FilmCraft's standard offset is the
    // `motion` effect's `position` — but for *audio* clips the semantically
    // correct parameter is the clip's own delay via `effects.setParam`
    // on the built-in "audio" effect's `offsetMs` (engine schema).
    const seq = await mc<any>(client, "sequence_inspect");
    const audioTrack = seq.tracks.find((t: any) => t.kind === "audio" && t.name === "A1");
    const steps = (audioTrack?.clips ?? []).map((cl: any) => ({
      id: "effects.setParam",
      params: { clip: cl.id, effect: "audio", param: "offsetMs",
                value: meanSigned / 48.0,               // ms, computed from ticks
                time: 0 },
    }));
    const batch = await mc<any>(client, "command_batch",
      { steps, stop_on_error: true, atomic: true });

    if (batch.ok) {
      const after = await measureOnce();
      const validAfter = after.filter(r => !r.rejected && r.driftTicks !== null);
      const maxAfter = validAfter.length ? Math.max(...validAfter.map(r => r.driftTicks!)) : 0;
      if (maxAfter < maxBefore) {
        correction = {
          applied: true, deltaTicks: meanSigned,
          residualBefore: maxBefore, residualAfter: maxAfter,
        };
      } else {
        // Roll back the whole correction — the improvement did not materialize.
        await mc(client, "command_run", { id: "edit.undo", params: {} });
      }
    }
  }

  const finalAnchors = correction.applied ? await measureOnce() : before;
  const finalValid = finalAnchors.filter(r => !r.rejected && r.driftTicks !== null);
  const maxDrift = finalValid.length ? Math.max(...finalValid.map(r => r.driftTicks!)) : 0;
  const rejectedCount = finalAnchors.filter(r => r.rejected).length;
  const ratio = rejectedCount / finalAnchors.length;

  let verdict: "pass" | "fail" | "inconclusive";
  let rationale: string;
  if (ratio > 0.20) {
    verdict = "inconclusive";
    rationale = `More than 20% of anchors (${rejectedCount}/${finalAnchors.length}) ` +
      `were rejected by the vision model or missing a corresponding audio transient, ` +
      `so the residual statistics are not representative and the episode cannot be ` +
      `certified for downstream caption alignment at this time.`;
  } else if (BigInt(maxDrift) < PASS_THRESHOLD) {
    verdict = "pass";
    rationale = `Maximum drift of ${maxDrift} ticks is strictly below the 2-sample ` +
      `threshold of ${PASS_THRESHOLD} ticks; ` +
      (correction.applied
        ? `a systematic offset of ${correction.deltaTicks} ticks was corrected.`
        : `no systematic offset was detected.`);
  } else {
    verdict = "fail";
    rationale = `Residual drift of ${maxDrift} ticks exceeds the 2-sample threshold ` +
      `and the offset was not uniformly systematic (${correction.applied ? `correction ` +
      `residual ${correction.residualAfter}` : `correction not applicable`}); ` +
      `manual relink is required.`;
  }

  await client.close();
  return {
    anchors: finalAnchors, maxDriftTicks: maxDrift,
    passThresholdTicks: Number(PASS_THRESHOLD), rejectedAnchors: rejectedCount,
    systematicOffsetCorrection: correction, verdict, rationale,
  };
}
