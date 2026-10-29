import { createHash } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

type Op = "unite" | "minusFront" | "intersect" | "exclude" | "minusBack";
type Leaf = { leaf: string };
type Interior = { op: Op; nonDestructive?: boolean; children: Node[] };
type Node = Leaf | Interior;

type TierName = "xl" | "md" | "sm";
interface TierSpec { tier: TierName; canvasPt: number; }

interface TierDiff {
  tier: string; booleanOpsApplied: number; liveOpsRetained: number;
  finalPathCount: number; fillRule: "nonZero" | "evenOdd";
  selfIntersections: number; warnings: string[]; contentHash: string;
}

interface BatchStep { id: string; params: Record<string, unknown>; }

// Live effect ids supported by VectorCraft's `effect.apply` catalogue.
const LIVE_EFFECT: Record<Op, string | null> = {
  unite:      "pathfinder.add",
  minusFront: "pathfinder.subtract",
  intersect:  "pathfinder.intersect",
  exclude:    "pathfinder.exclude",
  minusBack:  null,   // no live equivalent — must be destructive
};

// Safe-only destructive operations.
const DESTRUCTIVE: Record<Op, string> = {
  unite:      "object.pathfinder.unite",
  minusFront: "object.pathfinder.minusFront",
  intersect:  "object.pathfinder.intersect",
  exclude:    "object.pathfinder.exclude",
  minusBack:  "object.pathfinder.minusBack",
};

// ────────────────────────────────────────────────────────────────────────────
// 1. FLATTEN-SAFETY — refuse destructive ops when any ancestor is live.
// ────────────────────────────────────────────────────────────────────────────
function hasLiveAncestor(path: Node[], ancestors: (Interior | null)[]): boolean {
  return ancestors.some(a => a !== null && a.nonDestructive === true);
}

function classifyNode(node: Interior, ancestors: (Interior | null)[], warnings: string[]) {
  const live = node.nonDestructive === true;
  if (live && LIVE_EFFECT[node.op] === null) {
    warnings.push(`op ${node.op} cannot be a live effect; falling back to destructive`);
    return { live: false };
  }
  if (!live && hasLiveAncestor([], ancestors)) {
    warnings.push(`refusing to flatten ${node.op} because a live ancestor exists`);
    return { live: true };   // escalate to live, don't flatten
  }
  return { live };
}

// ────────────────────────────────────────────────────────────────────────────
// 2. LEAF GEOMETRY — the three sources the Boolean tree talks about.
//    A path spec is a list of closed subpaths in points, relative to the
//    centre of the canvas.
// ────────────────────────────────────────────────────────────────────────────
interface PathSpec { name: string; subpaths: { x: number; y: number }[][]; }

const LEAF_SPECS: PathSpec[] = [
  {
    // The caduceus: a vertical stem with two wings.
    name: "caduceus",
    subpaths: [
      [{ x: -6, y: -60 }, { x: 6, y: -60 }, { x: 6, y: 60 }, { x: -6, y: 60 }],
      [{ x: -6, y: -20 }, { x: -44, y: -34 }, { x: -44, y: -12 }, { x: -6, y: -6 }],
      [{ x: 6, y: -20 }, { x: 44, y: -34 }, { x: 44, y: -12 }, { x: 6, y: -6 }],
    ],
  },
  {
    // The shield: a five-sided plate.
    name: "shield",
    subpaths: [
      [
        { x: 0, y: -58 }, { x: 46, y: -34 }, { x: 46, y: 14 },
        { x: 0, y: 58 }, { x: -46, y: 14 }, { x: -46, y: -34 },
      ],
    ],
  },
  {
    // The letter H.
    name: "h",
    subpaths: [
      [{ x: -40, y: -50 }, { x: -16, y: -50 }, { x: -16, y: 50 }, { x: -40, y: 50 }],
      [{ x: 16, y: -50 }, { x: 40, y: -50 }, { x: 40, y: 50 }, { x: 16, y: 50 }],
      [{ x: -16, y: -6 }, { x: 16, y: -6 }, { x: 16, y: 10 }, { x: -16, y: 10 }],
    ],
  },
];

// ────────────────────────────────────────────────────────────────────────────
// 3. BATCH BUILDER — walks the tree, emits $N-threaded steps.
//
// The MCP `command_batch` tool counts steps from zero, so the reference to
// the result of step N is "$N.id" for a creation command and "$N.ids[0]" for
// a boolean, which answers with a list of ids.
// ────────────────────────────────────────────────────────────────────────────
class BatchBuilder {
  steps: BatchStep[] = [];
  opCounter = { boolean: 0, live: 0 };
  warnings: string[] = [];

  /** The reference to the object the last emitted step produced. */
  lastRef(): string { return `$${this.steps.length - 1}.id`; }

