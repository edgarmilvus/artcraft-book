// ═══════════════════════════════════════════════════════════════════════════
// FILE 1/9 — src/artcraft/recipe.ts
// The LayeredRecipe: a versioned, deterministic description of a
// non-destructive stack. This is the source of truth; the .pcraft file
// is a rendered artifact of it.
// ═══════════════════════════════════════════════════════════════════════════

import { createHash } from 'node:crypto';

/** Any JSON-representable value. Used for parameters we forward to the engine. */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type JsonObject = { [key: string]: JsonValue };

/** Inclusive schema identifier. Bump the major when the shape breaks. */
export const RECIPE_SCHEMA = 'artcraft.layered-recipe/v1' as const;

/**
 * A separable source asset.
 *
 * The hash is not decoration. It is the mechanism by which we prove, months
 * later, that the approved frame is built from the exact bytes that were
 * approved — not from a reroll that happens to look similar.
 */
export interface SourceAsset {
  /** Stable, recipe-local identifier referenced by layers. */
  id: string;
  role: 'flat-generation' | 'plate' | 'logo' | 'lut' | 'pattern' | 'background';
  /** Path relative to the job's read root. Absolute paths are rejected. */
  path: string;
  /** SHA-256 of the file bytes at intake. */
  sha256: string;
  bytes: number;
  pixelWidth: number;
  pixelHeight: number;
  origin: AssetOrigin;
}

/** Provenance of a source asset: what produced it, and under what terms. */
export interface AssetOrigin {
  generator: 'diffusion-xl' | 'flux' | 'sdxl-turbo' | 'stock' | 'camera' | 'human';
  /** Hash of the prompt that produced the asset, when machine-generated. */
  promptHash?: string;
  seed?: number;
  model?: string;
  generatedAt?: string;
  license: 'proprietary' | 'cc0' | 'cc-by' | 'internal';
}

/**
 * A mask specification.
 *
 * Masks are compiled into either (a) an active selection at the moment the
 * layer is created — PhotoCraft's adjustment-layer commands consume the live
 * selection as the layer mask — or (b) an explicit `layerMask.*` call after
 * creation. Either way the mask stays editable pixel data, never a bake.
 */
export interface MaskSpec {
  kind: 'all' | 'none' | 'subject' | 'rect' | 'magic-wand' | 'quick' | 'path' | 'brush';
  /** Softness applied with `select.modify.feather`. */
  featherPx?: number;
  /** Shrink before feathering, applied with `select.modify.contract`. */
  contractPx?: number;
  /** Grow before feathering, applied with `select.modify.expand`. */
  expandPx?: number;
  rect?: { x: number; y: number; width: number; height: number };
  /** Lasso/magic-wand seeds, in document coordinates. */
  points?: Array<[number, number]>;
  tolerance?: number;
  sampleAllLayers?: boolean;
  /** A brush-authored mask, replayed with `paint.stroke { target: 'mask' }`. */
  stroke?: {
    points: Array<[number, number]>;
    size: number;
    hardness: number;
    erase?: boolean;
  };
  /** Named document path to use as a vector mask. */
  pathRef?: string;
}

/**
 * Adjustment kinds that PhotoCraft exposes as live adjustment layers.
 * Each maps one-to-one onto `layer.newAdjustmentLayer.<kind>` and is later
 * revisable in place with `layer.setAdjustment`.
 */
export type AdjustmentKind =
  | 'brightnessContrast'
  | 'levels'
  | 'curves'
  | 'exposure'
  | 'vibrance'
  | 'hueSaturation'
  | 'colorBalance'
  | 'blackWhite'
  | 'photoFilter'
  | 'channelMixer'
  | 'invert'
  | 'posterize'
  | 'threshold'
  | 'gradientMap'
  | 'selectiveColor'
  | 'colorLookup';

export interface AdjustmentLayerSpec {
  kind: 'adjustment';
  name: string;
  adjustment: AdjustmentKind;
  /** Parameters forwarded verbatim; validated by the engine, not by us. */
  params: JsonObject;
  mask?: MaskSpec;
  opacity?: number;
  blend?: string;
}

export interface SmartObjectLayerSpec {
  kind: 'smart-object';
  name: string;
  /** Id of the SourceAsset to place (Place Embedded). */
  assetId: string;
  /** Fit mode when the asset is larger than the canvas. */
  fit?: boolean;
  scalePercent?: number;
  /** Centre of the placed layer in document pixels; defaults to canvas centre. */
  center?: [number, number];
  mask?: MaskSpec;
  opacity?: number;
  blend?: string;
  /** Live effects applied declaratively via `layer.layerStyle.replace`. */
  style?: StyleEffect[];
  /** Live smart-filter chain (non-destructive filters on the smart object). */
  smartFilters?: SmartFilterSpec[];
}

export interface PixelLayerSpec {
  kind: 'layer';
  name: string;
  fill?: { color?: string; solidColor?: string };
  mask?: MaskSpec;
  opacity?: number;
  blend?: string;
  style?: StyleEffect[];
}

