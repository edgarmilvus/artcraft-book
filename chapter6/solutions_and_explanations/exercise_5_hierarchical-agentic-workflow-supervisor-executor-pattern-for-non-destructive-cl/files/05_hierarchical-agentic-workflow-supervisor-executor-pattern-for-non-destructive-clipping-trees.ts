// work-order.ts
// The Supervisor→Executor contract. The types are the deliverable; the runtime
// below is what proves the contract is implementable, with every command id and
// parameter shape taken from the engine's own command registry.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// 1. The work order. Symbolic ids are stable across runs; they are the ONLY
//    cross-step references the Executor is permitted to resolve.
// ---------------------------------------------------------------------------
export type SymbolicId = string;

export interface WorkOrder {
  brief: string;
  seed: number;
  steps: WorkOrderStep[];
}

export type WorkOrderStep =
  | { kind: "create-group"; id: SymbolicId; name: string }
  | { kind: "create-layer"; id: SymbolicId; name: string;
      color?: string; mode?: string; opacity?: number }
  | { kind: "create-fill"; id: SymbolicId; name: string;
      gradient: { from: string; to: string; angle: number; style: "linear" | "radial" } }
  | { kind: "create-shape"; id: SymbolicId; name: string;
      shape: "rectangle" | "rounded-rectangle"; rect: [number, number, number, number];
      radius?: number; fill: string;
      // The engine attaches a layer style to any layer, but a shape is the only
      // kind whose silhouette the shadow can follow exactly. The field is
      // optional so a shape without a shadow costs one command less.
      shadow?: { color: string; opacity: number; angle: number; distance: number; size: number } }
  | { kind: "create-type"; id: SymbolicId; name: string;
      box: [number, number, number, number]; text: string; font: string;
      size: number; color: string }
  | { kind: "create-clip"; id: SymbolicId; clip: SymbolicId; to: SymbolicId }
  | { kind: "create-adjustment"; id: SymbolicId; name: string;
      kindOf: "hue-saturation";
      params: { hue?: number; saturation?: number; lightness?: number; colorize?: boolean } }
  | { kind: "move"; id: SymbolicId; target: SymbolicId;
      position: "above" | "below" | "into" }
  | { kind: "set-props"; id: SymbolicId;
      props: { visible?: boolean; locked?: boolean; blend?: string; opacity?: number } }
  | { kind: "assert"; id: SymbolicId; assert: AssertionSpec };

// Every assertion is phrased against what `doc_inspect` actually reports:
// `name`, `visible`, `clipped`, `effects.items[].kind`, and sibling order.
// There is no `locked` field in the inspection payload and no clip-base id, so
// "clipped to X" is expressed positionally — X is the sibling directly below.
export type AssertionSpec =
  | { kind: "layer-exists" }
  | { kind: "layer-name"; name: string }
  | { kind: "layer-flag"; flag: "visible" | "clipped"; value: boolean }
  | { kind: "clipped-to"; base: SymbolicId }
  | { kind: "inside"; group: SymbolicId }
  | { kind: "directly-above"; below: SymbolicId }
  | { kind: "below"; other: SymbolicId }
  | { kind: "has-effect"; effect: EffectKind };

export type EffectKind =
  | "dropShadow" | "innerShadow" | "outerGlow" | "innerGlow"
  | "stroke" | "colorOverlay" | "gradientOverlay";

// The engine spells effects out in the Layers panel, title case.
const EFFECT_NAME: Record<EffectKind, string> = {
  dropShadow: "Drop Shadow",
  innerShadow: "Inner Shadow",
  outerGlow: "Outer Glow",
  innerGlow: "Inner Glow",
  stroke: "Stroke",
  colorOverlay: "Color Overlay",
  gradientOverlay: "Gradient Overlay",
};

