// src/adapters/claude-code.ts
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { StudioPolicy } from "../policy/schema.js";
import type { PolicyEngine } from "../policy/engine.js";
import type { DriftReport } from "./cursor.js";

/** Emit `.mcp.json` — Claude Code's project-scoped MCP server catalogue. */
export function compileClaudeMcp(
  policy: StudioPolicy,
  engine: PolicyEngine,
  agentId: string,
): string {
  const agent = policy.agents.find((a) => a.id === agentId);
  if (!agent) throw new Error(`unknown agent "${agentId}"`);
  const servers: Record<string, unknown> = {};
  for (const craftId of agent.crafts) {
    const binding = engine.getCraft(craftId);
    if (!binding) continue;
    servers[`storytold-${binding.id}`] = {
      type: "stdio",
      command: binding.binary,
      args: [
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
      ],
      ...(binding.sandboxFlags ? {} : { cwd: binding.roots.write[0] }),
    };
  }
  return JSON.stringify({ mcpServers: servers }, null, 2) + "\n";
}

/**
 * Emit `.claude/settings.json`. Claude Code merges this into its permission
 * model: `permissions.allow` lists tool-call signatures that are auto-approved,
 * `permissions.deny` blocks them, and `permissions.ask` prompts the user.
 */
export function compileClaudeSettings(
  policy: StudioPolicy,
  engine: PolicyEngine,
  agentId: string,
): string {
  const agent = policy.agents.find((a) => a.id === agentId);
  if (!agent) throw new Error(`unknown agent "${agentId}"`);
  const allow = engine.effectiveAllow(agentId);
  const desktopOk = engine.authorizeDesktop(agent.role, agent.crafts[0]!).allow;

  // Claude Code's allow entries use `mcp__<serverName>__<toolName>` or,
  // for command-level granularity, our own `command_run` id namespace.
  const serverNames = policy.crafts
    .filter((c) => agent.crafts.includes(c.id))
    .map((c) => `storytold-${c.id}`);

  const allowRules: string[] = [];
  for (const s of serverNames) {
    allowRules.push(`mcp__${s}__doc_inspect`);
    allowRules.push(`mcp__${s}__list_commands`);
    allowRules.push(`mcp__${s}__doc_new`);
    if (desktopOk) allowRules.push(`mcp__${s}__ui_screenshot`);
  }
  const denyRules: string[] = serverNames.map((s) => `mcp__${s}__file_delete`);

  const settings = {
    $schema: "https://schemas.storytold.dev/claude-settings-1.0.json",
    permissions: {
      allow: allowRules,
      deny: denyRules,
      ask: desktopOk ? serverNames.map((s) => `mcp__${s}__ui_pointer`) : [],
    },
    env: {
      // Placeholder env; real values are injected by the governor bridge.
      STORYTOLD_AGENT: agentId,
      STORYTOLD_ROLE: agent.role,
      STORYTOLD_POLICY_VERSION: policy.version,
    },
    hooks: {
      // A PostToolUse hook that captures every MCP call for studio-wide audit.
      PostToolUse: [
        {
          matcher: "mcp__storytold-*__*",
          hooks: [
            {
              type: "command",
              command: "studio-governor audit --from-hook",
            },
          ],
        },
      ],
    },
  };
  return JSON.stringify(settings, null, 2) + "\n";
}

/** Write both Claude Code artefacts, reporting drift on each. */
export async function syncClaude(
  workspace: string,
  policy: StudioPolicy,
  engine: PolicyEngine,
  agentId: string,
): Promise<DriftReport[]> {
  const mcpPath = join(workspace, ".mcp.json");
  const settingsPath = join(workspace, ".claude", "settings.json");
  return [
    await writeIfChanged(mcpPath, compileClaudeMcp(policy, engine, agentId)),
    await writeIfChanged(settingsPath, compileClaudeSettings(policy, engine, agentId)),
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
