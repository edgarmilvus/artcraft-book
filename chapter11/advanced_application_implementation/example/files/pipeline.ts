/**
 * @file  filmcraft/pipeline.ts
 * @module BeatSyncedCutPipeline
 *
 * The concrete scenario executed by CloudCut's "beat cut" worker. Accepts
 * a JSON job description and returns a JSON result. Designed to be run as
 * `node dist/pipeline.js <job.json>` inside a Kubernetes sidecar, or
 * imported by a Next.js server action (see app/api/render/route.ts).
 */

import { FilmCraftMCP } from "./filmcraft-mcp.js";
import { ZeroDriftSequencer, CutRequest, CutResult } from "./zero-drift-sequencer.js";
import { DriftAuditor, printDriftReport } from "./drift-audit.js";
import { FPS, TICKS_PER_SECOND } from "./timebase.js";

export interface CutJob extends CutRequest {
  /** Where to write the exported MP4 (relative to a configured write root). */
  outputPath?: string;
  /** If true, render the frame at the midpoint of the first cut. */
  renderFirstFrame?: boolean;
}

export async function runBeatCutJob(
  job: CutJob,
  opts: { readRoots: string[]; writeRoots: string[]; cwd?: string },
): Promise<CutResult & { driftReport?: string; framePngBase64?: string }> {
  /* ─── Pre-flight: quantify what we are about to save ─────────────── */

  const auditor = new DriftAuditor(job.fps, job.sampleRate);

  /* ─── Open the MCP bridge ────────────────────────────────────────── */

  const bridge = new FilmCraftMCP({
    readRoots: opts.readRoots,
    writeRoots: opts.writeRoots,
    cwd: opts.cwd,
  });

  try {
    await bridge.connect();

    /* ─── Phase 1: pure planning ───────────────────────────────────── */

    const sequencer = new ZeroDriftSequencer(bridge);
    const plan = sequencer.plan(job);

    // Sanity check: the plan's total length should be within one frame of
    // the intended musical duration.
    const intendedDurationSeconds =
      (job.cutCount * (job.beatsPerBar ?? 4) * (job.barsPerCut ?? 1)) *
      (60 / job.bpm);
    const planDurationSeconds = Number(plan.totalTicks) / Number(TICKS_PER_SECOND);
    const durationDeltaMs = Math.abs(planDurationSeconds - intendedDurationSeconds) * 1000;
    if (durationDeltaMs > 1000) {
      throw new Error(
        `Plan duration deviates from intended by ${durationDeltaMs.toFixed(1)} ms; refusing to dispatch.`,
      );
    }

    /* ─── Phase 2: dispatch and verify ─────────────────────────────── */

    const result = await sequencer.dispatch({ ...job, verify: true }, plan);

    /* ─── Optional: run the drift audit for the log stream ─────────── */

    const drift = auditor.audit(planDurationSeconds);
    const reportLines: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => { reportLines.push(args.map(String).join(" ")); };
    try {
      printDriftReport(drift, `${job.sequenceName} @ ${job.fps.num}/${job.fps.den}`);
    } finally {
      console.log = origLog;
    }
    const driftReport = reportLines.join("\n");

    /* ─── Optional: export an MP4 and render a QA frame ────────────── */

    let framePngBase64: string | undefined;
    if (job.outputPath) {
      await bridge.exportMedia({
        path: job.outputPath,
        format: "h264",
        width: job.width,
        height: job.height,
        fps: Number(job.fps.num) / Number(job.fps.den),
        range: "entire",
        wait: true,
      });
    }
    if (job.renderFirstFrame) {
      const oneSecond = 1_000_000_000; // seconds → ticks path:
      const tsec = (Number(result.plan.cutTicks[0]) + Number(result.plan.cutTicks[1])) /
                   2 / Number(TICKS_PER_SECOND);
      const rendered = await bridge.renderFrame({ seconds: tsec, maxSide: 960 });
      framePngBase64 = rendered.dataBase64;
      void oneSecond;
    }

    return { ...result, driftReport, framePngBase64 };
  } finally {
    await bridge.disconnect();
  }
}

/* ─── CLI entry point ──────────────────────────────────────────────── */

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) {
    // eslint-disable-next-line no-console
    console.error("Usage: node pipeline.js <job.json> [--read-root DIR] [--write-root DIR]");
    process.exit(1);
  }
  const fs = await import("node:fs/promises");
  const job = JSON.parse(await fs.readFile(argv[0], "utf8")) as CutJob;

  const readRoots = argv.filter((a, i) => a === "--read-root" && i < argv.length - 1)
                        .map((_, i) => argv[argv.indexOf("--read-root") + 1]);
  const writeRoots = argv.filter((a) => a === "--write-root")
                         .map((_, i) => argv[argv.indexOf("--write-root") + 1]);

  const result = await runBeatCutJob(job, {
    readRoots: readRoots.length ? readRoots : ["/work/cloudcut/input"],
    writeRoots: writeRoots.length ? writeRoots : ["/work/cloudcut/output"],
  });

  // eslint-disable-next-line no-console
  console.log(JSON.stringify({
    sequence: result.sequence.name,
    cuts: result.plan.cutTicks.map(String),
    maxDeviationTicks: String(result.verification.maxDeviationTicks),
    verified: result.verification.passed,
    driftReport: result.driftReport,
  }, null, 2));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(err);
    process.exit(1);
  });
}
