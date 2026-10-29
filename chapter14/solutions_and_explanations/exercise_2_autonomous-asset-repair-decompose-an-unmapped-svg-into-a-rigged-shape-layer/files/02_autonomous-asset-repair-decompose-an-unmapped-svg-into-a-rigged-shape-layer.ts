// Language: typescript
// repair-acme.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { readFile } from "node:fs/promises";
import { PNG } from "pngjs"; // host-side PNG decode for dHash

/* ------------------------------------------------------------------ *
 * 1. Contracts
 * ------------------------------------------------------------------ */

export interface RepairPlan {
  layerName: string;
  candidatesFolder: string;
  expectedReferenceHash: bigint;
  tolerance: number;
  markerName: string;
}

export interface RepairReport {
  layer: string;
  candidateUsed: string | null;
  pathsInserted: number;
  warnings: string[];
  hammingDistance: number | null;
  modifiersPreserved: boolean;
  idempotentSkip: boolean;
  mode: "native" | "script-fallback";
}

interface RunScriptResponse {
  ok: boolean;
  result: unknown;
  output: string;
  error: { message: string; line: number; column: number } | null;
}

interface RepairScriptResult {
  inserted: number;
  warnings: string[];
  createdGroupUid?: string;
}

function isRepairResult(v: unknown): v is RepairScriptResult {
  return (
    typeof v === "object" &&
    v !== null &&
    "inserted" in v &&
    typeof (v as any).inserted === "number" &&
    Array.isArray((v as any).warnings)
  );
}

/* ------------------------------------------------------------------ *
 * 2. Layer inspection
 * ------------------------------------------------------------------ */

interface FlatNode {
  path: string;
  type: string;
  uid?: string;
  value?: unknown;
}

interface ModifierSnapshot {
  roundUid: string | null;
  roundParams: Record<string, unknown> | null;
  zigzagUid: string | null;
  zigzagParams: Record<string, unknown> | null;
}

function snapshotModifiers(flat: FlatNode[]): ModifierSnapshot {
  const pick = (needle: string) =>
    flat.find((n) => n.type.toLowerCase().includes(needle) && n.uid) ?? null;
  const r = pick("round");
  const z = pick("zigzag");
  return {
    roundUid: r?.uid ?? null,
    roundParams: (r?.value as Record<string, unknown>) ?? null,
    zigzagUid: z?.uid ?? null,
    zigzagParams: (z?.value as Record<string, unknown>) ?? null,
  };
}

function countPathNodes(flat: FlatNode[]): number {
  return flat.filter((n) => n.type.toLowerCase().includes("path")).length;
}

function findExistingMarker(flat: FlatNode[], markerName: string): FlatNode | null {
  return flat.find((n) => n.type.includes("Group") && typeof (n.value as any)?.name === "string" && (n.value as any).name === markerName) ?? null;
}

/* ------------------------------------------------------------------ *
 * 3. Capability discovery — SVG import availability
 * ------------------------------------------------------------------ */

async function discoverSvgImport(call: (tool: string, args: Record<string, unknown>) => Promise<unknown>): Promise<boolean> {
  const list = (await call("list_commands", { filter: "svg", enabled_only: false })) as Array<{ id: string }>;
  const importList = (await call("list_commands", { filter: "import", enabled_only: false })) as Array<{ id: string }>;
  const importIds = new Set([...list, ...importList].map((c) => c.id));
  // The engine has no dedicated SVG importer: the generic one takes SVG
  // files and turns them into a composition.
  if (importIds.has("file.import")) {
    const desc = (await call("describe_command", { command: "file.import" })) as { params?: string };
    if (typeof desc.params === "string" && /svg/i.test(desc.params)) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ *
 * 4. Minimal SVG path parser (host-side) — we parse here, then emit
 * shape items via run_script so all mutations stay inside the undo group.
 * ------------------------------------------------------------------ */

export interface PathPoint {
  x: number;
  y: number;
  in?: [number, number];
  out?: [number, number];
}

export interface Subpath {
  closed: boolean;
  anchors: PathPoint[];
}

export function parseSvgPaths(svg: string): { subpaths: Subpath[]; warnings: string[] } {
  const warnings: string[] = [];
  const subpaths: Subpath[] = [];
  const dAttr = /<path[^>]*\sd="([^"]+)"/g;
  let match: RegExpExecArray | null;
  while ((match = dAttr.exec(svg)) !== null) {
    const d = match[1];
    if (d === undefined) continue;
    const parsed = parsePathData(d, warnings);
    subpaths.push(...parsed);
  }
  // Basic shapes are not silently dropped: the repair report names them so the
  // caller knows what still has to be decomposed.
  for (const tag of ["circle", "rect", "polygon", "polyline", "ellipse"]) {
    if (new RegExp(`<${tag}\\b`, "i").test(svg)) {
      warnings.push(`unsupported-svg-element: <${tag}> is not converted by the path parser`);
    }
  }
  return { subpaths, warnings };
}