// The Executor's interface the Supervisor binds to.
export interface ExecutorResult {
  status: "ok" | "impossible" | "failed";
  step: SymbolicId;
  engineLayerId?: number;       // present only when the step created a layer
  raw?: unknown;                // raw MCP response for auditing
  error?: string;               // verbatim engine error when status === "failed"
  reason?: string;              // human-readable reason when status === "impossible"
}

export interface AppliedStep {
  step: SymbolicId;
  commands: { id: string; params: Record<string, unknown> }[];
}

export interface VerificationReport extends ExecutorResult {
  assertions: { step: SymbolicId; passed: boolean; detail: string }[];
  requirements: {
    ribbonBehindProduct: boolean;
    badgeBetweenRibbonAndPrice: boolean;
    scrimHasDropShadow: boolean;
    gradeClippedToTypeOnly: boolean;
  };
  applied: AppliedStep[];
  rolledBack: number;
  outputPath?: string;
  outputHash?: string;
}

// ---------------------------------------------------------------------------
// 2. The inspection payload, narrowed to the fields the assertions read.
// ---------------------------------------------------------------------------
export interface InspectNode {
  id: number;
  name: string;
  kind: string;
  visible: boolean;
  opacity: number;
  clipped: boolean;
  effects?: { enabled: boolean; items: { enabled: boolean; kind: string }[] };
  children?: InspectNode[];
}

export interface Inspect {
  width: number;
  height: number;
  layers: InspectNode[];
  history: string[];
  canUndo: boolean;
}

interface Located {
  node: InspectNode;
  parent: InspectNode | null;
  siblings: InspectNode[];
  index: number;
}

function locate(roots: InspectNode[], id: number): Located | null {
  const walk = (
    siblings: InspectNode[], parent: InspectNode | null,
  ): Located | null => {
    for (let index = 0; index < siblings.length; index += 1) {
      const node = siblings[index];
      if (node.id === id) return { node, parent, siblings, index };
      const deeper = walk(node.children ?? [], node);
      if (deeper) return deeper;
    }
    return null;
  };
  return walk(roots, null);
}

// ---------------------------------------------------------------------------
// 3. Engine wrapper. `command_run` wraps its JSON in a text content block and
//    reports a refusal with `isError`, so every branch goes through `unwrap`.
// ---------------------------------------------------------------------------
export class EngineError extends Error {}

export class Engine {
  readonly commandLog: string[] = [];

  constructor(private readonly client: Client) {}

  private async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const reply = await this.client.callTool({ name, arguments: args });
    const { content, isError } = reply as {
      content?: Array<{ type?: string; text?: string }>;
      isError?: boolean;
    };
    const text = content?.find((block) => block.type === "text")?.text;
    if (isError) throw new EngineError(text ?? "the engine refused the call");
    if (typeof text !== "string") throw new EngineError("the reply carried no text block");
    return JSON.parse(text);
  }

  /** Run one registry command. This is the only way the Executor mutates state. */
  async run(id: string, params: Record<string, unknown> = {}): Promise<unknown> {
    this.commandLog.push(id);
    return this.call("command_run", { id, params });
  }

  async inspect(): Promise<Inspect> {
    return (await this.call("doc_inspect", {})) as Inspect;
  }

  async depth(): Promise<number> {
    return (await this.inspect()).history.length;
  }

  async undo(): Promise<void> {
    await this.run("edit.undo");
  }

  async save(path: string): Promise<{ path: string; warnings?: string[] }> {
    this.commandLog.push("doc_save");
    return (await this.call("doc_save", { path, format: "psd" })) as {
      path: string; warnings?: string[];
    };
  }
}

// ---------------------------------------------------------------------------
// 4. Plan validation — the whole order is checked before the engine is touched.
//    A step kind the dispatch table cannot handle, a duplicate id, or a
//    reference to an id that has not been defined yet makes the order
//    `impossible`, and an impossible order costs zero undo steps.
// ---------------------------------------------------------------------------
const STEP_KINDS = [
  "create-group", "create-layer", "create-fill", "create-shape", "create-type",
  "create-clip", "create-adjustment", "move", "set-props", "assert",
] as const;