  emit(id: string, params: Record<string, unknown>): void {
    this.steps.push({ id, params });
  }

  /** Recursively emits a node, returns a $N ref to the resulting object. */
  walk(node: Node, ancestors: (Interior | null)[], leaves: Record<string, string>): string | null {
    if ("leaf" in node) return leaves[node.leaf] ?? null;
    const classification = classifyNode(node, ancestors, this.warnings);
    // Children first (destructive ops consume the selection back-to-front).
    // A child that the simplification pass dropped comes back as null and is
    // skipped: with one operand left there is nothing to intersect, so the
    // node collapses to that operand.
    const childRefs = node.children
      .map(c => this.walk(c, [...ancestors, node], leaves))
      .filter((ref): ref is string => ref !== null);
    if (childRefs.length === 0) return null;
    if (childRefs.length === 1) return childRefs[0];

    if (classification.live) {
      // Group the children, then apply the live effect on the group.
      this.emit("select.set", { ids: childRefs });
      this.emit("object.group", {});
      const groupRef = this.lastRef();
      this.emit("effect.apply", { effect: LIVE_EFFECT[node.op], ids: [groupRef], params: {} });
      this.opCounter.live++;
      return groupRef;
    }
    // Destructive path.
    this.emit("select.set", { ids: childRefs });
    this.emit(DESTRUCTIVE[node.op], {});
    this.opCounter.boolean++;
    // The boolean consumed its operands and answered with a new id.
    return `$${this.steps.length - 1}.ids[0]`;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 4. TIER PIPELINE — one atomic batch per tier.
// ────────────────────────────────────────────────────────────────────────────
function leafSteps(specs: PathSpec[], centre: { x: number; y: number }, scale: number): {
  steps: BatchStep[];
  leaves: Record<string, string>;
} {
  const steps: BatchStep[] = [];
  const leaves: Record<string, string> = {};

  for (const spec of specs) {
    const ids: string[] = [];
    for (const subpath of spec.subpaths) {
      steps.push({
        id: "path.create",
        params: {
          anchors: subpath.map((p) => ({ x: centre.x + p.x * scale, y: centre.y + p.y * scale })),
          closed: true,
        },
      });
      ids.push(`$${steps.length - 1}.id`);
    }
    if (ids.length > 1) {
      steps.push({ id: "select.set", params: { ids: [...ids] } });
      steps.push({ id: "object.compoundPath.make", params: {} });
      ids.splice(0, ids.length, `$${steps.length - 1}.id`);
    }
    leaves[spec.name] = ids[0];
  }
  return { steps, leaves };
}

export function buildTier(
  tree: Node,
  tier: string,
  simplify: any,
  centre: { x: number; y: number },
  scale: number,
): { steps: BatchStep[]; builder: BatchBuilder } {
  const b = new BatchBuilder();
  const specs = LEAF_SPECS.filter((spec) => {
    // The sm tier drops the caduceus subtree outright.
    if (tier === "sm" && simplify?.dropSubtree?.includes(spec.name)) return false;
    return true;
  });

  // 4a. Materialise the leaves.
  const { steps: leafStepsList, leaves } = leafSteps(specs, centre, scale);
  for (const step of leafStepsList) b.emit(step.id, step.params);

  // 4b. sm-tier simplifications that replace a leaf with a primitive.
  if (tier === "sm" && simplify?.replaceLeaf?.shield) {
    // The replacement primitive is fitted to the shield's own bounds, so the
    // small tier keeps the silhouette's footprint.
    const shield = LEAF_SPECS.find((spec) => spec.name === "shield")!;
    const xs = shield.subpaths[0].map((p) => p.x);
    const ys = shield.subpaths[0].map((p) => p.y);
    const minX = Math.min(...xs);
    const minY = Math.min(...ys);
    b.emit("shape.ellipse", {
      x: centre.x + minX * scale,
      y: centre.y + minY * scale,
      width: (Math.max(...xs) - minX) * scale,
      height: (Math.max(...ys) - minY) * scale,
    });
    leaves.shield = b.lastRef();
  }

  // 4c. Walk the tree with $N threading.
  let result = b.walk(tree, [], leaves);
  if (result === null) {
    b.warnings.push(`tier ${tier}: the tree has no leaves left after simplification`);
    return { steps: b.steps, builder: b };
  }

  // 4d. sm-tier clip: intersect the H with the clipping rectangle.
  if (tier === "sm" && simplify?.clipLeaf?.h) {
    const r = simplify.clipLeaf.h.rectPt;   // [x, y, w, h] in leaf coordinates
    b.emit("shape.rectangle", {
      x: centre.x + r[0] * scale,
      y: centre.y + r[1] * scale,
      width: r[2] * scale,
      height: r[3] * scale,
    });
    const rectRef = b.lastRef();
    b.emit("select.set", { ids: [result, rectRef] });
    b.emit("object.pathfinder.intersect", {});
    b.opCounter.boolean++;
    // A destructive boolean consumes its operands and answers with a new id.
    result = `$${b.steps.length - 1}.ids[0]`;
  }

  // 4e. Group under "logo-<tier>" and tag for inspection.
  b.emit("select.set", { ids: [result] });
  b.emit("object.group", {});
  b.emit("object.setProps", { ids: [b.lastRef()], name: `logo-${tier}` });
  return { steps: b.steps, builder: b };
}

// ────────────────────────────────────────────────────────────────────────────
// 5. THE ENGINE — one MCP session, one atomic batch per tier.
// ────────────────────────────────────────────────────────────────────────────
export class CompositionAgent {
  private readonly client = new Client({ name: "logo-composition", version: "1.0.0" }, { capabilities: {} });

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

  async tool(name: string, args: Record<string, unknown> = {}): Promise<any> {
    const result: any = await this.client.callTool({ name, arguments: args });
    const text = result.content?.find((b: any) => b.type === "text")?.text ?? "";
    if (result.isError) throw new Error(`${name}: ${text}`);
    return text ? JSON.parse(text) : null;
  }

  async batch(steps: BatchStep[], label: string): Promise<any> {
    const result: any = await this.client.callTool({
      name: "command_batch",
      arguments: { steps, atomic: true, label },
    });
    const text = result.content?.find((b: any) => b.type === "text")?.text ?? "{}";
    const parsed = JSON.parse(text);
    if (parsed.failed > 0) {
      const failed = parsed.results.find((r: any) => !r.ok);
      throw new Error(`batch "${label}" failed: ${failed?.error}`);
    }
    return parsed;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// 6. GEOMETRY READ-BACK — the diff report.
// ────────────────────────────────────────────────────────────────────────────
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

/** A stable fingerprint of the tier's geometry. */
export function contentHash(objects: any[]): string {
  const canonical = objects
    .filter((o) => typeof o.anchors === "number")
    .map((o) => `${o.id}:${o.kind}:${o.anchors}:${o.bounds?.x},${o.bounds?.y},${o.bounds?.width},${o.bounds?.height}`)
    .sort()
    .join("|");
  return createHash("sha256").update(canonical).digest("hex");
}

/** Segment intersection test, used for the self-intersection counter. */
function segmentsCross(
  a: [number, number], b: [number, number], c: [number, number], d: [number, number],
): boolean {
  const orient = (p: [number, number], q: [number, number], r: [number, number]) =>
    (q[1] - p[1]) * (r[0] - q[0]) - (q[0] - p[0]) * (r[1] - q[1]);
  const on = (p: [number, number], q: [number, number], r: [number, number]) =>
    orient(p, q, r) === 0 &&
    Math.min(p[0], r[0]) <= q[0] && q[0] <= Math.max(p[0], r[0]) &&
    Math.min(p[1], r[1]) <= q[1] && q[1] <= Math.max(p[1], r[1]);
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
  return on(a, c, d) || on(b, c, d) || on(c, a, b) || on(d, a, b);
}

/** Count the self-intersections of a flattened outline. */
export function countSelfIntersections(points: [number, number][]): number {
  let crossings = 0;
  const n = points.length;
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 2; j < n; j += 1) {
      if (i === 0 && j === n - 1) continue;     // adjacent through the seam
      if (segmentsCross(points[i], points[(i + 1) % n], points[j], points[(j + 1) % n])) crossings += 1;
    }
  }
  return crossings;
}

/** The corners of the first path in a node, for quick geometry checks. */
export function anchorsOf(node: any): [number, number][] {
  return subpathsOf(node).flat();
}

/** Every object below a group in the inspection tree. */
export function descendants(node: any): any[] {
  const out: any[] = [];
  for (const child of node?.children ?? []) {
    out.push(child);
    out.push(...descendants(child));
  }
  return out;
}

/** The closed loops of the tier's outline, read back from the engine. */
export function subpathsOf(node: any): [number, number][][] {
  const loops: [number, number][][] = [];
  const collect = (n: any) => {
    if (!n) return;
    for (const subpath of n.kind?.path?.subpaths ?? []) {
      const loop: [number, number][] = [];
      for (const anchor of subpath.anchors ?? []) {
        const p = anchor.p ?? [anchor.x, anchor.y];
        loop.push([p[0], p[1]]);
      }
      if (loop.length > 2) loops.push(loop);
    }
    for (const child of n.kind?.children ?? []) collect(child);
  };
  collect(node);
  return loops;
}

/** The live effects still attached to a tier: the tier's own group plus the
 * groups the Boolean tree created inside it. */
async function countLiveEffects(agent: CompositionAgent, group: any): Promise<number> {
  if (!group) return 0;
  let total = 0;
  for (const node of [group, ...descendants(group).filter((o) => o.kind === "Group")]) {
    const detail = await agent.run("document.node", { id: node.id });
    total += detail?.appearance?.effects?.length ?? 0;
  }
  return total;
}

async function computeTierDiff(
  agent: CompositionAgent,
  tier: string,
  builder: BatchBuilder,
  warnings: string[],
): Promise<TierDiff> {
  const document = await agent.tool("inspect_document", {});
  const objects = collectObjects(document);
  const group = objects.find((o) => o.name === `logo-${tier}`);
  const members = group ? descendants(group).filter((o) => o.kind === "Path" || o.kind === "Compound Path") : [];

  const fillRules = members.length
    ? (await agent.run("attributes.info", { ids: members.map((o) => o.id) }))?.fillRule ?? "nonZero"
    : "nonZero";

  // A live Pathfinder effect lives on a group's appearance; the inspection
  // tree does not carry it, the node does. The tier group holds the groups
  // the Boolean tree built, so every one of them is asked.
  const liveOps = await countLiveEffects(agent, group);
  const loops = group ? subpathsOf(await agent.run("document.node", { id: group.id })) : [];
  const selfIntersections = loops.reduce((n, loop) => n + countSelfIntersections(loop), 0);

  return {
    tier,
    booleanOpsApplied: builder.opCounter.boolean,
    liveOpsRetained: liveOps,
    finalPathCount: members.length,
    fillRule: fillRules === "evenOdd" ? "evenOdd" : "nonZero",
    selfIntersections,
    warnings: [...warnings, ...builder.warnings],
    contentHash: contentHash(objects),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// 7. THE PIPELINE — one document, one batch and one file per tier.
// ────────────────────────────────────────────────────────────────────────────
export interface CompositionSpec {
  logoName: string;
  /** The tiers, either as names or as objects carrying the canvas size. */
  tiers: (TierName | TierSpec)[];
  tree: Node;
  simplification?: Record<string, any>;
}

/** The canvas of each tier, in points. */
export const TIER_CANVAS: Record<TierName, number> = { xl: 512, md: 128, sm: 32 };

export function tierName(tier: TierName | TierSpec): TierName {
  return typeof tier === "string" ? tier : tier.tier;
}

export function tierCanvas(tier: TierName | TierSpec): number {
  return typeof tier === "string" ? TIER_CANVAS[tier] : tier.canvasPt;
}

export async function composeLogo(
  spec: CompositionSpec,
  outDir: string,
): Promise<{ diffs: TierDiff[]; files: string[] }> {
  mkdirSync(outDir, { recursive: true });
  const agent = new CompositionAgent();
  await agent.connect();
  const diffs: TierDiff[] = [];
  const files: string[] = [];
  try {
    for (const tierSpec of spec.tiers) {
      const tier = tierName(tierSpec);
      const canvas = tierCanvas(tierSpec);
      const centre = { x: canvas / 2, y: canvas / 2 };
      const scale = canvas / 320;

      await agent.run("file.new", {
        name: `${spec.logoName}-${tier}`,
        width: canvas,
        height: canvas,
        units: "Points",
        colorMode: "rgb",
        backgroundContents: "transparent",
      });

      const { steps, builder } = buildTier(
        spec.tree,
        tier,
        spec.simplification?.[tier],
        centre,
        scale,
      );
      await agent.batch(steps, `logo-tier-${tier}`);

      const path = `${outDir}/${spec.logoName}-${tier}.vectorcraft`;
      await agent.run("document.export", { path, format: "vectorcraft" });
      // An SVG beside the native archive makes the tier inspectable without
      // opening VectorCraft; it is a derived artefact, not a second source.
      await agent.run("document.export", {
        path: `${outDir}/${spec.logoName}-${tier}.svg`,
        format: "svg",
        artboard: 0,
      });
      files.push(path);

      diffs.push(await computeTierDiff(agent, tier, builder, []));
    }
  } finally {
    await agent.close();
  }

  writeFileSync(`${outDir}/diff.json`, JSON.stringify({ logo: spec.logoName, tiers: diffs }, null, 2));
  return { diffs, files };
}

// Execute when invoked directly.
if (process.argv[1]?.endsWith("03_typescript.ts")) {
  const spec = JSON.parse(readFileSync("01_json.json", "utf8")) as CompositionSpec;
  const outDir = process.env.COMPOSITION_OUT ?? "./build";
  composeLogo(spec, outDir)
    .then((result) => {
      console.log(`composed ${result.files.length} tiers into ${outDir}`);
      for (const diff of result.diffs) {
        console.log(
          `  ${diff.tier.padEnd(4)} booleans=${diff.booleanOpsApplied} live=${diff.liveOpsRetained} ` +
          `paths=${diff.finalPathCount} fill=${diff.fillRule} selfX=${diff.selfIntersections}`,
        );
      }
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
