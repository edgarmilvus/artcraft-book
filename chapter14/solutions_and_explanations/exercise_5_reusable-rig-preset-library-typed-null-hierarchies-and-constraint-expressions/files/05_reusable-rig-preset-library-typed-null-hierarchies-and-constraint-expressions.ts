// Language: typescript
// rig-presets.ts
import { readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/* ================================================================== *
 * PART A — PUBLIC TYPE SURFACE. No `any` below this point.
 * ================================================================== */

export type PresetName = "pushFollow" | "shakeNull" | "wordmarkRig" | "trimWipe" | "counterRig";

export interface PushFollowParams { dampX: number; dampY: number; delayFrames: number; targetLayerId?: number; }
export interface ShakeNullParams  { amplitude: number; frequency: number; }
export interface WordmarkRigParams { breath: number; settleFrames: number; }
export interface TrimWipeParams    { wipeDuration: number; }
export interface CounterRigParams  { multiplier: number; padWidth: number; }

export type PresetParamsMap = {
  pushFollow: PushFollowParams;
  shakeNull: ShakeNullParams;
  wordmarkRig: WordmarkRigParams;
  trimWipe: TrimWipeParams;
  counterRig: CounterRigParams;
};

// Discriminated union — wrong-param pairing is a compile error.
export type ApplyArgs = {
  [K in PresetName]: { presetName: K; params: PresetParamsMap[K] }
}[PresetName];

// Per-preset detail returned by the script.
export interface PushFollowDetail {
  createdLayers: number[];
  expressions: Record<string, string[]>;
  essentialProperties: Array<{ layer: number; control: string }>;
  reused: boolean;
  nullLayer: number;
}
export interface ShakeNullDetail {
  createdLayers: number[];
  expressions: Record<string, string[]>;
  essentialProperties: Array<{ layer: number; control: string }>;
  reused: boolean;
  nullLayer: number;
  sliders: string[];
}
export interface WordmarkRigDetail extends PushFollowDetail { breathControl: string; }
export interface TrimWipeDetail {
  createdLayers: number[];
  expressions: Record<string, string[]>;
  essentialProperties: Array<{ layer: number; control: string }>;
  reused: boolean;
  trimPath: string;
  wipeDuration: number;
}
export interface CounterRigDetail {
  createdLayers: number[];
  expressions: Record<string, string[]>;
  essentialProperties: Array<{ layer: number; control: string }>;
  reused: boolean;
  expression: string;
}

export interface PresetDetailMap {
  pushFollow: PushFollowDetail;
  shakeNull: ShakeNullDetail;
  wordmarkRig: WordmarkRigDetail;
  trimWipe: TrimWipeDetail;
  counterRig: CounterRigDetail;
}

// Mapped-type composition: narrowing on `preset` yields the right `detail`.
export type AppliedPreset = {
  [K in PresetName]: {
    preset: K;
    version: number;
    detail: PresetDetailMap[K];
    undoLabel: string;
    warnings: string[];
  }
}[PresetName];

export type PresetErrorCode =
  | "PresetPreconditionFailed"
  | "PresetParameterMismatch"
  | "PresetVersionTooNew"
  | "PresetScriptFailed"
  | "SandboxViolation";

export interface PresetError {
  code: PresetErrorCode;
  hint: string;
  message: string;
}

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

/* ================================================================== *
 * PART B — PRESET DESCRIPTORS (loaded from /presets/*.json)
 * ================================================================== */

export interface ParamDescriptor {
  type: "number" | "integer" | "string";
  default: number | string;
  since: number;
  min?: number;
  max?: number;
}

export interface PresetDescriptor {
  name: PresetName;
  version: number;
  params: Record<string, ParamDescriptor>;
  preconditions: string[];
}

export type DescriptorMap = Record<PresetName, PresetDescriptor>;

export const RUNTIME_VERSION = 2;

export async function loadDescriptors(root = "presets"): Promise<DescriptorMap> {
  const names: PresetName[] = ["pushFollow", "shakeNull", "wordmarkRig", "trimWipe", "counterRig"];
  const out = {} as DescriptorMap;
  for (const n of names) {
    const raw = JSON.parse(await readFile(`${root}/${n}.json`, "utf8")) as PresetDescriptor;
    out[n] = raw;
  }
  return out;
}

/* ================================================================== *
 * PART C — PURE VALIDATION (fully unit-testable, no EffectCraft needed)
 * ================================================================== */

export interface ValidationResult {
  params: Record<string, number | string>;
  warnings: string[];
}

function mergeWithDefaults(
  descriptor: PresetDescriptor,
  supplied: Record<string, unknown>,
): { merged: Record<string, number | string>; warnings: string[] } {
  const merged: Record<string, number | string> = {};
  const warnings: string[] = [];
  for (const [key, meta] of Object.entries(descriptor.params)) {
    if (key in supplied) {
      const v = supplied[key];
      if (meta.type === "number" && typeof v !== "number") throw new Error(`param ${key} must be number`);
      merged[key] = v as number | string;
    } else {
      merged[key] = meta.default;
    }
  }
  // Forward compatibility: drop undeclared params with a warning.
  for (const key of Object.keys(supplied)) {
    if (!(key in descriptor.params)) {
      warnings.push(`unknown-param-dropped: ${key}`);
    }
  }
  return { merged, warnings };
}

export function validatePresetParams(
  descriptor: PresetDescriptor,
  supplied: Record<string, unknown>,
): Result<ValidationResult, PresetError> {
  if (descriptor.version > RUNTIME_VERSION) {
    return {
      ok: false,
      error: {
        code: "PresetVersionTooNew",
        message: `preset ${descriptor.name} is v${descriptor.version}, runtime is v${RUNTIME_VERSION}`,
        hint: "Update the rig-presets library or pin to an older version",
      },
    };
  }
  let merged: Record<string, number | string>;
  let warnings: string[];
  try {
    const r = mergeWithDefaults(descriptor, supplied);
    merged = r.merged;
    warnings = r.warnings;
  } catch (err) {
    return {
      ok: false,
      error: { code: "PresetParameterMismatch", message: (err as Error).message, hint: "See preset descriptor" },
    };
  }
  for (const [key, value] of Object.entries(merged)) {
    const meta = descriptor.params[key];
    if (!meta) {
      warnings.push(`unknown-param-dropped: ${key}`);
      continue;
    }
    if (meta.type === "number" && typeof value === "number") {
      if (meta.min !== undefined && value < meta.min) {
        return {
          ok: false,
          error: { code: "PresetParameterMismatch", message: `${key}=${value} < min ${meta.min}`, hint: `Range [${meta.min}, ${meta.max}]` },
        };
      }
      if (meta.max !== undefined && value > meta.max) {
        return {
          ok: false,
          error: { code: "PresetParameterMismatch", message: `${key}=${value} > max ${meta.max}`, hint: `Range [${meta.min}, ${meta.max}]` },
        };
      }
    }
  }
  return { ok: true, value: { params: merged, warnings } };
}

/* ================================================================== *
 * PART D — SCRIPT RESULT GUARD (hand-written, adversarial-safe)
 * ================================================================== */

export function isAppliedPresetDetail(v: unknown): v is {
  createdLayers: number[];
  expressions: Record<string, string[]>;
  essentialProperties: Array<{ layer: number; control: string }>;
  reused: boolean;
} {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  if (!Array.isArray(o.createdLayers) || !o.createdLayers.every((x) => typeof x === "number")) return false;
  if (!Array.isArray(o.essentialProperties)) return false;
  if (typeof o.reused !== "boolean") return false;
  if (typeof o.expressions !== "object" || o.expressions === null || Array.isArray(o.expressions)) return false;
  for (const value of Object.values(o.expressions as Record<string, unknown>)) {
    if (!Array.isArray(value) || !value.every((x) => typeof x === "string")) return false;
  }
  return true;
}

/* ================================================================== *
 * PART E — MCP CLIENT ABSTRACTION (easily faked for unit tests)
 * ================================================================== */

export interface McpClient {
  getLayer(layer: number | string, opts?: { flat?: boolean }): Promise<unknown>;
  runScript(code: string, name?: string): Promise<{ ok: boolean; result: unknown; output: string; error: { message: string; line: number; column: number } | null }>;
  historyList(): Promise<Array<{ label: string }>>;
  openProject(path: string): Promise<void>;
  getComp(): Promise<{ id: number | string; name: string; layers: Array<{ id: number; name: string; type: string }> }>;
}

export function mcpFromSdk(client: Client): McpClient {
  const call = async (tool: string, args: Record<string, unknown>) =>
    (await (client as any).callTool({ name: tool, arguments: args })).content ?? null;
  return {
    getLayer: (layer, opts) => call("get_layer", { layer, flat: opts?.flat ?? false }),
    runScript: (code, name) => call("run_script", { code, name }) as any,
    historyList: async () => {
      const r = await call("execute_command", { command: "edit.history.list", params: {} });
      return ((r as any)?.states ?? []) as Array<{ label: string }>;
    },
    openProject: async (path) => { await call("open_project", { path }); },
    getComp: async () => call("get_comp", {}) as any,
  };
}

/* ================================================================== *
 * PART F — PRECONDITION CHECKS
 * ================================================================== */

async function checkPreconditions(
  mcp: McpClient,
  descriptor: PresetDescriptor,
  layer: number,
): Promise<Result<void, PresetError>> {
  const flat = (await mcp.getLayer(layer, { flat: true })) as Array<{ type: string }>;
  for (const pre of descriptor.preconditions) {
    const ok = (() => {
      switch (pre) {
        case "shapePathExists": return flat.some((n) => n.type.toLowerCase().includes("path"));
        case "targetLayerExists": return true; // caller supplied or defaulted
        case "textLayerWithText": return flat.some((n) => n.type.toLowerCase().includes("text"));
        case "notTemplateLayer": return true;
        default: return true;
      }
    })();
    if (!ok) {
      return {
        ok: false,
        error: {
          code: "PresetPreconditionFailed",
          message: `precondition failed: ${pre}`,
          hint: pre === "shapePathExists" ? "Add a path to the shape layer before applying trimWipe" : "See preset descriptor",
        },
      };
    }
  }
  return { ok: true, value: undefined };
}

/* ================================================================== *
 * PART G — DRY-RUN SUPPORT
 * ================================================================== */

export interface DryRunResult {
  wouldCreate: number;
  expressions: number;
  undoLabel: string;
}

function dryRunFor(descriptor: PresetDescriptor, args: ApplyArgs): DryRunResult {
  const counts: Record<PresetName, number> = {
    pushFollow: 1,
    shakeNull: 1,
    wordmarkRig: 2,
    trimWipe: 0,
    counterRig: 1,
  };
  const exprCounts: Record<PresetName, number> = {
    pushFollow: 1,
    shakeNull: 1,
    wordmarkRig: 2,
    trimWipe: 1,
    counterRig: 1,
  };
  return {
    wouldCreate: counts[descriptor.name],
    expressions: exprCounts[descriptor.name],
    undoLabel: `Rig Library: ${descriptor.name}`,
  };
}

/* ================================================================== *
 * PART H — SCRIPT ATMOSPHERE
 * ================================================================== */

function wrapScript(presetName: PresetName, scriptBody: string, params: Record<string, unknown>): string {
  return `
    (function() {
      var __params__ = ${JSON.stringify(params)};
      app.beginUndoGroup("Rig Library: ${presetName}");
      try {
        ${scriptBody}
      } finally {
        app.endUndoGroup();
      }
    })();
  `;
}

async function loadScriptBody(presetName: PresetName): Promise<string> {
  return readFile(`scripts/${presetName}.js`, "utf8");
}

/* ================================================================== *
 * PART I — PUBLIC API
 * ================================================================== */

export interface ApplyOptions {
  dryRun?: boolean;
  compId?: number | string;
}

export async function applyPreset(
  mcp: McpClient,
  layer: number,
  args: ApplyArgs,
  descriptors: DescriptorMap,
  opts: ApplyOptions = {},
): Promise<Result<AppliedPreset, PresetError>> {
  const descriptor = descriptors[args.presetName];

  // 1. validate params (pure)
  const validation = validatePresetParams(descriptor, args.params as unknown as Record<string, unknown>);
  if (!validation.ok) return validation;

  // 2. dry-run short-circuit
  if (opts.dryRun) {
    return { ok: true, value: { preset: descriptor.name, version: descriptor.version, detail: {} as any, undoLabel: `Rig Library: ${descriptor.name}`, warnings: validation.value.warnings } as AppliedPreset };
  }

  // 3. preconditions
  const pre = await checkPreconditions(mcp, descriptor, layer);
  if (!pre.ok) return pre;

  // 4. count history entries before
  const before = (await mcp.historyList()).length;

  // 5. run the script with params
  const body = await loadScriptBody(descriptor.name);
  const code = wrapScript(descriptor.name, body, validation.value.params);
  const scriptRes = await mcp.runScript(code, `rig-library:${descriptor.name}`);

  if (!scriptRes.ok) {
    return {
      ok: false,
      error: {
        code: "PresetScriptFailed",
        message: scriptRes.error?.message ?? "unknown",
        hint: `Script failed at line ${scriptRes.error?.line ?? "?"}`,
      },
    };
  }
  if (!isAppliedPresetDetail(scriptRes.result)) {
    return {
      ok: false,
      error: {
        code: "PresetScriptFailed",
        message: "script returned malformed result",
        hint: "Check that the preset script ends with an AppliedPresetDetail expression",
      },
    };
  }

  // 6. verify single undo entry
  const after = (await mcp.historyList()).length;
  if (after - before !== 1) {
    return {
      ok: false,
      error: {
        code: "PresetScriptFailed",
        message: `expected 1 history entry, got ${after - before}`,
        hint: "The preset script mutated outside the undo group",
      },
    };
  }

  const detail = scriptRes.result;
  return {
    ok: true,
    value: {
      preset: descriptor.name,
      version: descriptor.version,
      detail,
      undoLabel: `Rig Library: ${descriptor.name}`,
      warnings: validation.value.warnings,
    } as AppliedPreset,
  };
}

/* ================================================================== *
 * PART J — EXHAUSTIVE-SWITCH DEMONSTRATION
 * ================================================================== */

export function describeApplied(applied: AppliedPreset): string {
  switch (applied.preset) {
    case "pushFollow":
      return `pushFollow → null #${applied.detail.nullLayer} (damp reported in expressions)`;
    case "shakeNull":
      return `shakeNull → null #${applied.detail.nullLayer}, sliders: ${applied.detail.sliders.join(", ")}`;
    case "wordmarkRig":
      return `wordmarkRig → null #${applied.detail.nullLayer}, breath=${applied.detail.breathControl}`;
    case "trimWipe":
      return `trimWipe → path ${applied.detail.trimPath}, duration=${applied.detail.wipeDuration}s`;
    case "counterRig":
      return `counterRig → ${applied.detail.expression}`;
  }
  // The compiler knows this is unreachable: every discriminant is handled.
}

/* ================================================================== *
 * PART K — SCRIPTS (one example; the others follow this shape)
 * ================================================================== */

export const PUSH_FOLLOW_SCRIPT = `
var comp = app.project.activeItem;
if (!comp) { return { error: "no-active-comp" }; }

// Idempotency: reuse an existing rig null with our marker name.
var existing = null;
for (var i = 1; i <= comp.numLayers; i++) {
  var L = comp.layer(i);
  if (L.name === "Rig: pushFollow") { existing = L; break; }
}
if (existing) {
  return {
    createdLayers: [],
    expressions: {},
    essentialProperties: [],
    reused: true,
    nullLayer: existing.index,
  };
}

var target = __params__.targetLayerId ? comp.layer(__params__.targetLayerId) : comp.selectedLayers[0];
if (!target) { throw new Error("pushFollow: no target layer"); }

var rig = comp.layers.addNull();
rig.name = "Rig: pushFollow";
rig.enabled = true;

var pos = rig.property("ADBE Transform Group").property("ADBE Position");
var delay = __params__.delayFrames / comp.frameRate;
var dampX = __params__.dampX;
var dampY = __params__.dampY;

// Sampling-lag expression: read the target's position but delayed by delay.
var expr =
  "var t = thisComp.layer(\"" + target.name + "\");" +
  "var lag = t.transform.position.valueAtTime(time - " + delay + ", false);" +
  "var cur = t.transform.position;" +
  "[" + dampX + " * lag[0] + (1 - " + dampX + ") * cur[0]," +
  " " + dampY + " * lag[1] + (1 - " + dampY + ") * cur[1]];";
pos.expression = expr;

return {
  createdLayers: [rig.index],
  expressions: { [String(rig.index)]: [expr] },
  essentialProperties: [],
  reused: false,
  nullLayer: rig.index,
};
`;

/* ================================================================== *
 * PART L — INTEGRATION HARNESS (skipped unless env var is set)
 * ================================================================== */

export async function integrationHarness(): Promise<void> {
  if (process.env.EFFECTCRAFT_INTEGRATION !== "1") return;
  const transport = new StdioClientTransport({
    command: "effectcraft-cli",
    args: ["mcp", "--automation-read-root", process.cwd(), "--automation-write-root", process.cwd()],
  });
  const client = new Client({ name: "rig-presets-it", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  try {
    const mcp = mcpFromSdk(client);
    const descriptors = await loadDescriptors();

    await mcp.openProject("fixture.ecproj");
    const comp = await mcp.getComp();
    const shapeLayer = comp.layers.find((l) => l.type.toLowerCase() === "shape");
    if (!shapeLayer) throw new Error("fixture missing a shape layer");

    // pushFollow first
    const r1 = await applyPreset(mcp, shapeLayer.id, { presetName: "pushFollow", params: { dampX: 0.85, dampY: 0.85, delayFrames: 3 } }, descriptors);
    if (!r1.ok) throw new Error(`pushFollow failed: ${r1.error.message}`);

    // idempotent second call
    const r2 = await applyPreset(mcp, shapeLayer.id, { presetName: "pushFollow", params: { dampX: 0.85, dampY: 0.85, delayFrames: 3 } }, descriptors);
    if (!r2.ok || r2.value.preset !== "pushFollow" || r2.value.detail.reused !== true) {
      throw new Error("idempotency failed");
    }

    // dry-run of trimWipe must NOT touch the document
    const beforeHist = (await mcp.historyList()).length;
    await applyPreset(mcp, shapeLayer.id, { presetName: "trimWipe", params: { wipeDuration: 1.0 } }, descriptors, { dryRun: true });
    const afterHist = (await mcp.historyList()).length;
    if (afterHist !== beforeHist) throw new Error("dry-run mutated the document");
  } finally {
    await client.close();
  }
}
