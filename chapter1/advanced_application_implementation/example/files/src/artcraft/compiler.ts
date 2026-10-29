// ═══════════════════════════════════════════════════════════════════════════
// FILE 3/9 — src/artcraft/compiler.ts
// Deterministic recipe → command plan compiler.
// ═══════════════════════════════════════════════════════════════════════════

import {
  layerRef,
  scoped,
  type AdjustmentLayerSpec,
  type GroupLayerSpec,
  type JsonObject,
  type JsonValue,
  type LayeredRecipe,
  type LayerSpec,
  type MaskSpec,
  type SmartObjectLayerSpec,
  type SourceAsset,
  type StyleEffect,
  type TypeLayerSpec,
} from './recipe.js';

/** A batch step whose layer references have not yet been resolved. */
export interface PlannedStep {
  id: string;
  params: JsonObject;
  /** True when this step creates a layer whose id later steps may reference. */
  createsLayer?: boolean;
  /** Human-readable note for the job log and the audit trail. */
  note?: string;
}

/** A named group of steps: one phase, one intent, one log line. */
export interface CompiledPhase {
  phase: string;
  steps: PlannedStep[];
}

/** Resolve an asset id to its job-relative path. */
export type AssetPathResolver = (asset: SourceAsset) => string;

/**
 * Compile a recipe into ordered phases.
 *
 * Phases exist for observability and for compensating rollback: on failure we
 * know exactly which command ids executed, and the phase boundary is the
 * natural place to write a history snapshot checkpoint.
 */
export function compileRecipe(
  recipe: LayeredRecipe,
  resolveAssetPath: AssetPathResolver,
): CompiledPhase[] {
  const phases: CompiledPhase[] = [];

  // ── Phase 1: canvas ──────────────────────────────────────────────────────
  phases.push({
    phase: 'canvas',
    steps: [
      {
        id: 'file.new',
        params: {
          width: recipe.canvas.width,
          height: recipe.canvas.height,
          mode: recipe.canvas.mode,
          depth: recipe.canvas.depth,
          background: recipe.canvas.background,
          resolution: recipe.canvas.resolution,
          name: recipe.title,
        },
        note: 'Create the target canvas at the recipe dimensions.',
      },
    ],
  });

  // ── Phase 2..n: the stack ────────────────────────────────────────────────
  const assetById = new Map(recipe.sources.map((a) => [a.id, a]));
  for (const layer of recipe.stack) {
    phases.push(...compileLayer(recipe, layer, assetById, resolveAssetPath, []));
  }

  // ── Phase: variants (Layer Comps) ────────────────────────────────────────
  if (recipe.variants && recipe.variants.length > 0) {
    const steps: PlannedStep[] = [];
    for (const variant of recipe.variants) {
      steps.push({
        id: 'layerComp.new',
        params: {
          name: variant.name,
          comment: variant.comment ?? '',
          visibility: true,
          position: true,
          appearance: variant.appearance ?? false,
        },
        note: `Define the "${variant.name}" layer comp.`,
      });
    }
    phases.push({ phase: 'variants', steps });
  }

  // ── Phase: variable data sets ────────────────────────────────────────────
  if (recipe.dataSets && recipe.dataSets.length > 0) {
    const variableNames = new Set<string>();
    for (const set of recipe.dataSets) {
      for (const v of set.values) variableNames.add(v.variable);
    }

    phases.push({
      phase: 'dataSets.define',
      steps: [
        {
          id: 'image.variables.define',
          params: {
            defs: [...variableNames].map((name) => ({
              name,
              layer: layerRef(findTypeLayerName(recipe, name)),
              type: 'textReplacement',
            })),
          },
          note: 'Bind each data-set variable to its live type layer.',
        },
      ],
    });

    phases.push({
      phase: 'dataSets.values',
      steps: [
        {
          id: 'image.variables.dataSets',
          params: {
            dataSets: recipe.dataSets.map((set) => ({
              name: set.name,
              values: set.values.map((v) => ({
                variable: v.variable,
                kind: v.kind,
                value: v.value,
              })),
            })),
            append: false,
          },
          note: 'Populate every locale/SKU data set in one step.',
        },
      ],
    });
  }

  return phases;
}

