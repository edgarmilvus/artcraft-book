// ═══════════════════════════════════════════════════════════════════════════
// FILE 9/9 (part B) — src/bin/forge.ts
// CLI entry point. Wires the engine facade, the Forge service and the
// optional cross-engine legs. Exits non-zero on any failure so CI catches it.
// ═══════════════════════════════════════════════════════════════════════════

import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { ArtCraftEngine, EngineSession } from '../artcraft/engine-session.js';
import { LayeredForge, jobIdFromPath } from '../artcraft/forge.js';
import { makeEngine } from '../artcraft/legs.js';
import type { JsonObject, LayeredRecipe } from '../artcraft/recipe.js';

interface CliJob {
  jobId: string;
  readRoot: string;
  writeRoot: string;
  recipePath: string;
  capture?: 'preview' | 'window';
  replaceSource?: { layerName: string; path: string } | null;
}

/** Minimal argv parser: `--key value` and `--flag`. */
function parseArgv(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = parseArgv(process.argv.slice(2));
  const jobPath = typeof args.job === 'string' ? resolve(args.job) : null;
  if (!jobPath) throw new Error('--job <job.json> is required');

  const job = JSON.parse(await readFile(jobPath, 'utf8')) as CliJob;
  const recipe = JSON.parse(
    await readFile(resolve(job.recipePath), 'utf8'),
  ) as LayeredRecipe;

  const log = (event: JsonObject): void => {
    // Structured, one line per event: directly ingestible by the platform's
    // log pipeline without a parser per engine.
    process.stdout.write(`${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
  };

  const photocraftBin = typeof args['photocraft-bin'] === 'string' ? args['photocraft-bin'] : 'photocraft-cli';
  const filmcraftBin = typeof args['filmcraft-bin'] === 'string' ? args['filmcraft-bin'] : 'filmcraft-cli';
  const vectorcraftBin = typeof args['vectorcraft-bin'] === 'string' ? args['vectorcraft-bin'] : 'vectorcraft-cli';

  const photoSession = new EngineSession({
    binary: photocraftBin,
    readRoot: job.readRoot,
    writeRoot: job.writeRoot,
    maxConcurrent: 4,
    requestTimeoutMs: 120_000,
    log,
  });
  const photocraft = new ArtCraftEngine(photoSession);

  const forge = new LayeredForge(photocraft, job.readRoot, job.writeRoot);

  try {
    const result = await forge.run({
      jobId: job.jobId ?? jobIdFromPath(jobPath),
      recipe,
      recipePath: job.recipePath,
      outDir: '.',
      capture: job.capture ?? 'preview',
      replaceSource: job.replaceSource ?? undefined,
      log,
    });

    log({
      event: 'forge.done',
      jobId: result.jobId,
      master: result.masterPath,
      ledger: result.ledgerPath,
      deliverables: result.deliverables.length,
    });

    // Cross-engine legs are opt-in per recipe and never block the master.
    const motion = recipe.delivery.filter((d) => d.kind === 'motion');
    if (motion.length > 0) {
      const filmcraft = makeEngine(filmcraftBin, job.readRoot, job.writeRoot);
      try {
        const frames = result.deliverables
          .filter((d) => d.format === 'png')
          .map((d) => d.path);
        for (const spec of motion) {
          await buildMotionSafely(filmcraft, frames, resolve(job.writeRoot, spec.path), spec, log);
        }
      } finally {
        await filmcraft.session.close();
      }
    }

    const vector = recipe.delivery.filter((d) => d.kind === 'vector');
    if (vector.length > 0) {
      const vectorcraft = makeEngine(vectorcraftBin, job.readRoot, job.writeRoot);
      try {
        for (const spec of vector) {
          await vectorcraft.runCommand('document.export', {
            path: resolve(job.writeRoot, spec.path),
            format: 'svg',
            outlineText: true,
          });
        }
      } finally {
        await vectorcraft.session.close();
      }
    }
  } finally {
    await photoSession.close();
  }
}

/** Thin wrapper so a missing frame list is a warning, not a crash. */
async function buildMotionSafely(
  filmcraft: ArtCraftEngine,
  frames: string[],
  outPath: string,
  spec: { width?: number; height?: number; fps?: number; seconds?: number },
  log: (e: JsonObject) => void,
): Promise<void> {
  if (frames.length === 0) {
    log({ event: 'leg.motion.skipped', reason: 'no png deliverables to sequence' });
    return;
  }
  try {
    await filmcraft.runCommand('file.newSequence', {
      name: 'Hero Cutdown',
      width: spec.width ?? 1920,
      height: spec.height ?? 1080,
      fps: spec.fps ?? 30,
      sampleRate: 48000,
      video: 1,
      audio: 0,
      mix: 'Stereo',
    });
    await filmcraft.runCommand('file.import', {
      paths: frames as unknown as never,
      addToComp: false,
    });
    await filmcraft.runCommand('file.exportMedia', {
      path: outPath,
      format: 'h264',
      audio: false,
      range: 'entire',
      wait: true,
    });
    log({ event: 'leg.motion', outPath, frames: frames.length });
  } catch (error) {
    log({
      event: 'leg.motion.failed',
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `forge failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
