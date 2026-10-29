import { createHash } from "crypto";
import { mkdirSync, writeFileSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// ────────────────────────────────────────────────────────────────────────────
// 1. ANCHOR MATH — pure functions, no I/O. Fully deterministic.
// ────────────────────────────────────────────────────────────────────────────
type Pt = { x: number; y: number };
type Role = "corner" | "tangent" | "extreme";
type HandlePolicy =
  | { kind: "auto-tangent" }
  | { kind: "fixed-ratio"; ratio: number; anchoredTo: "next" | "prev" }
  | { kind: "mirrored" }
  | { kind: "independent"; in?: [number, number]; out?: [number, number] };

interface SpecAnchor {
  id: string; role: Role;
  grid: { col: number; row: number } | null;
  abs: [number, number] | null;
  handle: HandlePolicy; smooth?: boolean;
}
interface Subpath   { closed: boolean; op?: "combine"|"subtract"|"intersect"|"exclude"; anchors: SpecAnchor[]; }
interface IconSpec  { name: string; viewBox: [number,number,number,number]; strokeWidth: number;
                      strokeColor: string; fillColor: string|null; fillRule: "nonZero"|"evenOdd";
                      subpaths: Subpath[]; }

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Pt, s: number): Pt => ({ x: a.x * s, y: a.y * s });

// 1/3 tangents — the design team's interior budget.
function outHandle1_3(anchor: Pt, next: Pt): Pt { return add(anchor, mul(sub(next, anchor), 1/3)); }
function inHandle1_3 (anchor: Pt, prev: Pt): Pt { return add(anchor, mul(sub(prev, anchor), 1/3)); }

function computeHandles(anchors: Pt[], i: number, policies: HandlePolicy[]): { in?: Pt; out?: Pt } {
  const n = anchors.length;
  const a  = anchors[i];
  const pv = anchors[(i - 1 + n) % n];
  const nx = anchors[(i + 1) % n];
  const pol = policies[i];
  switch (pol.kind) {
    case "auto-tangent":   return { out: outHandle1_3(a, nx), in: inHandle1_3(a, pv) };
    case "fixed-ratio": {
      const target = pol.anchoredTo === "next" ? nx : pv;
      const out = add(a, mul(sub(target, a), pol.ratio));
      return { out, in: add(a, mul(sub(a, pv), pol.ratio)) };       // mirrored peer
    }
    case "mirrored":       return { out: outHandle1_3(a, nx), in: add(a, mul(sub(a, outHandle1_3(a, nx)), 1)) };
    case "independent": {
      const p: { in?: Pt; out?: Pt } = {};
      if (pol.in)  p.in  = { x: pol.in[0],  y: pol.in[1]  };
      if (pol.out) p.out = { x: pol.out[0], y: pol.out[1] };
      return p;
    }
  }
}

// 8 pt grid snap. Only applied to `extreme` anchors; every other role is left alone.
function gridSnap(a: SpecAnchor, unit = 8): { snapped: Pt; drift: number } {
  const raw = a.grid ? { x: a.grid.col * unit, y: a.grid.row * unit }
                     : { x: a.abs![0], y: a.abs![1] };
  if (a.role !== "extreme") return { snapped: raw, drift: 0 };
  const s = { x: Math.round(raw.x / unit) * unit, y: Math.round(raw.y / unit) * unit };
  return { snapped: s, drift: Math.hypot(s.x - raw.x, s.y - raw.y) };
}

function classifyRole(a: SpecAnchor): Role { return a.role; }   // declaration wins; hooks for future autodetect

// ────────────────────────────────────────────────────────────────────────────
// 2. SPEC → PATH.CREATE PAYLOADS.  One batch per icon, then a final assembly batch.
// ────────────────────────────────────────────────────────────────────────────
interface BatchStep { id: string; params: Record<string, unknown>; }

