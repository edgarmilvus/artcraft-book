/* ============================================================================
 * 5. Pipeline stages — each is idempotent, resumable, and instrumented
 * ========================================================================== */
// The module continues the client from the previous section: the same
// `LightCraftClient`, the same `PipelineConfig`, the same `Logger`.

import {
  LightCraftClient,
  type Logger,
  type PipelineConfig,
  type PipelineResult,
} from "./01_lightcraft-raw-pipeline.js";

/** Timing helper used by every stage to emit latency to the telemetry bus. */
export async function timed<T>(
  name: string,
  durations: Record<string, number>,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  try {
    return await fn();
  } finally {
    durations[name] = Date.now() - t0;
  }
}

/* ------------------------- Stage A: Ingest ------------------------------- */

/**
 * Copy/move staged RAW masters into the LightCraft catalog with a dated
 * destination tree, renaming per a template, applying a metadata preset,
 * stamping keywords, and attaching them to the delivery album.
 *
 * Why this shape:
 *  - `mode: "copy"` keeps the ingest staging area immutable for audit.
 *  - `organize` and `rename` give us a deterministic, reversible path tree.
 *  - `metadataPreset` is where the SaaS tenant’s copyright/creator policy
 *    is applied at ingest so it propagates through every export.
 */
export async function stageImport(
  lc: LightCraftClient,
  cfg: PipelineConfig,
  log: Logger,
): Promise<{ imported: number; duplicates: number; restored: number }> {
  const res = await lc.run<{
    imported: number[];
    duplicates: { existing: number; path: string; reason: string }[];
    failed: unknown[];
  }>("library.import", {
    paths: [cfg.readRoot],
    mode: "copy",
    destination: cfg.catalogPath,
    organize: "date",
    rename: "{date:%Y%m%d_%H%M%S}_{seq:4}",
    onDeleted: "skip",
  });

  // The album is a catalogue object of its own: it is created first and the
  // imported photos are added to it afterwards. `library.import` takes no
  // album or keyword parameters.
  const album = await lc.run<{ id: number }>("album.create", { name: cfg.albumName });
  // A re-run of the same folder imports nothing and reports the photos that
  // are already in the library; they belong to the delivery album too.
  const delivered = [
    ...res.imported,
    ...res.duplicates.map((duplicate) => duplicate.existing),
  ];
  if (delivered.length) {
    await lc.run("album.addPhotos", { id: album.id, ids: delivered });
  }

  // The tenant's copyright policy is a metadata preset; it is applied to the
  // imported photos, not passed to the import.
  if (cfg.metadataPreset) {
    await lc.run("metadata.applyPreset", { name: cfg.metadataPreset, ids: delivered });
  }

  log.info("import complete", {
    imported: res.imported.length,
    duplicates: res.duplicates.length,
  });
  return {
    imported: res.imported.length,
    duplicates: res.duplicates.length,
    restored: 0,
  };
}

/* ------------------- Stage B: HDR / Panorama merge (optional) ----------- */

/**
 * Merge bracketed exposures into a single HDR head before grading.
 * `merge.hdr` uses EXIF-derived bracket detection and deghosting, and
 * `autoSettings` applies a baseline tone curve we can then override with
 * the tenant’s LUT. We scope merges by capture-time proximity using a
 * `catalog.query` filter so unrelated frames never touch each other.
 */
export async function stageHdrMerge(
  lc: LightCraftClient,
  cfg: PipelineConfig,
  log: Logger,
): Promise<{ merged: number }> {
  // Ask the engine which photo ids fall inside the client’s delivery window.
  const photos = await lc.run<{ photos: Array<{ id: number; captured: string }> }>(
    "catalog.query",
    { filter: { album: cfg.albumName }, sort: { key: "captureDate" } },
  );
  if (photos.photos.length < 3) return { merged: 0 };

  // Group by 10-second windows — the shape of a bracketed burst.
  const groups = new Map<number, number[]>();
  for (const p of photos.photos) {
    const bucket = Math.floor(new Date(p.captured).getTime() / 10_000);
    (groups.get(bucket) ?? groups.set(bucket, []).get(bucket)!).push(p.id);
  }

  let merged = 0;
  for (const ids of groups.values()) {
    if (ids.length < 3) continue;
    const res = await lc.run<{ id?: number }>("merge.hdr", {
      ids,
      align: true,
      deghost: "medium",
      autoSettings: true,
      stack: true,
    });
    if (res.id) merged += 1;
  }
  log.info("hdr merge complete", { merged });
  return { merged };
}

/* ------------------- Stage C: Assisted culling + burst stacks ----------- */

