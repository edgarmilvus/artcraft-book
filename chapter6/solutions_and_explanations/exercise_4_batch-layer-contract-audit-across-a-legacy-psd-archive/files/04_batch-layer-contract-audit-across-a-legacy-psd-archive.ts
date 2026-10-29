// audit-archive.ts
// Read-only batch audit. Never touches the archive; writes only into the audit
// directory. Concurrency is achieved by a small worker pool of photocraft-cli
// mcp child processes, because a single stdio MCP server serialises document
// state.

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { z } from "zod";

// ---------------------------------------------------------------------------
// 1. The report entry schema — the contract the rest of the pipeline consumes.
// ---------------------------------------------------------------------------
const ReportEntry = z.object({
  file: z.string(),
  verdict: z.enum(["pass", "warn", "fail"]),
  reasons: z.array(z.string()),
  treeHash: z.string().regex(/^[0-9a-f]{64}$/),
  layerCount: z.number().int().min(0),
  deepestNesting: z.number().int().min(0),
});
export type ReportEntry = z.infer<typeof ReportEntry>;

// ---------------------------------------------------------------------------
// 2. Canonical tree hashing. Identity is (name, kind, flags, opacity, blend,
//    clip state) plus the *order* of the siblings. Order is part of the
//    contract: clipping is positional, so a layer that moves one slot down
//    clips to a different base. Ids and engine-internal insertion counters are
//    never hashed, because they differ between engine builds.
// ---------------------------------------------------------------------------
type RawNode = {
  id?: number;
  name: string;
  kind: string;
  visible?: boolean;
  opacity?: number;
  fill?: number;
  blend?: string;
  clipped?: boolean;
  children?: RawNode[];
};

type CanonicalNode = {
  name: string;
  kind: string;
  visible: boolean;
  opacity: number;
  fill: number;
  blend: string;
  clipped: boolean;
  children: CanonicalNode[];
};

function round3(x: number): number { return Math.round(x * 1000) / 1000; }

function canonicalize(node: RawNode): CanonicalNode {
  return {
    name: node.name,
    kind: node.kind,
    visible: node.visible ?? true,
    opacity: round3(node.opacity ?? 1),
    fill: round3(node.fill ?? 1),
    blend: node.blend ?? "Normal",
    clipped: node.clipped ?? false,
    children: (node.children ?? []).map(canonicalize),
  };
}