function buildIconBatch(spec: IconSpec, warnings: string[]): BatchStep[] {
  const steps: BatchStep[] = [];
  const subpathIds: string[] = [];           // will hold "$N.id" references

  // 2a. Each subpath becomes its own path.create (holes are separate objects for now).
  spec.subpaths.forEach((sp, spIndex) => {
    const anchors: Pt[] = sp.anchors.map(a => gridSnap(a).snapped);
    const policies = sp.anchors.map(a => a.handle);
    const payload = anchors.map((a, i) => {
      const h = computeHandles(anchors, i, policies);
      const p: any = { x: a.x, y: a.y };
      if (h.in)  p.in  = [h.in.x,  h.in.y];
      if (h.out) p.out = [h.out.x, h.out.y];
      if (sp.anchors[i].smooth) p.smooth = true;
      return p;
    });

    // Unclosed tangent at the seam: a corner anchor at the end with no out-handle.
    const last = sp.anchors[sp.anchors.length - 1];
    if (sp.closed && last.role === "tangent" && !last.smooth) {
      const first = sp.anchors[0];
      if (first.role === "corner") {
        // Repair by upgrading the seam to smooth BEFORE construction; still one object.
        warnings.push(`${spec.name}: subpath ${spIndex} closed-tangent seam upgraded to smooth`);
        payload[payload.length - 1].smooth = true;
      }
    }

    steps.push({ id: "path.create", params: { anchors: payload, closed: sp.closed } });
    subpathIds.push(`$${steps.length - 1}.id`);
  });

  // 2b. Merge subpaths into one compound path (which honours the fill rule).
  if (subpathIds.length > 1) {
    // The ids are copied: `subpathIds` is spliced below, and a live
    // reference would rewrite this step's payload after the fact.
    steps.push({ id: "select.set", params: { ids: [...subpathIds] } });   // VectorCraft compoundPath.make operates on the selection
    steps.push({ id: "object.compoundPath.make", params: {} });
    subpathIds.splice(0, subpathIds.length, `$${steps.length - 1}.id`);
  }

  // 2c. Uniform stroke + optional fill.
  const compRef = subpathIds[0];
  steps.push({ id: "paint.setStroke", params: { ids: [compRef], color: spec.strokeColor } });
  steps.push({ id: "stroke.set",      params: { ids: [compRef], weight: spec.strokeWidth, cap: "round", join: "round" } });
  if (spec.fillColor) steps.push({ id: "paint.setFill", params: { ids: [compRef], color: spec.fillColor } });
  else                steps.push({ id: "paint.setFill",   params: { ids: [compRef], none: true } });

  // 2d. Fill rule on the resulting compound path (attributes.info can verify later).
  if (spec.fillRule === "evenOdd") {
    steps.push({ id: "path.setFillRule", params: { rule: "evenOdd", ids: [compRef] } });
  }

  // 2e. Uniform grid-validation: any extreme anchor that drifted > 0.001 pt is logged.
  spec.subpaths.forEach((sp, spIndex) => sp.anchors.forEach(a => {
    if (a.role !== "extreme") return;
    const { drift } = gridSnap(a);
    if (drift > 0.001) warnings.push(`${spec.name}: extreme anchor '${a.id}' drift ${drift.toFixed(3)} pt`);
  }));

  return steps;
}

// ────────────────────────────────────────────────────────────────────────────
// 3. THE ICON FAMILY — twelve glyphs, specified as tokens.
// ────────────────────────────────────────────────────────────────────────────

const AUTO: HandlePolicy = { kind: "auto-tangent" };
const CORNER: HandlePolicy = { kind: "independent" };

function extreme(id: string, col: number, row: number): SpecAnchor {
  return { id, role: "extreme", grid: { col, row }, abs: null, handle: CORNER };
}
function tangent(id: string, col: number, row: number): SpecAnchor {
  return { id, role: "tangent", grid: { col, row }, abs: null, handle: AUTO, smooth: true };
}
function corner(id: string, col: number, row: number): SpecAnchor {
  return { id, role: "corner", grid: { col, row }, abs: null, handle: CORNER };
}

const STROKE = "#111827";

function icon(name: string, anchors: SpecAnchor[], options: {
  holes?: SpecAnchor[][];
  fill?: string | null;
  fillRule?: "nonZero" | "evenOdd";
} = {}): IconSpec {
  const subpaths: Subpath[] = [{ closed: true, anchors }];
  for (const hole of options.holes ?? []) subpaths.push({ closed: true, op: "subtract", anchors: hole });
  return {
    name,
    viewBox: [0, 0, 128, 128],
    strokeWidth: 8,
    strokeColor: STROKE,
    fillColor: options.fill ?? null,
    fillRule: options.fillRule ?? "nonZero",
    subpaths,
  };
}