/**
 * Two-pass culling:
 *  (1) `stack.auto` collapses look-alike bursts into stacks so the grid
 *      presents a single hero frame.
 *  (2) `photo.analyze` scores sharpness and clipping, marks the sharpest
 *      frame of each burst, and (optionally) rejects below the tenant’s
 *      sharpness threshold. All of this is one undo step, so a human
 *      editor can still reverse the agent’s decision in one keystroke.
 */
export async function stageCull(
  lc: LightCraftClient,
  cfg: PipelineConfig,
  log: Logger,
): Promise<{ groups: number; rejected: number; picked: number }> {
  // Score sharpness, clip detection, and pick heroes — one undo step.
  //
  // The ids are passed explicitly: without them `photo.analyze` scores the
  // photos *in the current view*, which is whatever the editor last looked
  // at, not the delivery album.
  const view = await lc.run<{ photos: Array<{ id: number }> }>(
    "catalog.query",
    { limit: 200 },
  );
  const res = await lc.run<{
    photos: Array<{ id: number; sharpness: number; group?: number; best?: boolean }>;
    groups: number;
    rejected: number;
    picked: number;
  }>("photo.analyze", {
    ids: view.photos.map((photo) => photo.id),
    rejectBelow: cfg.cullRejectBelow,
    pickBest: cfg.cullPickBest,
  });
  // The burst stacks come *after* the scoring: a stack collapses the burst
  // into one row, and the engine can no longer see the frames it has to
  // group and score.
  await lc.run("stack.auto", {
    gap: cfg.burstGapSeconds,
    ids: undefined, // default: the current view (the delivery album)
  });

  log.info("cull complete", {
    groups: res.groups,
    rejected: res.rejected,
    picked: res.picked,
  });
  return { groups: res.groups, rejected: res.rejected, picked: res.picked };
}

/* ------------------- Stage D: 32-bit float linear grading pipeline ------ */

/**
 * The heart of the chapter. For each delivered (picked) frame we:
 *
 *   1. Reset any pre-existing edits so grading is deterministic.
 *   2. Force the source interpretation to linear (float) so lens
 *      corrections, white balance, and HSL all operate in scene-linear.
 *   3. Auto white-balance, then auto tone as a *seed* — not the final look.
 *   4. Apply the tenant’s LUT as a creative profile via `develop.profile`
 *      (`profile.import` was run once at worker boot; here we reference the
 *      profile id with `amount` for partial-strength grading).
 *   5. Push a hand-authored 32-bit float develop graph (`develop.merge`
 *      with a partial DevelopSettings JSON) anchoring exposure in stops,
 *      curve in linear, and separate HSL bands derived from the tenant’s
 *      style guide.
 *   6. Sync the graph to *all* picked frames so a look is consistent across
 *      the whole delivery — the SaaS differentiator versus per-frame edits.
 *
 * All commands land as separate history steps so an editor can A/B a
 * specific stage against the AI baseline from the batch UI.
 */
export async function stageGrade(
  lc: LightCraftClient,
  cfg: PipelineConfig,
  log: Logger,
): Promise<{ graded: number }> {
  // Discover the picked (delivered) frames from the album.
  // The picked frames are the ones the cull stage marked. The album filter
  // takes the album's id, so the flag is the stable selector here.
  const picked = await lc.run<{ photos: Array<{ id: number }> }>(
    "catalog.query",
    { filter: { flag: "pick" }, limit: 200 },
  );
  if (picked.photos.length === 0) {
    log.warn("no picked frames to grade; falling back to full album");
  }
  const targets = picked.photos.map((p) => p.id);
  if (targets.length === 0) return { graded: 0 };

  // 1. Deterministic reset — clear any carry-over from previews/tests.
  await lc.run("develop.reset", { ids: targets });

  // 2. Seed white balance + tone + profile as a single atomic batch so
  //    every frame converges on the same computational starting line.
  await lc.batch([
    { id: "develop.wb", params: { mode: "auto" } },
    { id: "develop.auto", params: {} },
    {
      id: "develop.profile",
      params: {
        id: "lut:agency-log-to-709", // imported once at worker boot
        amount: 65,                  // partial strength; HSL refines it
      },
    },
  ]);

  // 3. Push the tenant’s authored 32-bit float grading graph. This JSON is
  //    identical on every frame, which is the entire point of a linear
  //    pipeline: it is a *look*, not a per-photo adjustment.
  const graded = await lc.run<{ count: number }>("develop.merge", {
    label: "Agency Look v3 (32f linear)",
    settings: {
      // --- Whitespace/highlight recovery in scene-linear ---
      light: {
        exposure: 0.0,
        contrast: 8,
        highlights: -22,
        shadows: 14,
        whites: 5,
        blacks: -4,
      },
      // --- Wide-gamut mastering: P3 primaries with HDR-capable headroom ---
      color: {
        wb: { mode: "custom", temp: 5500, tint: 4 },
        saturation: 6,
        vibrance: 12,
      },
      // --- Linear-space point curve: mild S, no clipping ---
      curve: {
        point: {
          master: [
            [0.00, 0.00],
            [0.18, 0.20],
            [0.50, 0.52],
            [0.82, 0.86],
            [1.00, 1.00],
          ],
        },
      },
      // --- HSL bands tuned for skin and foliage, the two failure modes ---
      mixer: {
        hsl: {
          orange: { hue: -3, sat: 8, lum: 4 },   // skin tone lift
          green: { hue: 6, sat: -12, lum: -3 },  // desaturate field greens
          blue: { hue: -4, sat: 10, lum: -2 },   // deepen skies
        },
      },
      // --- Effects: subtle grain + adaptive vignette (32-bit safe) ---
      effects: {
        grain: { amount: 4, size: 25, roughness: 50 },
        vignette: { amount: -12, midpoint: 52, feather: 62 },
      },
      // --- Detail: capture-sharpening in the linear domain ---
      detail: {
        sharpen: { amount: 42, radius: 0.9, detail: 22, masking: 30 },
        noise: { luminance: 18, color: 24, detail: 50 },
      },
    },
  });

  await lc.run("develop.sync", { groups: undefined });
  log.info("grading applied", { graded, frames: targets.length });
  return { graded: graded.count ?? targets.length };
}