export interface TypeLayerSpec {
  kind: 'type';
  name: string;
  text: string;
  x: number;
  y: number;
  font: string;
  size: number;
  color: string;
  align?: 'left' | 'center' | 'right';
  /** Paragraph box (area type) when present. */
  box?: [number, number, number, number];
  tracking?: number;
  leading?: number | 'auto';
  /** Warp applied as a live type warp, keeping the type editable. */
  warp?: { style: string; bend?: number; hDistort?: number; vDistort?: number };
  style?: StyleEffect[];
}

export interface ShapeLayerSpec {
  kind: 'shape';
  name: string;
  shape: {
    kind: 'rect' | 'roundedRect' | 'ellipse' | 'polygon' | 'star' | 'line';
    rect?: [number, number, number, number];
    radii?: number | [number, number, number, number];
    sides?: number;
    starRatio?: number;
    from?: [number, number];
    to?: [number, number];
    weight?: number;
  };
  fill: JsonValue;
  stroke: JsonValue | null;
  mask?: MaskSpec;
  opacity?: number;
  blend?: string;
  style?: StyleEffect[];
}

export interface GroupLayerSpec {
  kind: 'group';
  name: string;
  children: LayerSpec[];
  opacity?: number;
  blend?: string;
  style?: StyleEffect[];
}

export type LayerSpec =
  | AdjustmentLayerSpec
  | SmartObjectLayerSpec
  | PixelLayerSpec
  | TypeLayerSpec
  | ShapeLayerSpec
  | GroupLayerSpec;

/** A declarative live effect, applied whole with `layer.layerStyle.replace`. */
export interface StyleEffect {
  kind:
    | 'dropShadow'
    | 'innerShadow'
    | 'outerGlow'
    | 'innerGlow'
    | 'stroke'
    | 'colorOverlay'
    | 'gradientOverlay'
    | 'patternOverlay'
    | 'satin'
    | 'bevelEmboss';
  params: JsonObject;
}

/**
 * A smart filter on a smart object. Filters are applied with their own
 * commands (e.g. `filter.blur.gaussianBlur`) after `filter.convertForSmartFilters`,
 * and are later revisable with `layer.smartFilter.setParams`.
 */
export interface SmartFilterSpec {
  filterCommand: string;
  params: JsonObject;
  visible?: boolean;
}

/** A named visibility state: Layer Comps give us non-destructive variants. */
export interface VariantSpec {
  name: string;
  comment?: string;
  /** Layer names forced visible / hidden in this comp. */
  show?: string[];
  hide?: string[];
  /** Appearance-only comp (effects/opacity) rather than visibility. */
  appearance?: boolean;
}

/** Variable-data sets for localized or per-SKU text propagation. */
export interface DataSetSpec {
  name: string;
  values: Array<{ variable: string; kind: 'text' | 'visibility'; value: string }>;
}

/** Machine-checkable acceptance criteria for the multimodal audit loop. */
export interface AuditPolicy {
  /** Maximum correction rounds before we fail the job loudly. */
  maxRounds: number;
  rubric: string;
  /** Deterministic composite probes, read with `document.pixel`. */
  probes?: Array<{ x: number; y: number; label: string; expect?: 'not-clipped' }>;
  /** Refuse to ship if the mean composite luma moves more than this per round. */
  convergenceEpsilon?: number;
}

/** A single deliverable derived from the same master stack. */
export interface DeliverySpec {
  id: string;
  kind: 'raster' | 'vector' | 'motion' | 'print';
  path: string;
  format: 'png' | 'jpg' | 'tif' | 'webp' | 'svg' | 'mp4' | 'pdf';
  width?: number;
  height?: number;
  quality?: number;
  /** Motion only. */
  seconds?: number;
  fps?: number;
}

export interface LayeredRecipe {
  schema: typeof RECIPE_SCHEMA;
  id: string;
  title: string;
  createdAt: string;
  canvas: {
    width: number;
    height: number;
    mode: 'rgb' | 'cmyk' | 'gray' | 'lab';
    depth: 8 | 16 | 32;
    background: string;
    resolution: number;
  };
  sources: SourceAsset[];
  /** Bottom-to-top paint order, exactly as the Layers panel reads. */
  stack: LayerSpec[];
  variants?: VariantSpec[];
  dataSets?: DataSetSpec[];
  audit?: AuditPolicy;
  delivery: DeliverySpec[];
}

/**
 * Deterministic JSON serialisation: object keys sorted, arrays preserved.
 *
 * Why this matters: we hash the recipe to produce a provenance digest. If key
 * ordering leaked into the hash, the same logical recipe produced by two
 * different code paths would yield two different digests and the audit trail
 * would be worthless.
 */
export function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`;
  }
  const keys = Object.keys(value).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as JsonObject)[k])}`)
    .join(',')}}`;
}

/** SHA-256 digest of the canonical recipe form. */
export function recipeDigest(recipe: LayeredRecipe): string {
  return createHash('sha256').update(stableStringify(recipe as unknown as JsonValue)).digest('hex');
}

/** A runtime placeholder resolved against the live layer index. */
export type LayerRef = { $layer: string };

export function layerRef(name: string): LayerRef {
  return { $layer: name };
}

export function isLayerRef(value: unknown): value is LayerRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { $layer?: unknown }).$layer === 'string'
  );
}

/** Namespacing helper: prevents collisions between jobs in a shared document. */
export function scoped(recipe: LayeredRecipe, name: string): string {
  return `${recipe.id}/${name}`;
}