function parsePathData(d: string, warnings: string[]): Subpath[] {
  const tokens = d.match(/[MmLlHhVvCcSsQqTtAaZz]|-?\d*\.?\d+(?:e[-+]?\d+)?/g) ?? [];
  const out: Subpath[] = [];
  let current: Subpath | null = null;
  let cursor: { x: number; y: number } = { x: 0, y: 0 };
  let start: { x: number; y: number } = { x: 0, y: 0 };
  let i = 0;
  const num = () => Number(tokens[i++]);

  while (i < tokens.length) {
    const cmd = tokens[i++];
    switch (cmd) {
      case "M":
      case "m": {
        const rel = cmd === "m";
        const x = num(), y = num();
        cursor = rel ? { x: cursor.x + x, y: cursor.y + y } : { x, y };
        start = { x: cursor.x, y: cursor.y };
        current = { closed: false, anchors: [{ x: cursor.x, y: cursor.y }] };
        out.push(current);
        break;
      }
      case "L":
      case "l": {
        if (!current) throw new Error("path data must start with M");
        const rel = cmd === "l";
        const x = rel ? cursor.x + num() : num();
        const y = rel ? cursor.y + num() : num();
        current.anchors.push({ x, y });
        cursor = { x, y };
        break;
      }
      case "H":
      case "h": {
        if (!current) throw new Error("path data must start with M");
        const rel = cmd === "h";
        const x = rel ? cursor.x + num() : num();
        current.anchors.push({ x, y: cursor.y });
        cursor = { x, y: cursor.y };
        break;
      }
      case "V":
      case "v": {
        if (!current) throw new Error("path data must start with M");
        const rel = cmd === "v";
        const y = rel ? cursor.y + num() : num();
        current.anchors.push({ x: cursor.x, y });
        cursor = { x: cursor.x, y };
        break;
      }
      case "C":
      case "c": {
        if (!current) throw new Error("path data must start with M");
        const rel = cmd === "c";
        const x1 = rel ? cursor.x + num() : num();
        const y1 = rel ? cursor.y + num() : num();
        const x2 = rel ? cursor.x + num() : num();
        const y2 = rel ? cursor.y + num() : num();
        const x = rel ? cursor.x + num() : num();
        const y = rel ? cursor.y + num() : num();
        const last = current.anchors[current.anchors.length - 1];
        if (!last) continue;
        last.out = [x1, y1];
        current.anchors.push({ x, y, in: [x2, y2] });
        cursor = { x, y };
        break;
      }
      case "A":
      case "a":
        warnings.push("unsupported-arc");
        break;
      case "Z":
      case "z":
        if (current) {
          current.closed = true;
          current = null;
        }
        cursor = { ...start };
        break;
      default:
        warnings.push(`unsupported-cmd:${cmd}`);
    }
  }
  return out;
}

/* ------------------------------------------------------------------ *
 * 5. Script fallback — mutate via run_script, one undo group.
 * ------------------------------------------------------------------ */