/** Compile a single layer spec (and, for groups, its children) into phases. */
function compileLayer(
  recipe: LayeredRecipe,
  spec: LayerSpec,
  assetById: Map<string, SourceAsset>,
  resolveAssetPath: AssetPathResolver,
  ancestry: string[],
): CompiledPhase[] {
  const name = scoped(recipe, [...ancestry, spec.name].join('/'));
  const phases: CompiledPhase[] = [];

  if (spec.kind === 'group') {
    const children = spec.children.flatMap((child) =>
      compileLayer(recipe, child, assetById, resolveAssetPath, [...ancestry, spec.name]),
    );

    // Group layers: create an empty group, build children, then group them.
    // The engine's `layer.groupLayers` groups the *selected* layers, so we
    // create the empty group last and move the produced layers into it.
    const childNames = collectNames(recipe, spec.children, [...ancestry, spec.name]);
    phases.push({
      phase: `group:${name}`,
      steps: [
        {
          id: 'layer.new.group',
          params: { name },
          createsLayer: true,
          note: `Create group "${name}".`,
        },
      ],
    });
    phases.push(...children);
    phases.push({
      phase: `group.arrange:${name}`,
      steps: [
        {
          id: 'layer.groupLayers',
          params: { layer: layerRef(childNames[0]), name },
          note: `Group ${childNames.length} layer(s) under "${name}".`,
        },
        ...(spec.style ? [applyStyleStep(name, spec.style)] : []),
        ...(spec.opacity !== undefined || spec.blend
          ? [
              {
                id: 'layer.setProps',
                params: {
                  layer: layerRef(name),
                  ...(spec.opacity !== undefined ? { opacity: spec.opacity } : {}),
                  ...(spec.blend ? { blend: spec.blend } : {}),
                },
              } satisfies PlannedStep,
            ]
          : []),
      ],
    });
    return phases;
  }

  if (spec.kind === 'adjustment') {
    return compileAdjustment(recipe, spec, name);
  }

  if (spec.kind === 'smart-object') {
    const asset = assetById.get(spec.assetId);
    if (!asset) {
      throw new Error(`recipe ${recipe.id}: layer "${spec.name}" references unknown asset "${spec.assetId}"`);
    }
    phases.push({
      phase: `layer:${name}`,
      steps: [
        // A mask-driven selection must exist *before* the mask is attached.
        ...selectionSteps(spec.mask),
        {
          id: 'file.placeEmbedded',
          params: {
            path: resolveAssetPath(asset),
            fit: spec.fit ?? true,
            smartObject: true,
            ...(spec.scalePercent !== undefined ? { scale: spec.scalePercent } : {}),
            ...(spec.center !== undefined ? { center: spec.center } : {}),
          },
          createsLayer: true,
          note: `Place "${asset.path}" as a live smart object.`,
        },
        {
          id: 'layer.setProps',
          params: { layer: layerRef(name), name },
        },
        ...(spec.mask ? postMaskSteps(name, spec.mask) : []),
        ...(spec.opacity !== undefined || spec.blend
          ? [
              {
                id: 'layer.setProps',
                params: {
                  layer: layerRef(name),
                  ...(spec.opacity !== undefined ? { opacity: spec.opacity } : {}),
                  ...(spec.blend ? { blend: spec.blend } : {}),
                },
              } satisfies PlannedStep,
            ]
          : []),
        ...(spec.smartFilters ?? []).flatMap((f, i) => smartFilterSteps(name, f.filterCommand, f.params, i, spec.smartFilters?.length ?? 1)),
        ...(spec.style ? [applyStyleStep(name, spec.style)] : []),
        { id: 'select.deselect', params: {} },
      ],
    });
    return phases;
  }

  if (spec.kind === 'type') {
    return compileType(recipe, spec, name);
  }

  if (spec.kind === 'shape') {
    phases.push({
      phase: `layer:${name}`,
      steps: [
        ...selectionSteps(spec.mask),
        {
          id: 'shape.create',
          params: {
            kind: spec.shape.kind,
            rect: spec.shape.rect,
            radii: spec.shape.radii,
            sides: spec.shape.sides,
            starRatio: spec.shape.starRatio,
            from: spec.shape.from,
            to: spec.shape.to,
            weight: spec.shape.weight,
            fill: spec.fill,
            stroke: spec.stroke,
            name,
          } as unknown as JsonObject,
          createsLayer: true,
          note: `Create live shape "${name}".`,
        },
        ...(spec.mask ? postMaskSteps(name, spec.mask) : []),
        ...(spec.style ? [applyStyleStep(name, spec.style)] : []),
        { id: 'select.deselect', params: {} },
      ],
    });
    return phases;
  }

  // Pixel layer: a solid fill used as a colour card, matte, or scrim.
  phases.push({
    phase: `layer:${name}`,
    steps: [
      ...selectionSteps(spec.mask),
      {
        id: 'layer.new.layer',
        params: { name, mode: spec.blend ?? 'Normal', opacity: spec.opacity ?? 1 },
        createsLayer: true,
        note: `Create pixel layer "${name}".`,
      },
      ...(spec.fill
        ? [
            {
              id: 'edit.fill',
              params: {
                contents: spec.fill.solidColor ? 'color' : 'foreground',
                color: spec.fill.color ?? spec.fill.solidColor,
                mode: 'normal',
                opacity: 100,
                preserveTransparency: false,
              } as unknown as JsonObject,
              note: `Fill "${name}".`,
            } satisfies PlannedStep,
          ]
        : []),
      ...(spec.mask ? postMaskSteps(name, spec.mask) : []),
      ...(spec.style ? [applyStyleStep(name, spec.style)] : []),
      { id: 'select.deselect', params: {} },
    ],
  });
  return phases;
}