const LABEL_COLORS = [
  "none", "red", "orange", "yellow", "green", "seafoam",
  "blue", "indigo", "magenta", "fuchsia", "violet", "gray",
] as const;

// Only the create-* kinds introduce an id; every other kind must already have
// one to refer to.
const CREATE_KINDS: readonly WorkOrderStep["kind"][] = [
  "create-group", "create-layer", "create-fill", "create-shape", "create-type",
  "create-adjustment",
];

export function validatePlan(order: WorkOrder): string[] {
  const problems: string[] = [];
  const defined = new Set<SymbolicId>();

  const need = (id: SymbolicId, step: SymbolicId) => {
    if (!defined.has(id)) problems.push(`step ${step} refers to undefined id ${id}`);
  };

  for (const step of order.steps as WorkOrderStep[]) {
    if (!(STEP_KINDS as readonly string[]).includes(step.kind)) {
      problems.push(`step ${(step as { id?: string }).id ?? "?"} has unknown kind ${step.kind}`);
      continue;
    }
    if (CREATE_KINDS.includes(step.kind)) {
      if (defined.has(step.id)) problems.push(`step ${step.id} redefines an earlier id`);
      defined.add(step.id);
    }

    switch (step.kind) {
      case "move":
        need(step.id, step.id); need(step.target, step.id);
        break;
      case "set-props":
        need(step.id, step.id);
        break;
      case "create-clip":
        need(step.clip, step.id); need(step.to, step.id);
        break;
      case "assert":
        need(step.id, step.id);
        if (step.assert.kind === "clipped-to") need(step.assert.base, step.id);
        if (step.assert.kind === "inside") need(step.assert.group, step.id);
        if (step.assert.kind === "directly-above") need(step.assert.below, step.id);
        if (step.assert.kind === "below") need(step.assert.other, step.id);
        break;
      case "create-layer":
        if (step.color !== undefined
          && !(LABEL_COLORS as readonly string[]).includes(step.color)) {
          problems.push(
            `step ${step.id}: "${step.color}" is not a label colour ` +
            `(${LABEL_COLORS.join(", ")})`);
        }
        break;
      case "create-shape":
        if (step.shape === "rounded-rectangle" && step.radius === undefined) {
          problems.push(`step ${step.id}: a rounded rectangle needs a radius`);
        }
        break;
      default:
        break;
    }
  }
  return problems;
}