function buildFamily(): IconSpec[] {
  const icons: IconSpec[] = [];

  icons.push(icon("wallet", [
    corner("left", 2, 6), corner("right", 14, 6), corner("right-bottom", 14, 11), corner("left-bottom", 2, 11),
  ], { holes: [[corner("pocket", 9, 8), corner("pocket-end", 12, 8), corner("pocket-end-2", 12, 9), corner("pocket-2", 9, 9)]] }));

  icons.push(icon("shield-check", [
    tangent("top", 8, 1), tangent("right", 14, 5), tangent("right-low", 12, 12),
    tangent("bottom", 8, 15), tangent("left-low", 4, 12), tangent("left", 2, 5),
  ], { holes: [[
    corner("tick-1", 6, 8), corner("tick-2", 7, 9), corner("tick-3", 10, 6), corner("tick-4", 11, 7),
  ]], fillRule: "evenOdd" }));

  icons.push(icon("arrow-trend-up", [
    corner("tail", 2, 13), corner("tail-top", 2, 12), corner("knee", 7, 7),
    corner("head", 12, 2), corner("head-top", 13, 2), corner("head-right", 13, 3),
  ]));

  icons.push(icon("bell", [
    tangent("top", 8, 2), tangent("left", 4, 6), tangent("left-bottom", 5, 11),
    tangent("right-bottom", 11, 11), tangent("right", 12, 6),
  ], { holes: [[corner("clapper", 7, 13), corner("clapper-2", 9, 13)]] }));

  icons.push(icon("chart-bars", [
    corner("base-left", 2, 14), corner("base-right", 14, 14), corner("base-right-top", 14, 12), corner("base-left-top", 2, 12),
  ], { holes: [
    [corner("bar-1", 4, 8), corner("bar-1-top", 6, 8), corner("bar-1-2", 6, 12), corner("bar-1-3", 4, 12)],
    [corner("bar-2", 8, 4), corner("bar-2-top", 10, 4), corner("bar-2-2", 10, 12), corner("bar-2-3", 8, 12)],
  ] }));

  icons.push(icon("user", [
    tangent("head-top", 8, 2), tangent("head-left", 5, 5), tangent("head-bottom", 8, 8), tangent("head-right", 11, 5),
  ], { holes: [[
    tangent("shoulder-left", 3, 13), tangent("shoulder-right", 13, 13),
  ]] }));

  icons.push(icon("search", [
    tangent("ring-top", 6, 2), tangent("ring-right", 10, 6), tangent("ring-bottom", 6, 10), tangent("ring-left", 2, 6),
  ], { holes: [[corner("handle-1", 9, 10), corner("handle-2", 13, 14), corner("handle-3", 14, 13), corner("handle-4", 10, 9)]] }));

  icons.push(icon("settings", [
    tangent("gear-top", 8, 1), tangent("gear-right", 15, 8), tangent("gear-bottom", 8, 15), tangent("gear-left", 1, 8),
  ], { holes: [[tangent("hub-top", 8, 5), tangent("hub-right", 11, 8), tangent("hub-bottom", 8, 11), tangent("hub-left", 5, 8)]] }));

  icons.push(icon("download", [
    corner("shaft-left", 6, 2), corner("shaft-right", 8, 2), corner("shaft-right-2", 8, 9),
    corner("head-right", 12, 9), corner("head-bottom", 7, 14), corner("head-left", 3, 9), corner("shaft-left-2", 6, 9),
  ]));

  icons.push(icon("lock", [
    corner("body-left", 3, 7), corner("body-right", 11, 7), corner("body-right-2", 11, 14), corner("body-left-2", 3, 14),
  ], { holes: [[
    tangent("shackle-top", 5, 6), tangent("shackle-right", 9, 6), tangent("shackle-bottom", 9, 7), tangent("shackle-left", 5, 7),
  ]], fillRule: "evenOdd" }));

  icons.push(icon("calendar", [
    corner("frame-left", 2, 3), corner("frame-right", 14, 3), corner("frame-right-2", 14, 14), corner("frame-left-2", 2, 14),
  ], { holes: [[corner("bar-top", 2, 6), corner("bar-right", 14, 6), corner("bar-right-2", 14, 7), corner("bar-left-2", 2, 7)]] }));

  icons.push(icon("home", [
    tangent("roof", 8, 2), tangent("eave-left", 2, 8), tangent("eave-right", 14, 8),
    tangent("wall-left", 4, 9), tangent("wall-bottom", 4, 14), tangent("wall-right", 12, 14), tangent("wall-2", 12, 9),
  ], { holes: [[corner("door-left", 7, 10), corner("door-right", 9, 10), corner("door-right-2", 9, 14), corner("door-left-2", 7, 14)]] }));

  return icons;
}

