// Chapter 1, Exercise 4 — The Brand Family Problem.
//
// Rebuilds a flat generative logo PNG as a non-destructive VectorCraft master:
// the traced mark, a live wordmark, and an inverted artboard variant all paint
// from global swatches, so one `swatch.edit` rebrands every derivative without
// re-running the trace.
//
// This module holds the brand data, the trace recipe, the favicon matrix and
// the provenance builder. `run_ex4.ts` executes the phases against a real
// `vectorcraft-cli mcp` session and asserts the rebrand propagation.

export const BRAND = {
  primaryHex: '#0f172a',
  inverseHex: '#f8fafc',
  rebrandHex: '#0d9488',
  fontFamily: 'Inter',
  fontStyle: 'SemiBold',
  wordmarkText: 'ACME',
  primarySwatch: 'Brand/Primary',
  inverseSwatch: 'Brand/Inverse',
  graphicStyle: 'Logo/Mark',
} as const;

export const CANVAS = {
  width: 512,
  height: 512,
  units: 'Pixels',
  colorMode: 'rgb',
  artboards: 1,
  backgroundContents: 'transparent',
} as const;

export const TRACE = {
  preset: 'Flat Logo',
  params: { mode: 'logo', paths: 85, corners: 60, noise: 4, colors: 4 },
} as const;

/** Suffix → pixel size for the favicon matrix, in the order the book lists. */
export const FAVICON_FORMATS = [
  { format: 'png', width: 16, height: 16, suffix: '-16' },
  { format: 'png', width: 32, height: 32, suffix: '-32' },
  { format: 'png', width: 180, height: 180, suffix: '-180' },
  { format: 'png', width: 512, height: 512, suffix: '-512' },
] as const;

/**
 * The provenance record is written by the orchestrator, not the engine. The
 * sha256 is of the flat PNG the mark was traced from, so the lineage can be
 * checked even after the temporary trace source has been removed.
 */
export const buildProvenance = (sourceSha256: string, relinked: number) => ({
  trace_preset: TRACE.preset,
  trace_params: TRACE.params,
  pathfinder_ops: ['pathfinder.unite', 'object.path.cleanUp'],
  swatch_refs: [BRAND.primarySwatch, BRAND.inverseSwatch],
  graphic_style_refs: [BRAND.graphicStyle],
  source_asset_sha256: sourceSha256,
  rebrand: {
    swatch: BRAND.primarySwatch,
    from: BRAND.primaryHex,
    to: BRAND.rebrandHex,
    relinked,
    retraced: false,
  },
  engine: 'vectorcraft',
  created_at: new Date().toISOString(),
});