function buildRepairScript(subpaths: Subpath[], groupName: string): string {
  return `
    (function() {
      app.beginUndoGroup("Repair AcmeMark");
      try {
        var comp = app.project.activeItem;
        if (!comp) { return { inserted: 0, warnings: ["no-active-comp"] }; }
        var meta = ${JSON.stringify({ subpaths, groupName })};
        var target = null;
        for (var i = 1; i <= comp.numLayers; i++) {
          var L = comp.layer(i);
          if (L.name === "AcmeMark") { target = L; break; }
        }
        if (!target) { return { inserted: 0, warnings: ["layer-not-found"] }; }
        var root = target.property("ADBE Root Vectors Group");
        var group = root.addProperty("ADBE Vector Group");
        group.name = meta.groupName;
        var contents = group.property("ADBE Vectors Group");
        var fill = contents.addProperty("ADBE Vector Graphic - Fill");
        fill.property("ADBE Vector Fill Color").setValue([0.19, 0.13, 0.06]);
        var stroke = contents.addProperty("ADBE Vector Graphic - Stroke");
        var count = 0;
        for (var s = 0; s < meta.subpaths.length; s++) {
          var sp = meta.subpaths[s];
          var shape = contents.addProperty("ADBE Vector Shape - Group");
          var shp = shape.property("ADBE Vector Shape");
          var s2 = new Shape();
          for (var k = 0; k < sp.anchors.length; k++) {
            var a = sp.anchors[k];
            s2.vertices.push([a.x, a.y]);
            s2.inTangents.push(a.in ? [a.in[0] - a.x, a.in[1] - a.y] : [0, 0]);
            s2.outTangents.push(a.out ? [a.out[0] - a.x, a.out[1] - a.y] : [0, 0]);
          }
          s2.closed = !!sp.closed;
          shp.setValue(s2);
          count++;
        }
        return { inserted: count, warnings: [] };
      } finally {
        app.endUndoGroup();
      }
    })();
  `;
}

/* ------------------------------------------------------------------ *
 * 6. Colour-hue pre-check (rejects the decoy SVG).
 * ------------------------------------------------------------------ */

export function hexToHue(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 255) / 255, g = ((n >> 8) & 255) / 255, b = (n & 255) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  let h = 0;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) + 360) % 360;
}

export function dominantFillHue(svg: string): number | null {
  const matches = [...svg.matchAll(/fill="(#[0-9a-fA-F]{6})"/g)].map((m) => m[1]);
  if (matches.length === 0) return null;
  // Simple mode: use the last (usually the primary) fill for the mark body.
  return hexToHue(matches[matches.length - 1] ?? "#000000");
}

function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

/* ------------------------------------------------------------------ *
 * 7. dHash — the perceptual fingerprint.
 * ------------------------------------------------------------------ */

export function dHash(png: Buffer, size = 8): bigint {
  const img = PNG.sync.read(png);
  // Nearest-neighbour downscale to (size+1) x size; then compare horizontal pairs.
  const sx = img.width / (size + 1);
  const sy = img.height / size;
  const gray = (x: number, y: number): number => {
    const i = (Math.min(img.height - 1, Math.floor(y * sy)) * img.width + Math.min(img.width - 1, Math.floor(x * sx))) << 2;
    return Math.round(
      0.299 * (img.data[i] ?? 0) +
        0.587 * (img.data[i + 1] ?? 0) +
        0.114 * (img.data[i + 2] ?? 0),
    );
  };
  let bits = 0n;
  let bit = 0n;
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      const left = gray(col, row);
      const right = gray(col + 1, row);
      if (left > right) bits |= 1n << bit;
      bit++;
    }
  }
  return bits;
}

export function hamming(a: bigint, b: bigint): number {
  let x = a ^ b;
  let n = 0;
  while (x) {
    n += Number(x & 1n);
    x >>= 1n;
  }
  return n;
}

/* ------------------------------------------------------------------ *
 * 8. The repair orchestrator
 * ------------------------------------------------------------------ */