// ---------------------------------------------------------------------------
// 5. SUPERVISOR. planBanner() is the concrete instantiation of the planning
//    algorithm: roles, then symbolic ids, then a dependency-ordered step list.
//    It never talks to the engine; its only output is a WorkOrder that
//    validatePlan() can prove sound before a single command runs.
//
//    Z-order, back to front:
//      Ribbon::Band | Product::Stack (cutout clipped to gradient) |
//      Sale (badge + label) | Type::Stack (headline group, price group) |
//      Type::Grade (clipped to Type::Stack)
// ---------------------------------------------------------------------------
export function planBanner(brief: string, seed: number): WorkOrder {
  return {
    brief,
    seed,
    steps: [
      // --- back of the composite -------------------------------------------
      { kind: "create-shape", id: "ribbon", name: "Ribbon::Band",
        shape: "rectangle", rect: [0, 620, 1920, 180], fill: "#8a1c3b" },

      // --- product, clipped to its gradient --------------------------------
      { kind: "create-group", id: "product-stack", name: "Product::Stack" },
      { kind: "create-fill", id: "gradient", name: "Gradient::Product",
        gradient: { from: "#f4efe6", to: "#2b2b2b", angle: 90, style: "linear" } },
      { kind: "create-layer", id: "product", name: "Product::Cutout" },
      { kind: "move", id: "gradient", target: "product-stack", position: "into" },
      { kind: "move", id: "product", target: "product-stack", position: "into" },
      { kind: "create-clip", id: "product", clip: "product", to: "gradient" },

      // --- badge, in front of the ribbon and behind the price ---------------
      { kind: "create-group", id: "sale", name: "Sale" },
      { kind: "create-shape", id: "badge", name: "Sale::Badge",
        shape: "rounded-rectangle", rect: [72, 96, 240, 96], radius: 24,
        fill: "#e4572e" },
      { kind: "create-type", id: "badge-label", name: "Sale::Label",
        box: [92, 116, 200, 56], text: "SALE", font: "Helvetica",
        size: 40, color: "#ffffff" },
      { kind: "move", id: "badge-label", target: "sale", position: "into" },
      { kind: "move", id: "badge", target: "sale", position: "into" },

      // --- typography stack -------------------------------------------------
      { kind: "create-group", id: "type-stack", name: "Type::Stack" },
      { kind: "create-group", id: "headline", name: "Type::Headline" },
      { kind: "create-type", id: "headline-text", name: "Type::Headline",
        box: [96, 760, 1100, 120], text: "AW26 / FIELD", font: "Helvetica",
        size: 96, color: "#f4efe6" },
      { kind: "move", id: "headline-text", target: "headline", position: "into" },

      { kind: "create-group", id: "price", name: "Type::Price" },
      { kind: "create-shape", id: "scrim", name: "Type::Scrim",
        shape: "rounded-rectangle", rect: [1180, 720, 620, 240], radius: 32,
        fill: "#111111",
        shadow: { color: "#000000", opacity: 55, angle: 120, distance: 10, size: 18 } },
      { kind: "move", id: "scrim", target: "price", position: "into" },
      { kind: "create-type", id: "price-text", name: "Type::Price",
        box: [1220, 780, 540, 128], text: "€ 168", font: "Helvetica",
        size: 112, color: "#ffffff" },
      { kind: "move", id: "price-text", target: "price", position: "into" },

      { kind: "move", id: "headline", target: "type-stack", position: "into" },
      { kind: "move", id: "price", target: "type-stack", position: "into" },

      // --- top-level order, then the grade ---------------------------------
      { kind: "move", id: "sale", target: "product-stack", position: "above" },
      { kind: "move", id: "type-stack", target: "sale", position: "above" },
      { kind: "move", id: "ribbon", target: "product-stack", position: "below" },

      { kind: "create-adjustment", id: "grade", name: "Type::Grade",
        kindOf: "hue-saturation",
        params: { hue: -4, saturation: 6, lightness: 2 } },
      { kind: "move", id: "grade", target: "type-stack", position: "above" },
      { kind: "create-clip", id: "grade", clip: "grade", to: "type-stack" },

      // --- assertions, cheapest first --------------------------------------
      { kind: "assert", id: "ribbon", assert: { kind: "layer-exists" } },
      { kind: "assert", id: "ribbon", assert: { kind: "below", other: "product-stack" } },
      { kind: "assert", id: "product", assert: { kind: "clipped-to", base: "gradient" } },
      { kind: "assert", id: "product", assert: { kind: "inside", group: "product-stack" } },
      { kind: "assert", id: "badge", assert: { kind: "inside", group: "sale" } },
      { kind: "assert", id: "badge", assert: { kind: "directly-above", below: "badge-label" } },
      { kind: "assert", id: "sale", assert: { kind: "below", other: "type-stack" } },
      { kind: "assert", id: "product-stack", assert: { kind: "below", other: "sale" } },
      { kind: "assert", id: "scrim", assert: { kind: "has-effect", effect: "dropShadow" } },
      { kind: "assert", id: "scrim", assert: { kind: "inside", group: "price" } },
      { kind: "assert", id: "price-text", assert: { kind: "directly-above", below: "scrim" } },
      { kind: "assert", id: "grade", assert: { kind: "clipped-to", base: "type-stack" } },
    ],
  };
}

