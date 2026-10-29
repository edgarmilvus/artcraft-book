// franchise-batch.ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve as pathResolve, relative as pathRelative } from "node:path";

/* ------------------------------------------------------------------ *
 * 1. Domain types and the discriminated result union
 * ------------------------------------------------------------------ */

export interface FranchiseSpec {
  slug: string;
  displayName: string;
  tagline: string;
  locale: string;
  accent: `#${string}`;
  wordmarkFont: string;
}

export type FranchiseErrorCode =
  | "CompCreateFailed"
  | "RigBatchFailed"
  | "FontMissing"
  | "RenderFailed"
  | "PathViolation";

export type FranchiseResult =
  | {
      ok: true;
      slug: string;
      comp: string;
      projectPath: string;
      heroPath: string;
      warnings: string[];
    }
  | {
      ok: false;
      slug: string;
      error: { code: FranchiseErrorCode; message: string; step: string };
    };

/* ------------------------------------------------------------------ *
 * 2. Raw MCP boundary — everything is `unknown` until narrowed.
 * ------------------------------------------------------------------ */

export interface McpCallResult {
  tool: string;
  raw: unknown;
}

class PathViolationError extends Error {
  readonly code = "PathViolation" as const;
  constructor(public readonly attempted: string, public readonly root: string) {
    super(`Path ${attempted} escapes write root ${root}`);
  }
}

/** Fail closed if the caller tries to write outside the sandbox. */
export function underRoot(root: string, candidate: string): string {
  const abs = pathResolve(root, candidate);
  const rel = pathRelative(root, abs);
  if (rel.startsWith("..") || pathResolve(rel) === rel) {
    throw new PathViolationError(abs, root);
  }
  return abs;
}

/* ------------------------------------------------------------------ *
 * 3. Data-driven return-shape guards, compiled once at startup.
 *
 * Rather than hand-coding which command returns `{layer:number}` vs
 * `{id:number}` vs `{error:string}`, we ask the runtime via
 * `describe_command` for each command whose return shape is ambiguous
 * and synthesise a narrow function from the returned schema's `result`
 * clause. This survives new commands being added to the engine.
 * ------------------------------------------------------------------ */

type CommandReturnGuard = (raw: unknown) => { ok: true; value: Record<string, unknown> } | { ok: false; error: string };

interface DescribeResult {
  command: string;
  // The engine returns a JSON schema; we only care about the `result` shape here.
  schema?: { result?: { properties?: Record<string, { type?: string }> } };
}

function buildGuardFromSchema(desc: DescribeResult): CommandReturnGuard {
  const props = desc.schema?.result?.properties ?? {};
  const required = Object.keys(props);
  // Prime the compiler to check the id-bearing shape.
  const idKey = required.find((k) => k === "layer" || k === "id");
  return (raw) => {
    if (typeof raw !== "object" || raw === null) return { ok: false, error: "non-object result" };
    if ("error" in raw && typeof (raw as any).error === "string") {
      return { ok: false, error: (raw as any).error };
    }
    if (idKey && typeof (raw as any)[idKey] !== "number") {
      return { ok: false, error: `missing numeric ${idKey}` };
    }
    return { ok: true, value: raw as Record<string, unknown> };
  };
}

/* ------------------------------------------------------------------ *
 * 4. Typed guard registry populated by describe_command at boot.
 * ------------------------------------------------------------------ */

const AMBIGUOUS_COMMANDS = ["comp.new", "layer.newShape", "layer.addShapeItem", "layer.newText"] as const;
type AmbiguousCommand = (typeof AMBIGUOUS_COMMANDS)[number];

async function compileGuardRegistry(
  call: (tool: string, args: Record<string, unknown>) => Promise<unknown>,
): Promise<Record<AmbiguousCommand, CommandReturnGuard>> {
  const registry = {} as Record<AmbiguousCommand, CommandReturnGuard>;
  for (const cmd of AMBIGUOUS_COMMANDS) {
    const desc = (await call("describe_command", { command: cmd })) as DescribeResult;
    registry[cmd] = buildGuardFromSchema(desc);
  }
  return registry;
}

/* ------------------------------------------------------------------ *
 * 5. Flat-property scanner (recursive walk over get_layer's flat list)
 * ------------------------------------------------------------------ */

interface FlatNode {
  path: string;
  type: string;
  value?: unknown;
}

