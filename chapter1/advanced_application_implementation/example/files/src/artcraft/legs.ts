// ═══════════════════════════════════════════════════════════════════════════
// FILE 7/9 — src/artcraft/legs.ts
// Secondary engine legs: motion (FilmCraft) and vector (VectorCraft).
// Each leg opens its own MCP session; no engine shares a document.
// ═══════════════════════════════════════════════════════════════════════════

import { ArtCraftEngine, EngineSession } from './engine-session.js';
import type { JsonObject, JsonValue } from './recipe.js';

/**
 * Motion leg.
 *
 * Takes the rendered PNG frames (or a single hero frame plus overlays) and
 * produces a short, deterministic cutdown. Transitions are applied by id, and
 * any step that can be long-running is exported with `wait: true` so the job
 * completes before we hash the output.
 */
export async function buildMotionDeliverable(args: {
  filmCraft: ArtCraftEngine;
  /** Absolute paths of the PNG frames, in order. */
  frames: string[];
  outPath: string;
  width: number;
  height: number;
  fps: number;
  seconds: number;
  log?: (event: JsonObject) => void;
}): Promise<{ path: string }> {
  const { filmCraft, frames, outPath, width, height, fps, seconds } = args;
  const log = args.log ?? (() => undefined);

  // 1. Open a new sequence at the exact delivery format.
  await filmCraft.runCommand('file.newSequence', {
    name: 'Hero Cutdown',
    width,
    height,
    fps,
    sampleRate: 48000,
    video: 1,
    audio: 0,
    mix: 'Stereo',
  });

  // 2. Import every frame as footage. `importAs` is left to the engine's
  //    default so a PNG sequence is recognised as stills, not as vectors.
  await filmCraft.runCommand('file.import', {
    paths: frames as unknown as JsonValue,
    addToComp: false,
  });

  // 3. Place each frame on V1, one frame apart, overwriting as we go.
  for (let i = 0; i < frames.length; i++) {
    const itemId = await resolveItemId(filmCraft, frames[i]);
    await filmCraft.runCommand('timeline.place', {
      item: itemId,
      track: 'V1',
      time: Math.round((i / fps) * 254_016_000_000),
      insert: false,
      video: true,
      audio: false,
    });
  }

  // 4. Export. `wait: true` blocks until the file exists.
  await filmCraft.runCommand('file.exportMedia', {
    path: outPath,
    format: 'h264',
    width,
    height,
    fps,
    bitrateKbps: 12_000,
    audio: false,
    range: 'entire',
    wait: true,
  });

  log({ event: 'leg.motion', outPath, frames: frames.length, seconds });
  return { path: outPath };
}

/** Look up an imported project item's id by its file path. */
async function resolveItemId(filmCraft: ArtCraftEngine, path: string): Promise<number> {
  const tree = await filmCraft.session.call<JsonValue>('project_inspect', {});
  const found = findItemId(tree, path);
  if (found === null) throw new Error(`motion leg: no project item for "${path}"`);
  return found;
}

/** Recursively search a project tree for an item whose path matches. */
function findItemId(node: unknown, path: string): number | null {
  if (!node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findItemId(child, path);
      if (hit !== null) return hit;
    }
    return null;
  }
  const obj = node as Record<string, unknown>;
  const candidates = [obj.path, obj.filePath, obj.mediaPath];
  if (candidates.some((c) => typeof c === 'string' && c.endsWith(basenameOf(path)))) {
    if (typeof obj.id === 'number') return obj.id;
  }
  for (const key of ['items', 'children', 'nodes']) {
    const hit = findItemId(obj[key], path);
    if (hit !== null) return hit;
  }
  return null;
}

function basenameOf(p: string): string {
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/**
 * Vector leg.
 *
 * Exports the brand lockup as SVG with text outlined, so the deliverable is
 * font-independent. The source `.vectorcraft` document remains live and
 * editable; only the export is flattened.
 */
export async function buildVectorDeliverable(args: {
  vectorCraft: ArtCraftEngine;
  sourcePath: string;
  outPath: string;
  artboard?: number;
  log?: (event: JsonObject) => void;
}): Promise<{ path: string }> {
  const { vectorCraft, sourcePath, outPath, artboard } = args;
  const log = args.log ?? (() => undefined);

  await vectorCraft.session.call('open_file', { path: sourcePath });
  await vectorCraft.runCommand('document.export', {
    path: outPath,
    format: 'svg',
    outlineText: true,
    ...(artboard !== undefined ? { artboard } : {}),
  });

  log({ event: 'leg.vector', outPath });
  return { path: outPath };
}

/** Factory: build an engine facade for any ArtCraft binary. */
export function makeEngine(binary: string, readRoot: string, writeRoot: string): ArtCraftEngine {
  return new ArtCraftEngine(
    new EngineSession({ binary, readRoot, writeRoot, maxConcurrent: 4 }),
  );
}
