// src/adapters/opencode.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StudioPolicy } from "../policy/schema.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { DriftReport } from "./cursor.js";

/** Compose `opencode.json` from the policy for a given agent binding. */
export function compileOpenCode(
  policy: StudioPolicy,
  engine: PolicyEngine,
  agentId: string,
): string {
  const agent = policy.agents.find((a) => a.id === agentId);
  if (!agent) throw new Error(`unknown agent "${agentId}"`);
  const mcp: Record<string, unknown> = {};
  for (const craftId of agent.crafts) {
    const binding = engine.getCraft(craftId);
    if (!binding) continue;
    const cmd = [
      binding.binary,
      "mcp",
      ...binding.args,
      // Only the engines that accept the roots get them; the rest reject
      // the flags and confine nothing, so the worker owns their boundary.
      ...(binding.sandboxFlags
        ? [
          ...binding.roots.read.flatMap((r) => ["--automation-read-root", r]),
          ...binding.roots.write.flatMap((w) => ["--automation-write-root", w]),
        ]
        : []),
    ];
    mcp[`storytold-${binding.id}`] = {
      type: "local",
      command: cmd,
      // The working directory is the boundary for an engine that takes no
      // sandbox flags, so the projection has to say so.
      ...(binding.sandboxFlags ? {} : { cwd: binding.roots.write[0] }),
      enabled: true,
      // OpenCode's `agent` field lets it dispatch to a specific sub-agent;
      // we reuse it here for the policy's role identifier.
      environment: { STORYTOLD_ROLE: agent.role },
    };
  }

  const doc = {
    $schema: "https://opencode.ai/config.json",
    mcp,
    agent: {
      build: {
        description: `Storytold studio agent (role: ${agent.role})`,
        mode: "primary",
        tools: Object.fromEntries(
          Object.keys(mcp).flatMap((server) => [
            [`${server}_*_command_run`, true],
            [`${server}_*_doc_inspect`, true],
            [`${server}_*_list_commands`, true],
            [`${server}_*_doc_save`, policy.roles.find((r) => r.name === agent.role)?.mayExport ?? false],
          ]),
        ),
      },
    },
    // Studio policy in OpenCode's instruction channel: this gets prepended to
    // every prompt the primary agent receives.
    instructions: [
      `# Storytold Studio (policy v${policy.version})`,
      ...engine.effectiveAllow(agentId).map((p) => `- Only invoke commands whose id begins with \`${p}\`.`),
    ],
    autoupdate: false,
  };
  return JSON.stringify(doc, null, 2) + "\n";
}

export async function syncOpenCode(
  workspace: string,
  policy: StudioPolicy,
  engine: PolicyEngine,
  agentId: string,
): Promise<DriftReport[]> {
  const path = join(workspace, "opencode.json");
  return [await writeIfChanged(path, compileOpenCode(policy, engine, agentId))];
}

async function writeIfChanged(path: string, next: string): Promise<DriftReport> {
  let prev: string | null = null;
  try { prev = await readFile(path, "utf8"); } catch { /* missing */ }
  if (prev === next) return { path, changed: false };
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, "utf8");
  return { path, changed: true, reason: prev === null ? "created" : "updated" };
}