// ---------------------------------------------------------------------------
// 6. EXECUTOR. One dispatch entry per step kind, each returning the commands it
//    issued so the audit trail is exact rather than reconstructed.
// ---------------------------------------------------------------------------
type Command = { id: string; params: Record<string, unknown> };

function roundedRectKnots(
  [x, y, w, h]: [number, number, number, number],
  radius: number, segments = 6,
): [number, number][] {
  const knots: [number, number][] = [];
  const corners: [number, number, number][] = [
    [x + w - radius, y + radius, -Math.PI / 2],   // top-right
    [x + w - radius, y + h - radius, 0],          // bottom-right
    [x + radius, y + h - radius, Math.PI / 2],    // bottom-left
    [x + radius, y + radius, Math.PI],            // top-left
  ];
  for (const [cx, cy, start] of corners) {
    for (let i = 0; i <= segments; i += 1) {
      const angle = start + (Math.PI / 2) * (i / segments);
      knots.push([
        Math.round(cx + radius * Math.cos(angle)),
        Math.round(cy + radius * Math.sin(angle)),
      ]);
    }
  }
  return knots;
}

function rectKnots(
  [x, y, w, h]: [number, number, number, number],
): [number, number][] {
  return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]];
}

function createdLayer(raw: unknown, step: SymbolicId): number {
  const id = (raw as { layer?: number } | null)?.layer;
  if (typeof id !== "number" || id <= 0) {
    // The exercise's id === 0 edge case: a creation that names no layer is a
    // failure, never a valid target for a later move or clip.
    throw new EngineError(`step ${step} created no layer (reply: ${JSON.stringify(raw)})`);
  }
  return id;
}

export class Executor {
  private readonly ids = new Map<SymbolicId, number>();
  private readonly applied: AppliedStep[] = [];
  private startDepth = 0;

  constructor(private readonly engine: Engine) {}

  async execute(order: WorkOrder): Promise<VerificationReport> {
    const report = this.emptyReport(order);

    // (1) Prove the plan sound before touching the document.
    const problems = validatePlan(order);
    if (problems.length > 0) {
      return { ...report, status: "impossible", reason: problems.join("; "),
        step: order.steps[0]?.id ?? "plan" };
    }

    this.startDepth = await this.engine.depth();

    // (2) Walk the steps. Any throw — engine refusal, missing layer id, font
    //     warning, failed assertion — unwinds the whole order.
    for (const step of order.steps) {
      try {
        const commands = await this.runStep(step);
        if (commands.length > 0) this.applied.push({ step: step.id, commands });
        if (step.kind === "assert") {
          const passed = await this.check(step.id, step.assert);
          report.assertions.push(passed);
          if (!passed.passed) {
            return { ...this.finish(report, step.id, "failed", passed.detail),
              ...(await this.rollbackReport(report)) };
          }
        }
      } catch (err) {
        const message = (err as Error).message;
        const status = message.startsWith("impossible:")
          ? "impossible" : "failed";
        const finished = this.finish(
          report, step.id, status,
          status === "impossible" ? message.slice("impossible:".length).trim() : message);
        return { ...finished, ...(await this.rollbackReport(report)) };
      }
    }

    // (3) The four visual requirements, read back from the finished tree.
    try {
      report.requirements = await this.requirements();
    } catch (err) {
      return { ...this.finish(report, "requirements", "failed", (err as Error).message),
        ...(await this.rollbackReport(report)) };
    }
    return {
      ...report, status: "ok", step: "done",
      // The successful path needs the audit trail too: without it a caller
      // cannot replay or explain a composite that passed every assertion.
      applied: this.appliedSteps(),
    };
  }

  /** Roll the document back to the depth it had before the first step. */
  async rollback(): Promise<number> {
    let undone = 0;
    for (let guard = 0; guard < 512; guard += 1) {
      if ((await this.engine.depth()) <= this.startDepth) break;
      await this.engine.undo();
      undone += 1;
    }
    return undone;
  }