/**
 * Adjustment layers are the heart of the non-destructive argument: they carry
 * parameters, not pixels. Compiling one means (1) establishing the mask
 * selection, (2) creating the layer with the parameters, (3) releasing the
 * selection so the next layer is not accidentally masked by it.
 */
function compileAdjustment(
  recipe: LayeredRecipe,
  spec: AdjustmentLayerSpec,
  name: string,
): CompiledPhase[] {
  return [
    {
      phase: `adjustment:${name}`,
      steps: [
        ...selectionSteps(spec.mask),
        {
          id: `layer.newAdjustmentLayer.${spec.adjustment}`,
          params: {
            ...spec.params,
            ...(spec.mask?.kind === 'path' && spec.mask.pathRef
              ? { path: spec.mask.pathRef }
              : {}),
          },
          createsLayer: true,
          note: `Add live ${spec.adjustment} adjustment layer "${name}".`,
        },
        {
          id: 'layer.setProps',
          params: {
            layer: layerRef(name),
            name,
            ...(spec.opacity !== undefined ? { opacity: spec.opacity } : {}),
            ...(spec.blend ? { blend: spec.blend } : {}),
          },
        },
        { id: 'select.deselect', params: {}, note: 'Release the mask selection.' },
      ],
    },
  ];
}

/** Type layers stay editable: no rasterization, no outlines, ever. */
function compileType(recipe: LayeredRecipe, spec: TypeLayerSpec, name: string): CompiledPhase[] {
  const steps: PlannedStep[] = [
    {
      id: 'type.create',
      params: {
        x: spec.x,
        y: spec.y,
        text: spec.text,
        box: spec.box,
        name,
        align: spec.align ?? 'left',
        orientation: 'horizontal',
        font: spec.font,
        size: spec.size,
        color: spec.color,
      } as unknown as JsonObject,
      createsLayer: true,
      note: `Create editable type layer "${name}".`,
    },
  ];

  if (spec.tracking !== undefined || spec.leading !== undefined) {
    steps.push({
      id: 'type.setStyle',
      params: {
        layer: layerRef(name),
        ...(spec.tracking !== undefined ? { tracking: spec.tracking } : {}),
        ...(spec.leading !== undefined ? { leading: spec.leading } : {}),
      },
    });
  }

  if (spec.warp) {
    steps.push({
      id: 'type.warpText',
      params: {
        layer: layerRef(name),
        style: spec.warp.style,
        orientation: 'horizontal',
        bend: spec.warp.bend ?? 0,
        horizontalDistortion: spec.warp.hDistort ?? 0,
        verticalDistortion: spec.warp.vDistort ?? 0,
      },
      note: 'Warp the type as a live type warp — the glyphs stay editable.',
    });
  }

  if (spec.style) steps.push(applyStyleStep(name, spec.style));

  return [{ phase: `type:${name}`, steps }];
}