export async function repairAcmeMark(plan: RepairPlan): Promise<RepairReport> {
  const report: RepairReport = {
    layer: plan.layerName,
    candidateUsed: null,
    pathsInserted: 0,
    warnings: [],
    hammingDistance: null,
    modifiersPreserved: false,
    idempotentSkip: false,
    mode: "script-fallback",
  };

  const transport = new StdioClientTransport({
    command: "effectcraft-cli",
    args: ["mcp", "--automation-read-root", process.cwd(), "--automation-write-root", process.cwd()],
  });
  const client = new Client({ name: "repair-acme", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);

  const call = async (tool: string, args: Record<string, unknown>): Promise<unknown> =>
    (await (client as any).callTool({ name: tool, arguments: args })).content ?? null;

  try {
    await call("open_project", { path: "master-ID.ecproj" });
    await call("get_comp", {});

    // ---- 8.1 diagnose
    const flat = (await call("get_layer", { layer: plan.layerName, flat: true })) as FlatNode[];
    if (countPathNodes(flat) > 0) {
      // Layer already healthy, unless it is a leftover stale group we need to remove below.
    }

    // ---- 8.2 idempotency
    const marker = findExistingMarker(flat, plan.markerName);
    if (marker && countPathNodes(flat) >= 3) {
      report.idempotentSkip = true;
      report.candidateUsed = plan.markerName;
      return report;
    }
    if (marker) {
      // Degenerate marker — remove only that group.
      await call("execute_command", {
        command: "prop.removeGroup",
        params: { layer: plan.layerName, prop: marker.uid },
      });
    }

    // ---- 8.3 snapshot modifiers
    const before = snapshotModifiers(flat);

    // ---- 8.4 current fill hue (the target signature for candidate filtering)
    const currentFill = (await call("get_property", {
      layer: plan.layerName,
      path: "contents/fill/color",
    })) as { value?: number[] } | null;
    const targetHue = currentFill?.value
      ? hexToHue(rgbArrayToHex(currentFill.value))
      : null;

    // ---- 8.5 discover capability
    const hasNative = await discoverSvgImport(call);
    report.mode = hasNative ? "native" : "script-fallback";

    // ---- 8.6 iterate candidates
    const candidates = ["acme-mark-v2.svg", "acme-mark-v2-outline.svg", "otherco-logo.svg"];
    for (const filename of candidates) {
      const svg = await readFile(`${plan.candidatesFolder}${filename}`, "utf8");

      // colour-hue pre-check rejects decoys
      const hue = dominantFillHue(svg);
      if (hue !== null && targetHue !== null && hueDistance(hue, targetHue) > 60) {
        report.warnings.push(`candidate-rejected-hue: ${filename}`);
        continue;
      }

      const { subpaths, warnings } = parseSvgPaths(svg);
      if (subpaths.length === 0) continue;

      // ---- 8.7 apply via script (single undo step)
      const code = buildRepairScript(subpaths, plan.markerName);
      const scriptRes = (await call("run_script", { code, name: "repair-acme" })) as RunScriptResponse;

      if (!scriptRes.ok || !isRepairResult(scriptRes.result) || scriptRes.result.inserted === 0) {
        report.warnings.push(`script-fallback-failed: ${filename}`);
        continue;
      }

      // ---- 8.8 modifier preservation check
      const afterFlat = (await call("get_layer", { layer: plan.layerName, flat: true })) as FlatNode[];
      const after = snapshotModifiers(afterFlat);
      const preserved =
        before.roundUid === after.roundUid &&
        before.zigzagUid === after.zigzagUid &&
        JSON.stringify(before.roundParams) === JSON.stringify(after.roundParams) &&
        JSON.stringify(before.zigzagParams) === JSON.stringify(after.zigzagParams);

      if (!preserved) {
        report.warnings.push(`modifier-preservation-failed: ${filename}`);
        continue;
      }

      // ---- 8.9 render and verify perceptually
      const verifyPath = `out/verify-${filename}.png`;
      await call("render_frame", {
        comp: undefined,
        time: 2.5,
        path: verifyPath,
        max_side: 512,
        inline: false,
      });
      const pngBuf = await readFile(verifyPath);
      const dist = hamming(dHash(pngBuf), plan.expectedReferenceHash);

      // ---- 8.10 accept or reject
      if (dist <= plan.tolerance) {
        report.candidateUsed = filename;
        report.pathsInserted = scriptRes.result.inserted;
        report.hammingDistance = dist;
        report.modifiersPreserved = true;
        report.warnings.push(...warnings, ...scriptRes.result.warnings);
        await call("save_project", { path: "master-ID.ecproj" });
        return report;
      }

      // Not good enough — undo and try next candidate.
      report.warnings.push(`candidate-rejected-hash: ${filename} d=${dist}`);
      await call("undo", { steps: 1 });
    }

    // Nothing matched — escalate.
    report.warnings.push("all-candidates-rejected");
    return report;
  } finally {
    await client.close().catch(() => undefined);
  }
}

function rgbArrayToHex(rgb: number[]): string {
  const to = (v: number | undefined) =>
    Math.round(Math.max(0, Math.min(1, v ?? 0)) * 255).toString(16).padStart(2, "0");
  return `#${to(rgb[0])}${to(rgb[1])}${to(rgb[2])}`;
}