  /** Symbolic id → engine id. Kept after rollback so failures stay legible. */
  layerId(id: SymbolicId): number | undefined {
    return this.ids.get(id);
  }

  appliedSteps(): AppliedStep[] {
    return [...this.applied];
  }

  // -- dispatch ----------------------------------------------------------
  private async runStep(step: WorkOrderStep): Promise<Command[]> {
    switch (step.kind) {
      case "create-group": {
        const raw = await this.engine.run("layer.new.group", { name: step.name });
        this.ids.set(step.id, createdLayer(raw, step.id));
        return [{ id: "layer.new.group", params: { name: step.name } }];
      }

      case "create-layer": {
        const params: Record<string, unknown> = { name: step.name };
        if (step.color !== undefined) params.color = step.color;
        if (step.mode !== undefined) params.mode = step.mode;
        if (step.opacity !== undefined) params.opacity = step.opacity;
        const raw = await this.engine.run("layer.new.layer", params);
        this.ids.set(step.id, createdLayer(raw, step.id));
        return [{ id: "layer.new.layer", params }];
      }

      case "create-fill": {
        const gradient = {
          from: step.gradient.from, to: step.gradient.to,
          angle: step.gradient.angle, style: step.gradient.style,
        };
        const raw = await this.engine.run("layer.newFillLayer.gradient", gradient);
        const layer = createdLayer(raw, step.id);
        this.ids.set(step.id, layer);
        const rename = { layer, name: step.name };
        await this.engine.run("layer.setProps", rename);
        return [
          { id: "layer.newFillLayer.gradient", params: gradient },
          { id: "layer.setProps", params: rename },
        ];
      }

      case "create-shape": {
        // A shape layer IS a solid fill whose mask is a vector path: set the
        // work path, then fill it. `path.set` replaces the work path each time,
        // so shapes never accumulate into one another.
        const knots = step.shape === "rounded-rectangle"
          ? roundedRectKnots(step.rect, step.radius ?? Math.min(step.rect[2], step.rect[3]) / 4)
          : rectKnots(step.rect);
        const path = { name: "work", path: { subpaths: [{ closed: true, op: "combine", knots }] } };
        await this.engine.run("path.set", path);

        const fillParams = { color: step.fill, path: "work" };
        const raw = await this.engine.run("layer.newFillLayer.solidColor", fillParams);
        const layer = createdLayer(raw, step.id);
        this.ids.set(step.id, layer);

        const commands: Command[] = [
          { id: "path.set", params: path },
          { id: "layer.newFillLayer.solidColor", params: fillParams },
        ];

        const rename = { layer, name: step.name };
        await this.engine.run("layer.setProps", rename);
        commands.push({ id: "layer.setProps", params: rename });

        if (step.shadow) {
          const shadow = { layer, ...step.shadow };
          await this.engine.run("layer.layerStyle.dropShadow", shadow);
          commands.push({ id: "layer.layerStyle.dropShadow", params: shadow });
        }
        return commands;
      }

      case "create-type": {
        const params = {
          box: step.box, text: step.text, font: step.font,
          size: step.size, color: step.color,
        };
        const raw = await this.engine.run("type.create", params);
        const layer = createdLayer(raw, step.id);
        this.ids.set(step.id, layer);

        // The reply — not doc_inspect — is where a font substitution shows up.
        const warnings = (raw as { warnings?: string[] }).warnings ?? [];
        const missing = warnings.find((w) => w.includes("not installed"));
        if (missing) {
          throw new EngineError(`impossible: ${missing}`);
        }

        const rename = { layer, name: step.name };
        await this.engine.run("layer.setProps", rename);
        return [
          { id: "type.create", params },
          { id: "layer.setProps", params: rename },
        ];
      }

      case "create-clip": {
        const layer = this.resolve(step.clip);
        const base = this.resolve(step.to);
        // `layer.createClippingMask` takes only the layer: the base is whatever
        // sits directly below it. Verify the plan's intent instead of trusting it.
        const located = locate((await this.engine.inspect()).layers, layer);
        if (!located || located.siblings[located.index + 1]?.id !== base) {
          throw new EngineError(
            `impossible: ${step.clip} is not directly above ${step.to}, ` +
            `so the clip would attach to a different layer`);
        }
        await this.engine.run("layer.createClippingMask", { layer });
        return [{ id: "layer.createClippingMask", params: { layer } }];
      }

      case "create-adjustment": {
        const params = {
          hue: step.params.hue ?? 0,
          saturation: step.params.saturation ?? 0,
          lightness: step.params.lightness ?? 0,
          colorize: step.params.colorize ?? false,
        };
        const raw = await this.engine.run("layer.newAdjustmentLayer.hueSaturation", params);
        const layer = createdLayer(raw, step.id);
        this.ids.set(step.id, layer);
        const rename = { layer, name: step.name };
        await this.engine.run("layer.setProps", rename);
        return [
          { id: "layer.newAdjustmentLayer.hueSaturation", params },
          { id: "layer.setProps", params: rename },
        ];
      }

      case "move": {
        const params = {
          layer: this.resolve(step.id),
          target: this.resolve(step.target),
          position: step.position,
        };
        await this.engine.run("layer.moveTo", params);
        return [{ id: "layer.moveTo", params }];
      }

      case "set-props": {
        const params = { layer: this.resolve(step.id), ...step.props };
        await this.engine.run("layer.setProps", params);
        return [{ id: "layer.setProps", params }];
      }

      case "assert":
        return [];
    }
  }