// ────────────────────────────────────────────────────────────────────────────
// 4. DRIVER — the batch the agent hands to the engine.
// ────────────────────────────────────────────────────────────────────────────
function emitFoundry(family: { gridUnitPt: number; familyName: string; icons: IconSpec[] }) {
  const manifestEntries: any[] = [];
  const finalSteps: BatchStep[] = [];

  for (const icon of family.icons) {
    const warnings: string[] = [];
    const iconSteps = buildIconBatch(icon, warnings);
    // The whole icon is ONE user-facing undo step: one atomic batch per icon.
    finalSteps.push(...iconSteps);

    manifestEntries.push({
      name: icon.name,
      anchorCount: icon.subpaths.reduce((n, sp) => n + sp.anchors.length, 0),
      subpathCount: icon.subpaths.length,
      fillRule: icon.fillRule,
      viewBox: icon.viewBox,
      specHash: sha256(JSON.stringify(icon)),
      warnings,
    });
  }

  // The batch the agent runs: the MCP `command_batch` tool, whose steps may
  // reference the id a previous step returned as "$N.id" (N counts from 0).
  const driver = {
    steps: finalSteps,
    atomic: true,
    label: `Icon family build — ${family.familyName}`,
  };
  writeFileSync("icon-foundry.json", JSON.stringify(driver, null, 2));
  writeFileSync("manifest.json", JSON.stringify({ icons: manifestEntries }, null, 2));
  return { driver, manifestEntries };
}

function sha256(s: string) { return createHash("sha256").update(s).digest("hex"); }

// ────────────────────────────────────────────────────────────────────────────
// 5. RUNNING THE DRIVER AGAINST THE ENGINE
// ────────────────────────────────────────────────────────────────────────────

interface EngineResult { ok: boolean; output: any; error?: string; }

/** A thin MCP client: one command, one batch. */
export class Foundry {
  private readonly client = new Client({ name: "icon-foundry", version: "1.0.0" }, { capabilities: {} });

  async connect(): Promise<void> {
    await this.client.connect(
      new StdioClientTransport({ command: "vectorcraft-cli", args: ["mcp", "--headless"] }),
    );
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async run(id: string, params: Record<string, unknown> = {}): Promise<any> {
    const result: any = await this.client.callTool({ name: "command_run", arguments: { id, params } });
    const text = result.content?.find((b: any) => b.type === "text")?.text ?? "";
    if (result.isError) throw new Error(`${id}: ${text}`);
    return text ? JSON.parse(text) : null;
  }

  /** Some answers come from meta-tools rather than engine commands. */
  async tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const result: any = await this.client.callTool({ name, arguments: args });
    const text = result.content?.find((b: any) => b.type === "text")?.text ?? "";
    if (result.isError) throw new Error(`${name}: ${text}`);
    return text ? JSON.parse(text) : null;
  }

  async batch(steps: BatchStep[], label: string): Promise<{ completed: number; failed: number; results: any[] }> {
    const result: any = await this.client.callTool({
      name: "command_batch",
      arguments: { steps, atomic: true, label },
    });
    const text = result.content?.find((b: any) => b.type === "text")?.text ?? "{}";
    const parsed = JSON.parse(text);
    if (parsed.failed > 0) {
      const failed = parsed.results.find((r: any) => !r.ok);
      throw new Error(`batch "${label}" failed at step ${parsed.results.indexOf(failed)}: ${failed?.error}`);
    }
    return parsed;
  }
}

/** Every object in the document tree, flattened. */
export function collectObjects(document: any): any[] {
  const out: any[] = [];
  const walk = (nodes: any[]) => {
    for (const node of nodes ?? []) {
      out.push(node);
      if (node.children) walk(node.children);
    }
  };
  for (const layer of document?.layers ?? []) walk(layer.children ?? []);
  return out;
}

/** The anchors of a path, or the sum over a compound path's members. */
export function countAnchors(node: any): number {
  if (typeof node.anchors === "number") return node.anchors;
  return (node.children ?? []).reduce((n: number, child: any) => n + countAnchors(child), 0);
}

/**
 * Builds the family, runs it, and writes one `.vectorcraft` file per icon
 * plus the manifest. Each icon is built in its own document so the export of
 * one icon cannot pick up the geometry of another.
 */