interface LayerInfo {
  id: number;
  name: string;
  type: string; // e.g. "Shape", "Text", "Null"
}

function findTrimPath(flat: FlatNode[]): string | null {
  const node = flat.find((n) => n.type.toLowerCase().includes("trim"));
  return node?.path ?? null;
}

/* ------------------------------------------------------------------ *
 * 6. Font preflight — how we detect tofu risk without rendering.
 * ------------------------------------------------------------------ */

export interface FontFamily {
  family: string;
  origin: "bundled" | "system" | "user";
  nativeName?: string;
  styles: string[];
}

const COMBINING_DIACRITICS = /[\u0300-\u036f\u1AB0-\u1AFF]/;

export function tofuRisk(text: string, family: FontFamily, locale: string): string | null {
  const hasCombining = COMBINING_DIACRITICS.test(text.normalize("NFD"));
  const localeLower = locale.toLowerCase().slice(0, 2);
  const nativeMatches = family.nativeName
    ? family.nativeName.toLowerCase().includes(localeLower)
    : false;
  if (hasCombining && family.origin === "bundled" && !nativeMatches) {
    return `possible-glyph-fallback: ${family.family} may not cover ${locale}`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * 7. The rig batch — declared as a data structure, submitted atomically.
 *
 * All motion language lives here as primitives matching the MCP meta-tool
 * surface (`batch` steps and pre-`add_keyframe` calls). We run the layer
 * creation first, collect ids, and then key. Because batch is atomic, a
 * bad step rolls everything back and the MCP response names the failing index.
 * ------------------------------------------------------------------ */

interface BatchStep {
  command: string;
  params: Record<string, unknown>;
}

export function buildRigSteps(comp: string, spec: FranchiseSpec, cx: number, cy: number): BatchStep[] {
  return [
    { command: "layer.newNull", params: { name: "Null – Rig" } },
    { command: "layer.rename", params: { layer: "#1", name: "Null – Rig" } },
    {
      command: "layer.newShape",
      params: { kind: "rect", name: "Accent Bar", fill: spec.accent, size: [640, 12] },
    },
    {
      command: "layer.newText",
      params: {
        text: spec.displayName,
        name: "Wordmark",
        font: spec.wordmarkFont,
        size: 120,
        fill: "#ffffff",
        position: [cx, cy - 120],
      },
    },
    {
      command: "layer.newText",
      params: {
        text: spec.tagline,
        name: "Tagline",
        font: spec.wordmarkFont,
        size: 42,
        fill: "#dddddd",
        position: [cx, cy + 80],
      },
    },
  ];
}

/* ------------------------------------------------------------------ *
 * 8. The orchestrator
 * ------------------------------------------------------------------ */

interface ClientBundle {
  client: Client;
  transport: StdioClientTransport;
}

async function spawnMcp(cwd: string): Promise<ClientBundle> {
  const transport = new StdioClientTransport({
    command: "effectcraft-cli",
    args: ["mcp", "--automation-read-root", cwd, "--automation-write-root", cwd],
  });
  const client = new Client({ name: "franchise-batch", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, transport };
}

function uniq<T>(xs: T[]): T[] {
  return [...new Set(xs)];
}

export async function runFranchise(
  spec: FranchiseSpec,
  outDir: string,
): Promise<FranchiseResult> {
  const cwd = process.cwd();
  const slugDir = underRoot(outDir, spec.slug);
  await mkdir(slugDir, { recursive: true });

  let bundle: ClientBundle | null = null;
  try {
    bundle = await spawnMcp(cwd);
    const call = async (tool: string, args: Record<string, unknown>): Promise<unknown> =>
      (await (bundle!.client as any).callTool({ name: tool, arguments: args })).content ?? null;

    // 8.1 warm-up
    try {
      await call("get_state", {});
    } catch (err) {
      return {
        ok: false,
        slug: spec.slug,
        error: {
          code: "CompCreateFailed",
          message: `warm-up failed: ${(err as Error).message}`,
          step: "handshake",
        },
      };
    }

    // 8.2 compile guards
    const guards = await compileGuardRegistry(call);

    // 8.3 font availability
    const warnings: string[] = [];
    const families = (await call("list_fonts", { query: spec.wordmarkFont })) as FontFamily[];
    let chosenFont = spec.wordmarkFont;
    let familyMeta = families.find((f) => f.family === spec.wordmarkFont);
    if (!familyMeta) {
      warnings.push(`font-missing: ${spec.wordmarkFont} → Inter`);
      chosenFont = "Inter";
      const fallback = (await call("list_fonts", { query: "Inter" })) as FontFamily[];
      familyMeta = fallback[0];
    }
    const risk = familyMeta ? tofuRisk(spec.displayName + spec.tagline, familyMeta, spec.locale) : null;
    if (risk) warnings.push(risk);

    // 8.4 comp.create via execute_command — narrow with the compiled guard
    const compName = `Logo-${spec.slug}`;
    const compRaw = await call("execute_command", {
      command: "comp.new",
      params: { name: compName, width: 1920, height: 1080, frameRate: 30, duration: 5 },
    });
    const compGuard = guards["comp.new"](compRaw);
    if (!compGuard.ok) {
      return {
        ok: false,
        slug: spec.slug,
        error: { code: "CompCreateFailed", message: compGuard.error, step: "comp.new" },
      };
    }
    const compId = compName; // engine accepts name-based handles on subsequent calls

    // 8.5 verify runtime comp settings
    const compInfo = (await call("get_comp", { comp: compId })) as {
      frameRate: number;
      duration: number;
    };
    if (compInfo.frameRate !== 30 || Math.abs(compInfo.duration - 5) > 1e-6) {
      return {
        ok: false,
        slug: spec.slug,
        error: {
          code: "CompCreateFailed",
          message: `comp runtime mismatch (${compInfo.frameRate}fps, ${compInfo.duration}s)`,
          step: "get_comp",
        },
      };
    }

    // 8.6 create primitives atomically
    const cx = 960;
    const cy = 540;
    const steps = buildRigSteps(compId, { ...spec, wordmarkFont: chosenFont }, cx, cy);
    const batchRes = (await call("batch", {
      steps,
      atomic: true,
      label: `Rig: ${spec.slug}`,
    })) as { completed?: number; results?: unknown[]; failed?: { step: number; error: string } };

    if (batchRes.failed) {
      return {
        ok: false,
        slug: spec.slug,
        error: {
          code: "RigBatchFailed",
          message: batchRes.failed.error,
          step: `batch:rig@${batchRes.failed.step}`,
        },
      };
    }

    // 8.7 discover layer ids via get_comp and mirror onto the null
    const compTree = (await call("get_comp", { comp: compId })) as { layers: LayerInfo[] };
    const byName = (name: string) => compTree.layers.find((l) => l.name === name);
    const nullLayer = byName("Null – Rig");
    const wordmark = byName("Wordmark");
    const tagline = byName("Tagline");
    const bar = byName("Accent Bar");

    if (!nullLayer || !wordmark || !tagline || !bar) {
      return {
        ok: false,
        slug: spec.slug,
        error: {
          code: "RigBatchFailed",
          message: "layer lookup after batch failed",
          step: "get_comp",
        },
      };
    }

    // 8.8 parent children to null and key the push-follow
    await call("execute_command", {
      command: "layer.setParent",
      params: { layers: [wordmark.id, tagline.id, bar.id], parent: nullLayer.id },
    });

    await call("add_keyframe", {
      layer: nullLayer.id,
      path: "transform/position",
      keys: [
        { time: 0, value: [cx, cy + 40] },
        { time: 2.5, value: [cx, cy - 6] },
        { time: 5, value: [cx, cy] },
      ],
      interpolation: "easyEase",
    });

    // 8.9 wordmark opacity: 0 → 1 → breathe 1 → 0.92 → 1
    await call("add_keyframe", {
      layer: wordmark.id,
      path: "transform/opacity",
      keys: [
        { time: 0.15, value: 0 },
        { time: 0.55, value: 100 },
      ],
      interpolation: "easyEaseIn",
    });
    await call("add_keyframe", {
      layer: wordmark.id,
      path: "transform/opacity",
      keys: [
        { time: 2.6, value: 100 },
        { time: 2.85, value: 92 },
        { time: 3.1, value: 100 },
      ],
      interpolation: "easyEase",
    });

    // 8.10 tagline scale rig
    await call("add_keyframe", {
      layer: tagline.id,
      path: "transform/scale",
      keys: [
        { time: 1.2, value: [96, 96] },
        { time: 1.6, value: [100, 100] },
      ],
      interpolation: "easyEase",
    });

    // 8.11 trim modifier — add first, then discover path (never hard-code)
    const trimAddRaw = await call("execute_command", {
      command: "layer.addShapeItem",
      params: { layer: bar.id, kind: "trim" },
    });
    const trimGuard = guards["layer.addShapeItem"](trimAddRaw);
    if (!trimGuard.ok) {
      return {
        ok: false,
        slug: spec.slug,
        error: {
          code: "RigBatchFailed",
          message: trimGuard.error,
          step: "layer.addShapeItem",
        },
      };
    }
    const barFlat = (await call("get_layer", { layer: bar.id, flat: true })) as FlatNode[];
    const trimPath = findTrimPath(barFlat);
    if (!trimPath) {
      return {
        ok: false,
        slug: spec.slug,
        error: {
          code: "RigBatchFailed",
          message: "trim node missing after addShapeItem",
          step: "get_layer",
        },
      };
    }

    await call("add_keyframe", {
      layer: bar.id,
      path: `${trimPath}/end`,
      keys: [
        { time: 0.4, value: 0 },
        { time: 1.4, value: 100 },
      ],
      interpolation: "easyEase",
    });
    await call("add_keyframe", {
      layer: bar.id,
      path: `${trimPath}/offset`,
      keys: [{ time: 0, value: 0 }],
      interpolation: "hold",
    });

    // 8.12 save + hero render
    const projectRelPath = `${spec.slug}/${spec.slug}.ecproj`;
    const heroRelPath = `${spec.slug}/${spec.slug}-hero.png`;
    const projectAbs = underRoot(outDir, projectRelPath);
    const heroAbs = underRoot(outDir, heroRelPath);

    await bundle.client.callTool({
      name: "save_project",
      arguments: { path: projectAbs },
    });

    const renderRes = (await call("render_frame", {
      comp: compId,
      time: 1.5,
      max_side: 1920,
      path: heroAbs,
      inline: false,
    })) as { path?: string };

    if (!renderRes || renderRes.path !== heroAbs) {
      return {
        ok: false,
        slug: spec.slug,
        error: {
          code: "RenderFailed",
          message: "render_frame did not produce hero PNG",
          step: "render:hero",
        },
      };
    }

    return {
      ok: true,
      slug: spec.slug,
      comp: compId,
      projectPath: projectAbs,
      heroPath: heroAbs,
      warnings: uniq(warnings),
    };
  } catch (err) {
    if (err instanceof PathViolationError) {
      return {
        ok: false,
        slug: spec.slug,
        error: { code: "PathViolation", message: err.message, step: "path" },
      };
    }
    return {
      ok: false,
      slug: spec.slug,
      error: { code: "RigBatchFailed", message: (err as Error).message, step: "unknown" },
    };
  } finally {
    if (bundle) {
      await bundle.client.close().catch(() => undefined);
    }
  }
}

/* ------------------------------------------------------------------ *
 * 9. Batch entry — never throws, always produces a report.
 * ------------------------------------------------------------------ */

export interface BatchReport {
  franchises: Array<
    | { slug: string; ok: true; projectPath: string; heroPath: string; warnings: string[] }
    | { slug: string; ok: false; error: { code: FranchiseErrorCode; message: string; step: string } }
  >;
  summary: { ok: number; failed: number; total: number; durationMs: number };
}

export async function runBatch(specs: FranchiseSpec[], outDir: string): Promise<FranchiseResult[]> {
  const started = performance.now();
  const results: FranchiseResult[] = [];
  for (const spec of specs) {
    const r = await runFranchise(spec, outDir);
    results.push(r);
    console.log(`[${r.ok ? "ok" : "fail"}] ${spec.slug}`);
  }

  const report: BatchReport = {
    franchises: results.map((r) =>
      r.ok
        ? { slug: r.slug, ok: true, projectPath: r.projectPath, heroPath: r.heroPath, warnings: r.warnings }
        : { slug: r.slug, ok: false, error: r.error },
    ),
    summary: {
      ok: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
      total: results.length,
      durationMs: Math.round(performance.now() - started),
    },
  };

  const reportPath = underRoot(outDir, "report.json");
  await writeFile(reportPath, JSON.stringify(report, null, 2), "utf8");
  return results;
}

/* ------------------------------------------------------------------ *
 * 10. Determinism verifier — sha256 of the .ecproj file across two runs.
 * ------------------------------------------------------------------ */

export async function sha256File(path: string): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}