export function treeHash(roots: RawNode[]): string {
  // Root order is deliberately preserved: the top-level stacking order is part
  // of the contract, and so is every child order below it.
  const canonical = roots.map(canonicalize);
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

// ---------------------------------------------------------------------------
// 3. Heuristics. These run *after* the raw hash is computed and are used only
//    to attach reasons to a verdict, never to influence the hash.
// ---------------------------------------------------------------------------
function inspectTree(roots: RawNode[]): {
  layerCount: number;
  deepestNesting: number;
  topLevelGroupNames: string[];
  orphanClips: string[];
  rasterisedType: string[];
  topLevelClipped: string[];
} {
  let layerCount = 0, deepestNesting = 0;
  const orphanClips: string[] = [];
  const rasterisedType: string[] = [];
  const topLevelClipped: string[] = [];

  (function walk(nodes: RawNode[], depth: number, parent?: RawNode) {
    for (const node of nodes) {
      layerCount += 1;
      if (depth > deepestNesting) deepestNesting = depth;

      // A contract type layer is editable type. If the name still says Type::
      // but the node holds pixels, someone rasterised it and the downstream
      // editor can no longer re-flow the copy. Groups carry the Type:: prefix
      // too, so they are excluded here.
      if (node.name?.startsWith("Type::") && node.kind !== "Type" && node.kind !== "Group") {
        rasterisedType.push(node.name);
      }
      if (node.clipped) {
        if (!parent) {
          topLevelClipped.push(node.name);
        } else if ((parent.children ?? []).length === 1) {
          // A clipped layer alone in its group has no clip base: the mask lost
          // the layer it was clipping to. That is a warn, not a fail — the
          // pixels can still be right.
          orphanClips.push(node.name);
        }
      }
      if (node.children?.length) walk(node.children, depth + 1, node);
    }
  })(roots, 0);

  return {
    layerCount,
    deepestNesting,
    topLevelGroupNames: roots.filter((r) => r.kind === "Group").map((r) => r.name),
    orphanClips,
    rasterisedType,
    topLevelClipped,
  };
}

// ---------------------------------------------------------------------------
// 4. Verdict logic. Equal hash to baseline → pass (or warn if orphanClips).
//    Any of the "definite" violations → fail.
// ---------------------------------------------------------------------------
function verdictFor(file: string, roots: RawNode[], baselineHash: string): ReportEntry {
  const hash = treeHash(roots);
  const info = inspectTree(roots);
  const base = {
    file, treeHash: hash,
    layerCount: info.layerCount, deepestNesting: info.deepestNesting,
  };

  if (hash === baselineHash && info.orphanClips.length === 0) {
    return { ...base, verdict: "pass", reasons: [] };
  }

  // Not equal to baseline — enumerate every reason independently.
  const reasons: string[] = [];
  if (info.rasterisedType.length > 0)
    reasons.push(`rasterised-type: ${info.rasterisedType.join(", ")}`);
  if (info.topLevelClipped.length > 0)
    reasons.push(`top-level-clipped: ${info.topLevelClipped.join(", ")}`);
  if (!info.topLevelGroupNames.includes("Background"))
    reasons.push("missing-background-group");
  if (info.orphanClips.length > 0)
    reasons.push(`orphan-clip: ${info.orphanClips.join(", ")}`);
  if (reasons.length === 0) reasons.push("tree-differs-from-baseline");

  const hard = reasons.some((r) =>
    r.startsWith("rasterised-type")
      || r.startsWith("top-level-clipped")
      || r === "missing-background-group");
  return { ...base, verdict: hard ? "fail" : "warn", reasons };
}

// ---------------------------------------------------------------------------
// 5. Reply helpers. Every tool returns a content-block array; the JSON we audit
//    is the text block, and a refusal is `isError` with a sentence in it.
// ---------------------------------------------------------------------------
function payload(result: unknown): unknown {
  const { content, isError } = result as {
    content?: Array<{ type?: string; text?: string }>;
    isError?: boolean;
  };
  const text = content?.find((b) => b.type === "text")?.text;
  if (isError) throw new Error(text ?? "the engine refused the call");
  if (typeof text !== "string") throw new Error("the reply carried no text block");
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// 6. Worker pool. A single photocraft-cli mcp child serialises document state,
//    so real parallelism needs multiple child processes. Each worker handles
//    one document at a time and closes it before taking the next.
// ---------------------------------------------------------------------------
interface Worker { client: Client; close: () => Promise<void>; }

async function spawnWorker(readRoot: string, writeRoot: string): Promise<Worker> {
  const transport = new StdioClientTransport({
    command: "photocraft-cli",
    args: ["mcp",
      "--automation-read-root", readRoot,
      "--automation-write-root", writeRoot],
  });
  const client = new Client({ name: "audit-worker", version: "1.0.0" }, { capabilities: {} });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

async function openRoots(worker: Worker, filePath: string): Promise<RawNode[]> {
  // META-TOOL, not command_run — the exercise mandates doc_open. The reply
  // names the document with `index`, which is what doc_close and doc_inspect
  // take; it is not an `id` field.
  const opened = z.object({
    index: z.number().int().nonnegative(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    layers: z.number().int().nonnegative(),
    warnings: z.array(z.string()).default([]),
  }).parse(payload(await worker.client.callTool({
    name: "doc_open", arguments: { path: filePath },
  })));

  try {
    const inspected = z.object({
      layers: z.array(z.unknown()),
    }).parse(payload(await worker.client.callTool({
      name: "doc_inspect", arguments: { index: opened.index },
    })));
    return inspected.layers as RawNode[];
  } finally {
    // Closing keeps the worker's memory flat across a large archive.
    await worker.client.callTool({
      name: "doc_close", arguments: { index: opened.index },
    });
  }
}

async function auditOne(
  worker: Worker, filePath: string, baselineHash: string
): Promise<ReportEntry> {
  try {
    return verdictFor(filePath, await openRoots(worker, filePath), baselineHash);
  } catch (err) {
    return {
      file: filePath, verdict: "fail",
      reasons: [`unreadable: ${(err as Error).message}`],
      treeHash: "0".repeat(64), layerCount: 0, deepestNesting: 0,
    };
  }
}

// ---------------------------------------------------------------------------
// 7. Driver. Spawns a pool, drains a queue, writes the report deterministically
//    (sorted by file path — the one ordering we can rely on across runs).
// ---------------------------------------------------------------------------
export async function auditArchive(
  archiveRoot: string, outDir: string,
  opts: { readRoot: string; writeRoot: string; baselinePath: string; concurrency?: number },
): Promise<ReportEntry[]> {
  // `readdir` with `recursive: true` reports the containing directory; the key
  // is `parentPath` on current Node releases and `path` on newer ones.
  const found = await fs.readdir(archiveRoot, { recursive: true, withFileTypes: true });
  const entries = found
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".psd"))
    .map((d) => {
      const dir = (d as unknown as { parentPath?: string; path?: string }).parentPath
        ?? (d as unknown as { path?: string }).path ?? archiveRoot;
      return path.join(dir, d.name);
    });
  entries.sort();

  // The engine validates its write root at startup, so it has to exist before
  // the first worker is spawned — not only when the report is written.
  await fs.mkdir(outDir, { recursive: true });

  const baselineHash = await (async () => {
    const worker = await spawnWorker(opts.readRoot, opts.writeRoot);
    try {
      return treeHash(await openRoots(worker, opts.baselinePath));
    } finally {
      await worker.close();
    }
  })();

  const poolSize = opts.concurrency ?? 4;
  const workers = await Promise.all(
    Array.from({ length: poolSize }, () => spawnWorker(opts.readRoot, opts.writeRoot)),
  );

  const queue = [...entries];
  const results: ReportEntry[] = [];
  try {
    await Promise.all(workers.map(async (worker) => {
      while (queue.length > 0) {
        const next = queue.shift();
        if (!next) break;
        results.push(await auditOne(worker, next, baselineHash));
      }
    }));
  } finally {
    await Promise.all(workers.map((worker) => worker.close()));
  }

  results.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));

  await fs.writeFile(
    path.join(outDir, "report.json"),
    JSON.stringify({ baselineHash, entries: results }, null, 2),
    "utf8",
  );
  return results;
}

// ---------------------------------------------------------------------------
// 8. Sandbox-refusal self-test: a write aimed at the read-only archive must be
//    refused. `doc_save` reports a refusal as an MCP error, not as `{ok:false}`.
// ---------------------------------------------------------------------------
export async function assertReadOnlyRefusal(
  opts: { readRoot: string; writeRoot: string },
): Promise<void> {
  const worker = await spawnWorker(opts.readRoot, opts.writeRoot);
  try {
    await worker.client.callTool({
      name: "doc_new",
      arguments: { width: 16, height: 16, mode: "rgb", depth: 8, background: "white" },
    });
    const out = await worker.client.callTool({
      name: "doc_save",
      arguments: { path: `${opts.readRoot}/__should_refuse__.psd`, format: "psd" },
    });
    if ((out as { isError?: boolean }).isError !== true) {
      throw new Error("the sandbox did not refuse a write into the read root");
    }
  } finally {
    await worker.close();
  }
}
