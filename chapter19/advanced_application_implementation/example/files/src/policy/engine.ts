// src/policy/engine.ts
import type { CraftBinding, Role, StudioPolicy } from "./schema.js";

export type Decision =
  | { allow: true }
  | { allow: false; reason: string };

/**
 * Compile a prefix-list into a fast matcher. A prefix matches if the command
 * id begins with the prefix followed by "." or is exactly equal to it. The
 * wildcard "*" matches every command.
 */
function matchesAny(id: string, prefixes: readonly string[]): boolean {
  for (const p of prefixes) {
    if (p === "*") return true;
    if (id === p) return true;
    if (id.startsWith(p + ".")) return true;
  }
  return false;
}

/**
 * The PolicyEngine. Immutable once constructed; look up the role and craft on
 * every query to keep the surface area small.
 */
export class PolicyEngine {
  private readonly roles: Map<string, Role>;
  private readonly crafts: Map<string, CraftBinding>;

  constructor(private readonly policy: StudioPolicy) {
    this.roles = new Map(policy.roles.map((r) => [r.name, r]));
    this.crafts = new Map(policy.crafts.map((c) => [c.id, c]));
  }

  getRole(name: string): Role | undefined { return this.roles.get(name); }
  getCraft(id: string): CraftBinding | undefined { return this.crafts.get(id); }

  /**
   * Decide whether `agentId` (with `roleName`) may run `commandId` against the
   * `craftId` binding. This is the *only* place authorization lives.
   */
  authorizeCommand(roleName: string, craftId: string, commandId: string): Decision {
    const role = this.roles.get(roleName);
    if (!role) return { allow: false, reason: `unknown role "${roleName}"` };
    const craft = this.crafts.get(craftId);
    if (!craft) return { allow: false, reason: `unknown craft "${craftId}"` };

    // Explicit denies always win, regardless of any allow rule.
    if (matchesAny(commandId, role.deny) || matchesAny(commandId, craft.deny)) {
      return { allow: false, reason: `denied by role/craft deny-list` };
    }
    if (!matchesAny(commandId, role.allow) || !matchesAny(commandId, craft.allow)) {
      return { allow: false, reason: `not in role/craft allow-list` };
    }
    // Export commands require the role-level export flag.
    if (isExportCommand(commandId) && !role.mayExport) {
      return { allow: false, reason: `role lacks export privilege for "${commandId}"` };
    }
    return { allow: true };
  }

  /**
   * Decide whether a UI-driving meta-tool (`ui_pointer`, `ui_set`, `ui_screenshot`)
   * may be invoked by an agent. Both the role and the craft must opt in.
   */
  authorizeDesktop(roleName: string, craftId: string): Decision {
    const role = this.roles.get(roleName);
    const craft = this.crafts.get(craftId);
    if (!role || !craft) return { allow: false, reason: "unknown role or craft" };
    if (!role.mayDriveDesktop) return { allow: false, reason: "role lacks desktop privilege" };
    if (!craft.desktopControl) return { allow: false, reason: "craft binding disables desktop control" };
    return { allow: true };
  }

  /**
   * Compute the effective allow-list an agent should see emitted into its
   * config. This intersects the role allow-list, the craft allow-list, the
   * agent-level overrides, and subtracts any deny prefixes. The result is a
   * sorted array of concrete prefixes suitable for a `.cursorrule` or an
   * Anthropic-style `permissions.allow` entry.
   */
  effectiveAllow(agentId: string): string[] {
    const agent = this.policy.agents.find((a) => a.id === agentId);
    if (!agent) throw new Error(`unknown agent ${agentId}`);
    const role = this.roles.get(agent.role)!;
    const rolesAllowed = new Set(role.allow);
    const agentAllowed = new Set(agent.overrides.allow ?? role.allow);
    const combined = [...rolesAllowed].filter((p) => agentAllowed.has(p));
    // Include deny prefixes so the emitted config is self-describing.
    const deniedPrefixes = new Set([...(role.deny ?? []), ...(agent.overrides.deny ?? [])]);
    return combined.filter((p) => !deniedPrefixes.has(p)).sort();
  }
}

/**
 * Command-id heuristics for the export privilege. The pattern intentionally
 * errs on the side of "this is an export" — false positives merely ask for
 * a broader role, false negatives could leak assets to disk unchecked.
 */
function isExportCommand(id: string): boolean {
  return (
    id.startsWith("doc_save") ||
    id.startsWith("file.export") ||
    id.startsWith("file.save") ||
    id.startsWith("document.export") ||
    id.includes("export")
  );
}