/**
 * Compile a mask into a *selection*. Nothing here mutates pixels; it only
 * describes which pixels subsequent operations should consider active.
 */
function selectionSteps(mask: MaskSpec | undefined): PlannedStep[] {
  if (!mask || mask.kind === 'all') return [];
  const steps: PlannedStep[] = [];

  switch (mask.kind) {
    case 'none':
      // Nothing selected: the layer is created with an empty (black) mask.
      break;
    case 'rect':
      if (!mask.rect) throw new Error('mask.kind "rect" requires a rect');
      steps.push({
        id: 'select.rect',
        params: {
          x: mask.rect.x,
          y: mask.rect.y,
          width: mask.rect.width,
          height: mask.rect.height,
          mode: 'replace',
          antiAlias: true,
          feather: mask.featherPx ?? 0,
        },
        note: 'Establish a rectangular selection for the mask.',
      });
      break;
    case 'subject':
      steps.push({
        id: 'select.subject',
        params: {
          sampleAllLayers: mask.sampleAllLayers ?? true,
          mode: 'replace',
        },
        note: 'Segment the subject with Select Subject.',
      });
      break;
    case 'magic-wand': {
      const [start, ...rest] = mask.points ?? [];
      if (!start) throw new Error('mask.kind "magic-wand" requires at least one point');
      steps.push({
        id: 'select.magicWand',
        params: {
          x: start[0],
          y: start[1],
          tolerance: mask.tolerance ?? 32,
          contiguous: true,
          antiAlias: true,
          sampleAllLayers: mask.sampleAllLayers ?? false,
          mode: 'replace',
        },
      });
      for (const [x, y] of rest) {
        steps.push({
          id: 'select.magicWand',
          params: {
            x,
            y,
            tolerance: mask.tolerance ?? 32,
            contiguous: true,
            antiAlias: true,
            sampleAllLayers: mask.sampleAllLayers ?? false,
            mode: 'add',
          },
        });
      }
      break;
    }
    case 'quick':
      steps.push({
        id: 'select.quick',
        params: {
          points: (mask.points ?? []) as unknown as JsonValue,
          size: 30,
          mode: 'add',
          sampleAllLayers: mask.sampleAllLayers ?? false,
          enhanceEdge: false,
        },
        note: 'Refine the selection with the Quick Selection engine.',
      });
      break;
    case 'path':
      steps.push({
        id: 'path.toSelection',
        params: {
          name: mask.pathRef ?? 'work',
          feather: mask.featherPx ?? 0,
          antiAlias: true,
          mode: 'replace',
        },
        note: 'Convert the saved path into a selection.',
      });
      break;
    case 'brush':
      // A brush mask is built *after* the layer exists, painting its mask
      // channel directly. Nothing to do in the pre-selection phase.
      break;
  }

  if (mask.contractPx) {
    steps.push({ id: 'select.modify.contract', params: { radius: mask.contractPx } });
  }
  if (mask.expandPx) {
    steps.push({ id: 'select.modify.expand', params: { radius: mask.expandPx } });
  }
  if (mask.featherPx && mask.kind !== 'rect' && mask.kind !== 'path') {
    steps.push({ id: 'select.modify.feather', params: { radius: mask.featherPx } });
  }
  return steps;
}

