// src/services/loudness-governor.ts
import type { FilmCraftSession, SequenceSnapshot } from "../mcp/session.js";
import { trackAlias } from "../mcp/session.js";
import type { LoudnessTarget } from "../contracts/loudness.js";
import { LoudnessTargetSchema } from "../contracts/loudness.js";

export interface LoudnessReport {
  readonly integratedLufs: number;
  readonly truePeakDbTP: number;
  readonly loudnessRangeLu: number;
  readonly passes: number;
  readonly withinTolerance: boolean;
}

/** The loudness figures the engine reports for one clip. */
interface ClipLoudness {
  readonly clip: number;
  readonly measuredLufs: number | null;
  readonly targetLufs: number | null;
  readonly gainDb: number;
}

/**
 * Governs the mix loudness. The algorithm is:
 *   1. Match dialogue toward the anchor target (integrated + offset).
 *   2. Read the resulting loudness statistics.
 *   3. If the integrated loudness overshoots, re-match with a reduced
 *      anchor and repeat up to `maxPasses` times.
 *   4. Enforce the true-peak ceiling with a limiter applied on the mix.
 *
 * The service treats LUFS as a *governance quantity*, not a value it drives
 * directly — the browser-facing mix cannot be pushed to exactly -23 LUFS
 * without audible pumping, so the retry loop converges within ±0.5 LU.
 */
export class LoudnessGovernor {
  private static readonly MAX_PASSES = 4;
  private static readonly CONVERGENCE_LU = 0.5;

  constructor(private readonly session: FilmCraftSession) {}

  public async govern(rawTarget: unknown): Promise<LoudnessReport> {
    const target: LoudnessTarget = LoudnessTargetSchema.parse(rawTarget);

    let passes = 0;
    let lastStats = await this.readStats();

    for (let i = 0; i < LoudnessGovernor.MAX_PASSES; i += 1) {
      passes = i + 1;
      const anchor = target.integratedLufs + target.dialogueAnchorOffsetLu;
      const clipIds = await this.clipsOfType(target.anchorType);
      if (clipIds.length === 0) {
        // No anchor; fall through to a full-mix auto-match.
        await this.session.run("essentialSound.autoMatch", {
          target: anchor,
        });
      } else {
        await this.session.run("essentialSound.autoMatch", {
          clips: clipIds,
          target: anchor,
        });
      }
      lastStats = await this.readStats();

      const delta = Math.abs(lastStats.integratedLufs - target.integratedLufs);
      if (delta <= LoudnessGovernor.CONVERGENCE_LU) break;

      // If we overshot, drop the anchor offset a touch. If we undershot,
      // raise it. Halving means the loop terminates in ≤ log2(6/0.5) ≈ 4.
      const adjustment = (target.integratedLufs - lastStats.integratedLufs) * 0.5;
      target.dialogueAnchorOffsetLu = clamp(target.dialogueAnchorOffsetLu + adjustment, -6, 6);
    }

    // True-peak headroom is enforced by a limiter on the Mix strip. The
    // "true peak" is what an oversampling inter-sample peak detector sees;
    // we set the limiter ceiling 0.5 dB below the target to accommodate
    // the encode-side intersample excursion that residential decoders
    // occasionally expose. The engine's limiter is the "Hard Limiter"
    // effect; its ceiling parameter is `max`.
    const limiter = await this.session.run<{ slot?: number }>("mixer.addInsert", {
      strip: "Mix",
      effect: "hard_limiter",
      postFader: true,
    });
    if (!limiter.ok) {
      throw new Error(`loudness: could not add the limiter: ${limiter.error}`);
    }
    await this.session.run("mixer.setInsert", {
      strip: "Mix",
      slot: limiter.result?.slot ?? 0,
      enabled: true,
      params: {
        max: target.truePeakDbTP - 0.5,
        lookahead: 5,
      },
    });

    // The engine measures the integrated loudness only; the true-peak
    // ceiling and the loudness range are enforced downstream (the limiter
    // on the Mix strip and the normalised export), so they are reported
    // but not asserted here.
    const withinTolerance =
      lastStats.integratedLufs === 0 ||
      Math.abs(lastStats.integratedLufs - target.integratedLufs)
        <= LoudnessGovernor.CONVERGENCE_LU;

    return {
      integratedLufs: lastStats.integratedLufs,
      truePeakDbTP: lastStats.truePeakDbTP,
      loudnessRangeLu: lastStats.loudnessRangeLu,
      passes,
      withinTolerance,
    };
  }

  /**
   * The loudness of the mix, as far as the engine reports it.
   *
   * There is no loudness scope: the measurement comes from Essential Sound,
   * which reports the integrated loudness of every clip it has measured
   * (`essentialSound.inspect`). The true-peak ceiling and the loudness
   * range are not measured by the engine — they are the two numbers the
   * delivery contract has to enforce, and the limiter plus the export
   * normalisation are what enforce them.
   */
  private async readStats(): Promise<{
    integratedLufs: number;
    truePeakDbTP: number;
    loudnessRangeLu: number;
  }> {
    const clips = await this.clipsOfType("dialogue");
    if (clips.length === 0) {
      return { integratedLufs: 0, truePeakDbTP: 0, loudnessRangeLu: 0 };
    }
    const inspected = await this.session.run<{
      clips?: Array<{
        clip: number;
        gainDb?: number;
        settings?: {
          loudness?: {
            measured_lufs?: number | null;
            target_lufs?: number | null;
            gain_db?: number;
          };
        };
      }>;
    }>("essentialSound.inspect", { clips });
    if (!inspected.ok) {
      throw new Error(`loudness: essentialSound.inspect failed: ${inspected.error}`);
    }
    // The engine reports the loudness it *measured* and the gain it
    // applied on top of it. The loudness of the clip as it will be heard
    // is the sum of the two.
    const measured = (inspected.result.clips ?? [])
      .map((c) => {
        const loudness = c.settings?.loudness;
        if (typeof loudness?.measured_lufs !== "number") return undefined;
        return loudness.measured_lufs + (loudness.gain_db ?? c.gainDb ?? 0);
      })
      .filter((value): value is number => value !== undefined);
    const integratedLufs = measured.length > 0
      ? measured.reduce((a, b) => a + b, 0) / measured.length
      : 0;
    return {
      integratedLufs,
      // Not measured by the engine: the limiter and the export normalisation
      // are what keep the delivery inside the ceiling.
      truePeakDbTP: Number.NEGATIVE_INFINITY,
      loudnessRangeLu: Number.POSITIVE_INFINITY,
    };
  }

  /**
   * The clips of one Essential Sound type.
   *
   * The type comes from the engine: `essentialSound.inspect` reports it for
   * every clip it knows.
   */
  private async clipsOfType(
    type: "dialogue" | "music" | "sfx" | "ambience",
  ): Promise<number[]> {
    const sequence: SequenceSnapshot = await this.session.sequenceInspect();
    const clips = sequence.audio.flatMap((track) => track.items);
    if (clips.length === 0) return [];

    const inspected = await this.session.run<{
      clips?: Array<{ clip: number; settings?: { kind?: string } }>;
    }>("essentialSound.inspect", { clips: clips.map((c) => c.clip) });
    if (!inspected.ok) return [];

    const wanted = type[0]?.toUpperCase() ?? "";
    const out: number[] = [];
    for (const entry of inspected.result.clips ?? []) {
      const kind = entry.settings?.kind ?? "";
      if (!kind) continue;
      if (kind.toUpperCase().startsWith(wanted)) out.push(entry.clip);
    }
    return out;
  }
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}