  // -- assertions --------------------------------------------------------
  private resolve(id: SymbolicId): number {
    const engineId = this.ids.get(id);
    if (engineId === undefined) throw new EngineError(`unresolved symbolic id ${id}`);
    return engineId;
  }

  private async check(
    id: SymbolicId, spec: AssertionSpec,
  ): Promise<{ step: SymbolicId; passed: boolean; detail: string }> {
    const engineId = this.resolve(id);
    const tree = await this.engine.inspect();
    const found = locate(tree.layers, engineId);
    const fail = (detail: string) => ({ step: id, passed: false, detail });

    if (!found) return fail(`${id} (layer ${engineId}) is not in the document`);
    const { node, parent, siblings, index } = found;

    switch (spec.kind) {
      case "layer-exists":
        return { step: id, passed: true, detail: `${id} is layer ${engineId}` };
      case "layer-name":
        return node.name === spec.name
          ? { step: id, passed: true, detail: `name is "${node.name}"` }
          : fail(`${id} is named "${node.name}", expected "${spec.name}"`);
      case "layer-flag": {
        const actual = spec.flag === "visible" ? node.visible : node.clipped;
        return actual === spec.value
          ? { step: id, passed: true, detail: `${spec.flag} is ${actual}` }
          : fail(`${id}: ${spec.flag} is ${actual}, expected ${spec.value}`);
      }
      case "clipped-to": {
        const base = this.resolve(spec.base);
        const below = siblings[index + 1];
        return node.clipped && below?.id === base
          ? { step: id, passed: true, detail: `${id} clips to layer ${base}` }
          : fail(`${id}: clipped=${node.clipped}, sibling below is layer ${below?.id ?? "none"}`);
      }
      case "inside": {
        const group = this.resolve(spec.group);
        return parent?.id === group
          ? { step: id, passed: true, detail: `${id} is inside layer ${group}` }
          : fail(`${id} is inside layer ${parent?.id ?? "the document root"}, not ${group}`);
      }
      case "directly-above": {
        const below = this.resolve(spec.below);
        const sibling = siblings[index + 1];
        return sibling?.id === below
          ? { step: id, passed: true, detail: `${id} sits directly above layer ${below}` }
          : fail(`${id}: the layer below is ${sibling?.id ?? "none"}, not ${below}`);
      }
      case "below": {
        const other = this.resolve(spec.other);
        const otherIndex = siblings.findIndex((s) => s.id === other);
        if (otherIndex < 0) return fail(`${spec.other} is not a sibling of ${id}`);
        return index > otherIndex
          ? { step: id, passed: true, detail: `${id} sits below ${spec.other}` }
          : fail(`${id} sits above ${spec.other}`);
      }
      case "has-effect": {
        const wanted = EFFECT_NAME[spec.effect];
        const items = node.effects?.items ?? [];
        return items.some((item) => item.kind === wanted)
          ? { step: id, passed: true, detail: `${id} carries ${wanted}` }
          : fail(`${id} carries no ${wanted} (effects: ${items.map((i) => i.kind).join(", ") || "none"})`);
      }
    }
  }