/** Attach the mask to an existing layer (fill, hide, or paint it). */
function postMaskSteps(name: string, mask: MaskSpec): PlannedStep[] {
  switch (mask.kind) {
    case 'none':
      return [{ id: 'layer.layerMask.hideAll', params: { layer: layerRef(name) } }];
    case 'all':
      return [{ id: 'layer.layerMask.revealAll', params: { layer: layerRef(name) } }];
    case 'brush':
      if (!mask.stroke) throw new Error('mask.kind "brush" requires a stroke');
      return [
        { id: 'layer.layerMask.hideAll', params: { layer: layerRef(name) } },
        {
          id: 'paint.stroke',
          params: {
            points: mask.stroke.points.map(([x, y]) => [x, y, 1]) as unknown as JsonValue,
            size: mask.stroke.size,
            hardness: mask.stroke.hardness,
            opacity: 1,
            flow: 1,
            color: '#ffffff',
            mode: mask.stroke.erase ? 'clear' : 'normal',
            erase: mask.stroke.erase ?? false,
            target: 'mask',
          } as unknown as JsonObject,
          note: 'Paint the mask channel directly — the mask stays editable.',
        },
      ];
    default:
      return [
        {
          id: 'layer.layerMask.revealSelection',
          params: { layer: layerRef(name) },
          note: 'Convert the active selection into the layer mask.',
        },
      ];
  }
}

/**
 * Convert the layer's whole effect list in one undo step.
 * `replace` semantics make the recipe the single declaration of intent.
 */
function applyStyleStep(name: string, effects: StyleEffect[]): PlannedStep {
  return {
    id: 'layer.layerStyle.replace',
    params: {
      layer: layerRef(name),
      effects: effects.map((e) => ({ kind: e.kind, params: e.params })) as unknown as JsonValue,
    } as unknown as JsonObject,
    note: `Replace the effect list of "${name}" with ${effects.length} effect(s).`,
  };
}

/**
 * Smart filters: convert once, then apply each filter command on the object.
 * The filters remain individually editable and reorderable afterwards.
 */
function smartFilterSteps(
  name: string,
  filterCommand: string,
  params: JsonObject,
  index: number,
  total: number,
): PlannedStep[] {
  const steps: PlannedStep[] = [];
  if (index === 0) {
    steps.push({
      id: 'filter.convertForSmartFilters',
      params: { layer: layerRef(name) },
      note: 'Make the layer a smart object so filters stay live.',
    });
  }
  steps.push({
    id: filterCommand,
    params: { ...params, layer: layerRef(name) },
    note: `Apply smart filter ${index + 1}/${total}: ${filterCommand}.`,
  });
  return steps;
}

/** Collect the scoped names of every leaf layer under a spec list. */
function collectNames(recipe: LayeredRecipe, specs: LayerSpec[], ancestry: string[]): string[] {
  const names: string[] = [];
  for (const spec of specs) {
    if (spec.kind === 'group') {
      names.push(...collectNames(recipe, spec.children, [...ancestry, spec.name]));
    } else {
      names.push(scoped(recipe, [...ancestry, spec.name].join('/')));
    }
  }
  return names;
}

/** Find the type layer bound to a data-set variable (by convention, its name). */
function findTypeLayerName(recipe: LayeredRecipe, variable: string): string {
  const stack = flatten(recipe.stack);
  const match = stack.find((l) => l.kind === 'type' && l.name === variable);
  if (!match) throw new Error(`recipe ${recipe.id}: variable "${variable}" has no matching type layer`);
  return scoped(recipe, match.name);
}

/** Depth-first flattening of the stack. */
function flatten(specs: LayerSpec[]): LayerSpec[] {
  const out: LayerSpec[] = [];
  for (const spec of specs) {
    out.push(spec);
    if (spec.kind === 'group') out.push(...flatten(spec.children));
  }
  return out;
}
