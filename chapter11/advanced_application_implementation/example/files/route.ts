/**
 * @file  app/api/render/route.ts
 * @description
 * Next.js App Router route handler that accepts a beat-cut job as JSON
 * and streams the result back. Runs in the Node.js runtime (not Edge),
 * because the MCP transport spawns `filmcraft-cli` as a child process.
 *
 * Environment:
 *   FILMCRAFT_INPUT_ROOT   – read root passed to the CLI
 *   FILMCRAFT_OUTPUT_ROOT  – write root passed to the CLI
 *   FILMCRAFT_JOB_TIMEOUT  – seconds before the job is force-cancelled
 */

import { runBeatCutJob, CutJob } from "./pipeline.js";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const inputRoot  = process.env.FILMCRAFT_INPUT_ROOT  ?? "/work/cloudcut/input";
  const outputRoot = process.env.FILMCRAFT_OUTPUT_ROOT ?? "/work/cloudcut/output";
  const timeoutSec = Number(process.env.FILMCRAFT_JOB_TIMEOUT ?? 900);

  let job: CutJob;
  try {
    job = (await req.json()) as CutJob;
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // Basic validation to avoid spawning the CLI for obviously invalid jobs.
  if (!job.sequenceName || !Array.isArray(job.clipPaths) || job.clipPaths.length === 0) {
    return Response.json({ error: "sequenceName and clipPaths are required" }, { status: 422 });
  }
  if (!job.cutCount || job.cutCount < 1 || job.cutCount > 512) {
    return Response.json({ error: "cutCount must be between 1 and 512" }, { status: 422 });
  }
  if (!job.bpm || job.bpm <= 0 || job.bpm > 500) {
    return Response.json({ error: "bpm out of range" }, { status: 422 });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutSec * 1000);

  try {
    const result = await runBeatCutJob(job, {
      readRoots: [inputRoot],
      writeRoots: [outputRoot],
    });
    return Response.json({
      ok: true,
      sequence: result.sequence.name,
      plan: {
        beatIntervalTicks: result.plan.beatIntervalTicks.toString(),
        barIntervalTicks: result.plan.barIntervalTicks.toString(),
        totalTicks: result.plan.totalTicks.toString(),
        cutTicks: result.plan.cutTicks.map(String),
      },
      verification: {
        passed: result.verification.passed,
        maxDeviationTicks: result.verification.maxDeviationTicks.toString(),
      },
      driftReport: result.driftReport,
      frame: result.framePngBase64 ? `data:image/png;base64,${result.framePngBase64}` : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ ok: false, error: message }, { status: 500 });
  } finally {
    clearTimeout(timer);
  }
}
