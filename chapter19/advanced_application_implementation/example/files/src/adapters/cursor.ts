// src/adapters/cursor.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StudioPolicy, CraftBinding } from "../policy/schema.js";
import type { PolicyEngine } from "../policy/engine.js";

export interface DriftReport {
  path: string;
  changed: boolean;
  reason?: string;
}

/** Compose the `.cursor/mcp.json` document for the given policy. */
export function compileCursorMcp(
  policy: StudioPolicy,
  engine: PolicyEngine,
  agentId: string,
): string {
  const agent = policy.agents.find((a) => a.id === agentId);
  if (!agent) throw new Error(`unknown agent "${agentId}"`);
  const servers: Record<string, unknown> = {};
  for (const craftId of agent.crafts) {
    const binding = engine.getCraft(craftId);
    if (!binding) throw new Error(`agent "${agentId}" → unknown craft "${craftId}"`);
    servers[`storytold-${binding.id}`] = {
      command: binding.binary,
      args: [
        "mcp",
        ...binding.args,
        // Only the engines that accept the flags get them; the others are
        // bounded by their working directory, and the adapter records that
        // in the config so the operator can see it.
        ...(binding.sandboxFlags
          ? [
            ...binding.roots.read.flatMap((r) => ["--automation-read-root", r]),
            ...binding.roots.write.flatMap((w) => ["--automation-write-root", w]),
          ]
          : []),
      ],
      ...(binding.sandboxFlags ? {} : { cwd: binding.roots.write[0] }),
      // Secrets are *never* written to this file. The governor spawns the
      // process itself; Cursor sees only the adapter's stdio bridge (below).
    };
  }
  return JSON.stringify({ mcpServers: servers }, null, 2) + "\n";
}

/** Compose the `studio.mdc` front-matter rule that describes the policy. */
export function compileCursorRule(
  policy: StudioPolicy,
  engine: PolicyEngine,
  agentId: string,
): string {
  const allow = engine.effectiveAllow(agentId);
  return [
    "---",
    "description: Storytold Studio governance policy (auto-generated; do not edit)",
    "globs: **/*",
    "alwaysApply: true",
    "---",
    "",
    "# Studio Policy",
    "",
    "You are an agent within a governed Storytold studio. The following rules are",
    "enforced at the MCP bridge; attempting to bypass them will be rejected and",
    "logged.",
    "",
    "## Command allow-list",
    "",
    ...allow.map((p) => `- Run only commands whose id begins with \`${p}\`.`),
    "",
    "## Behaviours",
    "",
    "- Always call `doc_inspect` after a batch that mutates a document.",
    "- Always call `doc_save` with a path under the workspace's write root.",
    "- Never invoke a Craft binary that is not listed in `.cursor/mcp.json`.",
    "",
  ].join("\n");
}

/** Write both Cursor artefacts, reporting whether each changed. */
export async function syncCursor(
  workspace: string,
  policy: StudioPolicy,
  engine: PolicyEngine,
  agentId: string,
): Promise<DriftReport[]> {
  const mcpPath = join(workspace, ".cursor", "mcp.json");
  const rulePath = join(workspace, ".cursor", "rules", "studio.mdc");
  const nextMcp = compileCursorMcp(policy, engine, agentId);
  const nextRule = compileCursorRule(policy, engine, agentId);
  return [
    await writeIfChanged(mcpPath, nextMcp),
    await writeIfChanged(rulePath, nextRule),
  ];
}

async function writeIfChanged(path: string, next: string): Promise<DriftReport> {
  let prev: string | null = null;
  try { prev = await readFile(path, "utf8"); } catch { /* missing */ }
  if (prev === next) return { path, changed: false };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, "utf8");
  return { path, changed: true, reason: prev === null ? "created" : "updated" };
}