export async function buildIconFamily(options: {
  outDir: string;
  familyName?: string;
  gridUnitPt?: number;
}): Promise<{ manifest: any[]; files: string[] }> {
  mkdirSync(options.outDir, { recursive: true });
  const family = {
    gridUnitPt: options.gridUnitPt ?? 8,
    familyName: options.familyName ?? "fintech-core",
    icons: buildFamily(),
  };
  const { manifestEntries } = emitFoundry(family);

  const foundry = new Foundry();
  await foundry.connect();
  const files: string[] = [];
  try {
    for (const [index, icon] of family.icons.entries()) {
      await foundry.run("file.new", {
        name: icon.name,
        width: icon.viewBox[2],
        height: icon.viewBox[3],
        units: "Points",
        colorMode: "rgb",
        backgroundContents: "transparent",
      });
      const steps = buildIconBatch(icon, manifestEntries[index].warnings);
      await foundry.batch(steps, `icon ${icon.name}`);

      // Post-construction audit: the engine's own anchor list has to match
      // the specification, and the fill rule has to be the one we asked for.
      const document: any = await foundry.tool("inspect_document", {});
      const objects = collectObjects(document);
      const compound = objects.find((o) => o.kind === "Compound Path") ?? objects.find((o) => o.kind === "Path");
      const engineAnchors = compound ? countAnchors(compound) : 0;
      const specAnchors = icon.subpaths.reduce((n, sp) => n + sp.anchors.length, 0);
      if (engineAnchors !== specAnchors) {
        manifestEntries[index].warnings.push(
          `${icon.name}: engine reports ${engineAnchors} anchors, spec declares ${specAnchors}`,
        );
      }
      const attributes: any = await foundry.run("attributes.info", { ids: compound ? [compound.id] : [] });
      if (attributes?.fillRule && attributes.fillRule !== icon.fillRule) {
        manifestEntries[index].warnings.push(
          `${icon.name}: fill rule is ${attributes.fillRule}, spec declares ${icon.fillRule}`,
        );
      }

      const path = `${options.outDir}/${icon.name}.vectorcraft`;
      await foundry.run("document.export", { path, format: "vectorcraft" });
      // The SVG is a derived preview for asset review; the native archive is
      // still the source of truth and the only file returned in `files`.
      await foundry.run("document.export", {
        path: `${options.outDir}/${icon.name}.svg`,
        format: "svg",
        artboard: 0,
      });
      files.push(path);
    }
  } finally {
    await foundry.close();
  }

  writeFileSync(`${options.outDir}/manifest.json`, JSON.stringify({ icons: manifestEntries }, null, 2));
  return { manifest: manifestEntries, files };
}

// ────────────────────────────────────────────────────────────────────────────
// 6. FAILURE-MODE HANDLERS
// ────────────────────────────────────────────────────────────────────────────
// Unclosed tangent at seam (CAUGHT DURING BUILD):
//   If a closed subpath's LAST anchor is `tangent` AND the first is `corner`,
//   the seam would be C0-only (a visible kink) even though path.create accepts
//   it.  Repair policy: promote the seam anchor to smooth BEFORE construction
//   (a flag flip is cheaper than a follow-up path.setHandle round-trip), and
//   record the repair in the manifest's `warnings`.
//
//   Post-construction audit (CAPTURED VIA document.node):
//   For each compound path, read the engine's own anchor list and confirm
//   anchors == spec subpaths' total anchor count.
//   Points-of-difference are surfaced in the manifest; they are warnings,
//   not fatal, because the design team owns the spec.
//
// Extreme-anchor drift (REPORTED, NOT FATAL):
//   gridSnap returns drift; any drift > 0.001 pt on an `extreme` anchor is
//   appended to `warnings`.  No automatic re-snap — the spec author is told.

// Execute when invoked directly.
if (process.argv[1]?.endsWith("01_solutions_and_explanations.ts")) {
  const outDir = process.env.FOUNDRY_OUT ?? "./build";
  buildIconFamily({ outDir })
    .then((result) => {
      console.log(`built ${result.files.length} icons into ${outDir}`);
      for (const entry of result.manifest) {
        console.log(
          `  ${entry.name.padEnd(18)} anchors=${String(entry.anchorCount).padStart(2)} ` +
          `subpaths=${entry.subpathCount} fill=${entry.fillRule}` +
          (entry.warnings.length ? ` warnings=${entry.warnings.length}` : ""),
        );
      }
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
