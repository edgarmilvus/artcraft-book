/**
 * @file  filmcraft/drift-audit.ts
 * @module FilmCraftDriftAudit
 *
 * Quantifies the divergence between a naive floating-point accumulator
 * (`for (n) t += 1/fps`) and the exact integer path (`ticks(n)`), for a
 * given fps, sample rate, and workload length. Output is intended for
 * dashboards, unit tests, and end-of-pipeline regression assertions.
 */

import { Rational, Timebase, FPS, FrameRate } from "./timebase.js";

export interface DriftReport {
  /** Wall-clock length of the assumed workload, seconds. */
  durationSeconds: number;
  /** Video frame count spanned by the workload. */
  frames: number;
  /** Audio sample count spanned by the workload. */
  samples: number;

  /** Cumulative float error after `frames` frame intervals: seconds. */
  frameDriftSeconds: number;
  /** Same error expressed in ticks (rounded down to integer). */
  frameDriftTicks: bigint;
  /** Frame-equivalent size of the drift (e.g., 0.51 frames). */
  frameDriftFrames: number;

  /** Cumulative float error after `samples` sample intervals: seconds. */
  sampleDriftSeconds: number;
  /** Sample-equivalent size of the drift. */
  sampleDriftSamples: number;
}

export class DriftAuditor {
  private readonly tb: Timebase;

  public constructor(fps: FrameRate | number, sampleRate: number) {
    this.tb = new Timebase(fps, sampleRate);
  }

  /**
   * Walk the naive float path (`t += 1/fps`) for `frames` iterations and
   * compare against the exact BigInt path (`frameToTicks(frames)`). The
   * two agree only at frame 0; the divergence is monotonic.
   */
  public audit(durationSeconds: number): DriftReport {
    const frames = Math.round(durationSeconds * Number(this.tb.fps.n) / Number(this.tb.fps.d));
    const samples = Math.round(durationSeconds * Number(this.tb.sampleRate));

    // Naive float: 1/fps seconds per frame.
    const frameIntervalF = 1 / (Number(this.tb.fps.n) / Number(this.tb.fps.d));
    let tFrameF = 0;
    for (let i = 0; i < frames; i++) tFrameF += frameIntervalF;

    // Exact integer: closed-form.
    const exactFrameTicks = this.tb.frameToTicks(frames);
    const exactFrameSeconds = this.tb.ticksToSeconds(exactFrameTicks);

    const driftFrameSec = tFrameF - exactFrameSeconds.toNumber();
    const driftFrameTicks = this.tb.secondsToTicks(Math.abs(driftFrameSec)) *
                            (driftFrameSec < 0 ? -1n : 1n);

    // Naive sample accumulation.
    const sampleIntervalF = 1 / Number(this.tb.sampleRate);
    let tSampleF = 0;
    for (let i = 0; i < samples; i++) tSampleF += sampleIntervalF;
    const sampleDriftSec = tSampleF - durationSeconds;
    const sampleDriftSamples = sampleDriftSec * Number(this.tb.sampleRate);

    return {
      durationSeconds,
      frames,
      samples,
      frameDriftSeconds: driftFrameSec,
      frameDriftTicks: driftFrameTicks,
      frameDriftFrames: driftFrameSec * Number(this.tb.fps.n) / Number(this.tb.fps.d),
      sampleDriftSeconds: sampleDriftSec,
      sampleDriftSamples,
    };
  }
}

/**
 * CLI-shaped pretty printer for use in a pipeline log or a Slack report.
 * Deliberately formatted as fixed-width columns so it renders identically
 * in a terminal, a GitHub Actions summary, or a Next.js server log stream.
 */
export function printDriftReport(r: DriftReport, label = "") {
  const pad = (s: string, w = 32) => s.padEnd(w, " ");
  const lines = [
    `── Drift Audit ${label ? `[${label}] ` : ""}──────────────────────────────────`,
    pad("Workload length")            + r.durationSeconds.toFixed(3) + " s",
    pad("Video frames traversed")     + r.frames,
    pad("Audio samples traversed")    + r.samples,
    pad("Float frame drift")          + (r.frameDriftSeconds * 1000).toFixed(4) + " ms",
    pad("Float frame drift (frames)") + r.frameDriftFrames.toFixed(4),
    pad("Float sample drift")         + (r.sampleDriftSeconds * 1e9).toFixed(0) + " ns",
    pad("Float sample drift (samples)") + r.sampleDriftSamples.toFixed(3),
    "──────────────────────────────────────────────────────────────",
  ];
  // eslint-disable-next-line no-console
  console.log(lines.join("\n"));
}

/* A tiny self-contained smoke test — run with `node --loader ts-node/esm`. */
export function smokeTest() {
  const auditor = new DriftAuditor(FPS.F29_97, 48000);
  const oneHour = auditor.audit(3600);
  const eightHours = auditor.audit(8 * 3600);
  printDriftReport(oneHour, "1 h @ 29.97");
  printDriftReport(eightHours, "8 h @ 29.97");
  if (eightHours.frameDriftFrames < 0.1) {
    throw new Error("Expected cumulative drift to exceed 0.1 frames over 8 h");
  }
}