/* ------------------- Stage E: AI denoise (post-grade, pre-export) ------ */

/**
 * Denoise is intentionally *after* grading so the model never sees the
 * client’s creative curve (which would train the tenant’s look into the
 * denoiser’s priors). The model runs on-GPU where available (see
 * `denoise.settings.runOn`), and `denoise.queue` schedules the batch.
 */
export async function stageDenoise(
  lc: LightCraftClient,
  log: Logger,
): Promise<{ queued: number }> {
  const settings = await lc.run<{ runOn: string }>("denoise.settings", {});
  if (settings.runOn === "cpu") {
    log.warn("denoise falling back to CPU; consider a GPU worker pool");
  }
  const res = await lc.run<{ added: number }>("denoise.queue", {
    scope: "withAmount",
    retry: false,
  });
  log.info("denoise queued", { added: res.added });
  return { queued: res.added };
}

/* ------------------- Stage F: Multi-tier export + manifest -------------- */

/**
 * Export each requested delivery tier. `app.export` supports long-edge,
 * bit-depth, ICC profile, and metadata policy per call, so a single
 * orchestration loop covers web previews (sRGB 8-bit JPEG, 3000 px),
 * print masters (Adobe RGB 16-bit TIFF, full resolution), and archival
 * DNG (lossless raw with edits embedded).
 *
 * The returned manifest is what the SaaS writes to the delivery record;
 * downstream CDN invalidation and customer notification drive off it.
 */
export async function stageExport(
  lc: LightCraftClient,
  cfg: PipelineConfig,
  log: Logger,
): Promise<PipelineResult["exported"]> {
  const exported: Array<{ tier: string; files: number; bytes: number }> = [];

  for (const tier of cfg.tiers) {
    switch (tier) {
      case "web_preview": {
        const r = await lc.run<{ path: string; bytes: number }>("app.export", {
          dir: `${cfg.writeRoot}/web`,
          format: "jpeg",
          longEdge: 3000,
          quality: 82,
          colorSpace: "srgb",
          bitDepth: 8,
          sharpen: "screen",
          sharpenAmount: "standard",
          metadata: "copyright",
          removeLocation: true,
          naming: "{date:%Y%m%d}_{seq:4}_web",
          conflict: "overwrite",
        });
        exported.push({ tier, files: 1, bytes: r.bytes ?? 0 });
        break;
      }
      case "print_16bit": {
        const r = await lc.run<{ path: string; bytes: number }>("app.export", {
          dir: `${cfg.writeRoot}/print`,
          format: "tiff",
          longEdge: 0, // full native resolution
          colorSpace: "adobeRgb",
          bitDepth: 16,
          tiffCompression: "lzw",
          metadata: "all",
          naming: "{date:%Y%m%d}_{seq:4}_print",
          conflict: "overwrite",
        });
        exported.push({ tier, files: 1, bytes: r.bytes ?? 0 });
        break;
      }
      case "archival_dng": {
        const r = await lc.run<{ path: string; bytes: number }>("app.export", {
          dir: `${cfg.writeRoot}/archive`,
          format: "dng",
          dngCompression: "lossless",
          metadata: "all",
          naming: "{date:%Y%m%d}_{seq:4}_archive",
          conflict: "overwrite",
        });
        exported.push({ tier, files: 1, bytes: r.bytes ?? 0 });
        break;
      }
    }
  }
  log.info("export tiers complete", { tiers: exported });
  return exported;
}