  // -- four booleans -----------------------------------------------------
  private async requirements(): Promise<VerificationReport["requirements"]> {
    const tree = await this.engine.inspect();
    const ribbon = locate(tree.layers, this.resolve("ribbon"));
    const productStack = locate(tree.layers, this.resolve("product-stack"));
    const sale = locate(tree.layers, this.resolve("sale"));
    const typeStack = locate(tree.layers, this.resolve("type-stack"));
    const scrim = locate(tree.layers, this.resolve("scrim"));
    const grade = locate(tree.layers, this.resolve("grade"));

    const belowInDocument = (a: Located | null, b: Located | null) => {
      // "Behind" is only meaningful between siblings: a layer nested in another
      // group is entirely inside that group's slot.
      if (!a || !b) return false;
      return a.siblings === b.siblings && a.index > b.index;
    };

    return {
      ribbonBehindProduct:
        belowInDocument(ribbon, productStack)
        && (ribbon?.parent?.id ?? null) === (productStack?.parent?.id ?? null),
      badgeBetweenRibbonAndPrice:
        belowInDocument(sale, typeStack) && belowInDocument(ribbon, sale),
      scrimHasDropShadow:
        (scrim?.node.effects?.items ?? []).some((i) => i.kind === "Drop Shadow"),
      gradeClippedToTypeOnly:
        grade?.node.clipped === true
        && grade.siblings[grade.index + 1]?.id === this.resolve("type-stack"),
    };
  }

  // -- report plumbing ---------------------------------------------------
  private emptyReport(order: WorkOrder): VerificationReport {
    return {
      status: "ok", step: "plan",
      assertions: [],
      requirements: {
        ribbonBehindProduct: false,
        badgeBetweenRibbonAndPrice: false,
        scrimHasDropShadow: false,
        gradeClippedToTypeOnly: false,
      },
      applied: [],
      rolledBack: 0,
    };
  }

  private finish(
    report: VerificationReport, step: SymbolicId,
    status: "impossible" | "failed", detail: string,
  ): VerificationReport {
    const next: VerificationReport = { ...report, status, step };
    if (status === "impossible") next.reason = detail; else next.error = detail;
    return next;
  }

  private async rollbackReport(
    report: VerificationReport,
  ): Promise<Pick<VerificationReport, "applied" | "rolledBack">> {
    const rolledBack = await this.rollback();
    return { applied: this.appliedSteps(), rolledBack };
  }
}

// ---------------------------------------------------------------------------
// 7. The run. Exactly one `doc_save` per successful work order, and none at all
//    when the order failed: a half-built document is never persisted, and the
//    hash of the saved bytes is what the determinism claim is checked against.
// ---------------------------------------------------------------------------
export async function runWorkOrder(
  engine: Engine, order: WorkOrder, outputPath: string,
): Promise<VerificationReport> {
  const executor = new Executor(engine);
  const report = await executor.execute(order);
  if (report.status !== "ok") return report;

  await mkdir(dirname(outputPath), { recursive: true });
  const saved = await engine.save(outputPath);
  const hash = createHash("sha256").update(await readFile(saved.path)).digest("hex");
  return { ...report, outputPath: saved.path, outputHash: hash };
}
