/**
 * northwind-mcp-governance / fleet-generator.ts
 *
 * One master file in, four artefacts out:
 *
 *   mcp.fleet.json ──► mcp.fleet.lock.json               (signed audit envelope)
 *                   ──► stations/<role>/.cursor/mcp.json
 *                   ──► stations/<role>/.mcp.json        (Claude Code, project scope)
 *                   ──► stations/<role>/opencode.json
 *
 * `mcp.fleet.json` is a *constraint* file: it states what the studio wants.
 * `mcp.fleet.lock.json` is the *resolution*: the same constraint graph
 * projected onto one concrete set of servers, roots, capabilities and engine
 * dialects, signed so that a compliance bot can re-verify a running
 * workstation without access to the vault.
 *
 * Two facts about the suite drive the whole design.
 *
 * 1. The engines do not share a dialect. PhotoCraft runs a command through
 *    `command_run { id }`, DesignCraft through `execute { command }`,
 *    EffectCraft through `execute_command { command }`. Their registries are
 *    discovered through `command_list { filter }` or `list_commands { filter }`,
 *    and the "enabled only" switch is spelled `enabled_only` in one engine and
 *    `enabledOnly` in another. A generator that hard-codes one spelling audits
 *    nothing: the call is rejected and the leak is never noticed.
 *
 * 2. Only part of the suite accepts a sandbox. `--automation-read-root` and
 *    `--automation-write-root` are honoured by PhotoCraft, FilmCraft,
 *    VectorCraft and DeckCraft. The other engines either refuse the flags
 *    outright or ignore them in silence, and in neither case do they police
 *    the directory. A projection therefore records, per server, whether the
 *    roots are policed by the engine itself or by the worker that fronts it.
 */

import { createHash, createHmac } from "node:crypto";
import { accessSync, constants, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";

/* ────────────────────────────────────────────────────────────────────────────
 * 1. THE ENGINE REGISTRY
 *
 * Every ArtCraft engine speaks MCP, but each one names the same three
 * operations differently. The generator compiles against this table, so the
 * table is the single place where a dialect change has to be absorbed.
 * ──────────────────────────────────────────────────────────────────────────── */

const APP_IDS = [
  "photocraft",
  "vectorcraft",
  "designcraft",
  "filmcraft",
  "effectcraft",
  "lightcraft",
  "pdfcraft",
  "wordcraft",
] as const;

const AppSchema = z.enum(APP_IDS);

/** The argument that carries the command id in the engine's "run one" tool. */
const RunArgSchema = z.union([z.literal("id"), z.literal("command")]);
/** The argument that carries the steps in the engine's "run many" tool. */
const BatchArgSchema = z.union([z.literal("steps"), z.literal("commands")]);
/** The argument that narrows the engine's command registry. */
const FilterArgSchema = z.union([
  z.literal("filter"),
  z.literal("search"),
  z.literal("query"),
]);
/** The argument that restricts the registry to the enabled commands. */
const EnabledArgSchema = z.union([z.literal("enabled_only"), z.literal("enabledOnly")]);
/** The argument that decides whether a batch keeps going after a failed step. */
const BatchStopArgSchema = z.union([z.literal("stop_on_error"), z.literal("keepGoing")]);

const DocumentToolsSchema = z.object({
  new: z.string().min(1).nullable(),
  open: z.string().min(1).nullable(),
  save: z.string().min(1).nullable(),
  inspect: z.string().min(1).nullable(),
});

const SurfaceSchema = z.object({
  app: AppSchema,
  /** The tool that runs one engine command. */
  runTool: z.string().min(1),
  /** The argument of `runTool` that carries the command id. */
  runArg: RunArgSchema,
  /** The tool that runs several engine commands, when the engine has one. */
  batchTool: z.string().min(1).nullable(),
  /** The argument of `batchTool` that carries the steps. */
  batchArg: BatchArgSchema.nullable(),
  /** The argument of `batchTool` that decides whether a batch continues. */
  batchStopArg: BatchStopArgSchema.nullable(),
  /** The tool that lists the engine's command registry. */
  discoveryTool: z.string().min(1),
  /** The argument of `discoveryTool` that narrows the registry. */
  discoveryFilterArg: FilterArgSchema.nullable(),
  /** The argument of `discoveryTool` that keeps only the enabled commands. */
  discoveryEnabledArg: EnabledArgSchema.nullable(),
  /** The document lifecycle tools of the engine. */
  documentTools: DocumentToolsSchema,
  /**
   * Whether the engine itself accepts `--automation-read-root` and
   * `--automation-write-root`. When it does not, the worker in front of it
   * has to police the roots on its own.
   */
  enforcesRoots: z.boolean(),
});

export type EngineSurface = z.infer<typeof SurfaceSchema>;
export type App = z.infer<typeof AppSchema>;

/**
 * The registry the generator compiles against.
 *
 * Note the three asymmetries that a naive generator gets wrong:
 *
 * - DesignCraft has no `command_run`: it is `execute { command }`, and its
 *   registry is `list_commands { filter, enabledOnly }`.
 * - VectorCraft has no document-creation meta-tool at all — a document is
 *   created by running the `file.new` *command*.
 * - WordCraft's registry is `list_commands { query }`: it has neither a
 *   `filter` argument nor an "enabled only" switch.
 */
export const ENGINE_SURFACES: Readonly<Record<App, EngineSurface>> = {
  photocraft: {
    app: "photocraft",
    runTool: "command_run",
    runArg: "id",
    batchTool: "command_batch",
    batchArg: "steps",
    batchStopArg: "stop_on_error",
    discoveryTool: "command_list",
    discoveryFilterArg: "filter",
    discoveryEnabledArg: "enabled_only",
    documentTools: {
      new: "doc_new",
      open: "doc_open",
      save: "doc_save",
      inspect: "doc_inspect",
    },
    enforcesRoots: true,
  },
  vectorcraft: {
    app: "vectorcraft",
    runTool: "command_run",
    runArg: "id",
    batchTool: "command_batch",
    batchArg: "steps",
    batchStopArg: "stop_on_error",
    discoveryTool: "command_list",
    discoveryFilterArg: "filter",
    discoveryEnabledArg: "enabled_only",
    documentTools: {
      new: null,
      open: "open_file",
      save: "save_file",
      inspect: "doc_inspect",
    },
    enforcesRoots: true,
  },
  designcraft: {
    app: "designcraft",
    runTool: "execute",
    runArg: "command",
    batchTool: "batch",
    batchArg: "commands",
    batchStopArg: null,
    discoveryTool: "list_commands",
    discoveryFilterArg: "filter",
    discoveryEnabledArg: "enabledOnly",
    documentTools: {
      new: "new_document",
      open: "open_document",
      save: "save_document",
      inspect: "inspect_document",
    },
    enforcesRoots: false,
  },
  filmcraft: {
    app: "filmcraft",
    runTool: "command_run",
    runArg: "id",
    batchTool: "command_batch",
    batchArg: "steps",
    batchStopArg: "stop_on_error",
    discoveryTool: "command_list",
    discoveryFilterArg: "filter",
    discoveryEnabledArg: "enabled_only",
    documentTools: {
      new: null,
      open: null,
      save: null,
      inspect: "doc_inspect",
    },
    enforcesRoots: true,
  },
  effectcraft: {
    app: "effectcraft",
    runTool: "execute_command",
    runArg: "command",
    batchTool: "batch",
    batchArg: "steps",
    batchStopArg: null,
    discoveryTool: "list_commands",
    discoveryFilterArg: "filter",
    discoveryEnabledArg: "enabled_only",
    documentTools: {
      new: null,
      open: "open_project",
      save: "save_project",
      inspect: "get_project",
    },
    enforcesRoots: false,
  },
  lightcraft: {
    app: "lightcraft",
    runTool: "command_run",
    runArg: "id",
    batchTool: "command_batch",
    batchArg: "steps",
    batchStopArg: "stop_on_error",
    discoveryTool: "command_list",
    discoveryFilterArg: "filter",
    discoveryEnabledArg: "enabled_only",
    documentTools: {
      new: null,
      open: null,
      save: null,
      inspect: "doc_inspect",
    },
    enforcesRoots: false,
  },
  pdfcraft: {
    app: "pdfcraft",
    runTool: "command_run",
    runArg: "id",
    batchTool: "command_batch",
    batchArg: "steps",
    batchStopArg: "stop_on_error",
    discoveryTool: "command_list",
    discoveryFilterArg: "filter",
    discoveryEnabledArg: "enabled_only",
    documentTools: {
      new: null,
      open: "doc_open",
      save: "doc_save",
      inspect: "doc_inspect",
    },
    enforcesRoots: false,
  },
  wordcraft: {
    app: "wordcraft",
    runTool: "execute",
    runArg: "command",
    batchTool: "batch",
    batchArg: "commands",
    batchStopArg: "keepGoing",
    discoveryTool: "list_commands",
    discoveryFilterArg: "query",
    discoveryEnabledArg: null,
    documentTools: {
      new: "new_document",
      open: "open_document",
      save: "save_document",
      inspect: "inspect_document",
    },
    enforcesRoots: false,
  },
};

/* ────────────────────────────────────────────────────────────────────────────
 * 2. THE MASTER SCHEMA (mcp.fleet.json)
 *
 * The schema is the contract: a fleet that does not parse is not a fleet.
 * The cross-field rules at the bottom are the ones that actually bite — an
 * allow-list that overlaps a deny-list, or a role that widens the sandbox
 * past the fleet default, is a policy mistake that no later stage can undo.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Every root is an absolute POSIX path. */
const AbsolutePath = z.string().regex(/^\/\S*$/, "roots must be absolute POSIX paths");

/**
 * An environment value is always a pointer into the studio's secret vault.
 * A literal secret in the master file would end up in three IDE configs and
 * in every workstation's shell history.
 */
const VaultRef = z.string().regex(/^\{\{vault:[A-Za-z0-9_./-]+\}\}$/, "env values must be vault pointers");

const ServerSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{2,40}$/),
  app: AppSchema,
  binary: z.string().regex(/^[a-z][a-z0-9]*-cli$/),
  mode: z.literal("mcp"),
  readRoots: z.array(AbsolutePath).min(1),
  writeRoots: z.array(AbsolutePath).min(1),
  env: z.record(z.string(), VaultRef).default({}),
});

const CapabilitySchema = z.object({
  /** Commands the role may run without a human in the loop. */
  allow: z.array(z.string().min(1)).default([]),
  /** Commands the role may never run. */
  deny: z.array(z.string().min(1)).default([]),
  /** Commands the role may run only with an approval token. */
  requireApproval: z.array(z.string().min(1)).default([]),
  /** Per-role narrowing of the server's sandbox. Never a widening. */
  readRoots: z.array(AbsolutePath).optional(),
  writeRoots: z.array(AbsolutePath).optional(),
});

const RoleCapabilitiesSchema = z.record(z.string(), CapabilitySchema);

const FleetSchema = z
  .object({
    $schema: z.string().optional(),
    fleet: z.object({
      studio: z.string().min(1),
      vaultUri: z.string().startsWith("vault://"),
      /** The id of the HMAC key in the vault that signs the envelope. */
      keyRef: z.string().regex(/^[a-z0-9][a-z0-9-]*$/),
      defaultReadRoots: z.array(AbsolutePath).min(1),
      defaultWriteRoots: z.array(AbsolutePath).min(1),
      generatorVersion: z.string().regex(/^\d+\.\d+\.\d+$/),
    }),
    roles: z.array(z.string().regex(/^[a-z][a-z0-9-]*$/)).min(1),
    servers: z.array(ServerSchema).min(1),
    capabilities: z.record(z.string(), RoleCapabilitiesSchema),
  })
  .superRefine((fleet, ctx) => {
    const servers = new Map(fleet.servers.map((s) => [s.id, s] as const));
    if (servers.size !== fleet.servers.length) {
      ctx.addIssue({
        code: "custom",
        path: ["servers"],
        message: "server ids must be unique",
      });
    }
    if (new Set(fleet.roles).size !== fleet.roles.length) {
      ctx.addIssue({ code: "custom", path: ["roles"], message: "role names must be unique" });
    }

    for (const server of fleet.servers) {
      if (server.binary !== `${server.app}-cli`) {
        ctx.addIssue({
          code: "custom",
          path: ["servers", server.id, "binary"],
          message: `binary must be "${server.app}-cli"`,
        });
      }
      for (const root of server.readRoots) {
        if (!isInsideAny(root, fleet.fleet.defaultReadRoots)) {
          ctx.addIssue({
            code: "custom",
            path: ["servers", server.id, "readRoots"],
            message: `root ${root} is outside the fleet read defaults`,
          });
        }
      }
      for (const root of server.writeRoots) {
        if (!isInsideAny(root, fleet.fleet.defaultWriteRoots)) {
          ctx.addIssue({
            code: "custom",
            path: ["servers", server.id, "writeRoots"],
            message: `root ${root} is outside the fleet write defaults`,
          });
        }
      }
    }

    for (const role of fleet.roles) {
      const caps = fleet.capabilities[role];
      if (!caps) {
        ctx.addIssue({
          code: "custom",
          path: ["capabilities", role],
          message: `role "${role}" has no capability block`,
        });
        continue;
      }
      for (const [serverId, cap] of Object.entries(caps)) {
        const server = servers.get(serverId);
        if (!server) {
          ctx.addIssue({
            code: "custom",
            path: ["capabilities", role, serverId],
            message: `unknown server "${serverId}"`,
          });
          continue;
        }
        const denied = new Set(cap.deny);
        for (const id of [...cap.allow, ...cap.requireApproval]) {
          if (denied.has(id)) {
            ctx.addIssue({
              code: "custom",
              path: ["capabilities", role, serverId],
              message: `command "${id}" is both allowed and denied`,
            });
          }
        }
        // A role may narrow a server's sandbox, never widen it.
        for (const root of cap.readRoots ?? []) {
          if (!isInsideAny(root, server.readRoots)) {
            ctx.addIssue({
              code: "custom",
              path: ["capabilities", role, serverId, "readRoots"],
              message: `role root ${root} is outside the server's read roots`,
            });
          }
        }
        for (const root of cap.writeRoots ?? []) {
          if (!isInsideAny(root, server.writeRoots)) {
            ctx.addIssue({
              code: "custom",
              path: ["capabilities", role, serverId, "writeRoots"],
              message: `role root ${root} is outside the server's write roots`,
            });
          }
        }
      }
    }

    for (const role of Object.keys(fleet.capabilities)) {
      if (!fleet.roles.includes(role)) {
        ctx.addIssue({
          code: "custom",
          path: ["capabilities", role],
          message: `capability block for undeclared role "${role}"`,
        });
      }
    }
  });

export type Fleet = z.infer<typeof FleetSchema>;
export type ServerEntry = z.infer<typeof ServerSchema>;
export type Capability = z.infer<typeof CapabilitySchema>;

/** True when `root` is `parent` itself or lives underneath it. */
export function isInside(root: string, parent: string): boolean {
  return root === parent || root.startsWith(parent.endsWith("/") ? parent : `${parent}/`);
}

function isInsideAny(root: string, parents: readonly string[]): boolean {
  return parents.some((parent) => isInside(root, parent));
}

/* ────────────────────────────────────────────────────────────────────────────
 * 3. CANONICAL JSON AND DIGESTS
 *
 * Every digest in the lock is taken over the canonical form of a value:
 * object keys sorted, no whitespace, arrays left in the order they are
 * given. Two workstations that hold the same policy therefore agree on the
 * digest, and a policy file that has merely been re-indented keeps its
 * signature.
 * ──────────────────────────────────────────────────────────────────────────── */

/** Stable stringify: sorted keys, no whitespace, array order preserved. */
export function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  const parts: string[] = [];
  for (const key of keys) {
    const member = record[key];
    if (member === undefined) continue;
    parts.push(`${JSON.stringify(key)}:${canonical(member)}`);
  }
  return `{${parts.join(",")}}`;
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** The normalised form of a capability block: sorted lists, absent roots as null. */
function normaliseCapability(cap: Capability): Record<string, unknown> {
  return {
    allow: [...cap.allow].sort(),
    deny: [...cap.deny].sort(),
    requireApproval: [...cap.requireApproval].sort(),
    readRoots: cap.readRoots === undefined ? null : [...cap.readRoots].sort(),
    writeRoots: cap.writeRoots === undefined ? null : [...cap.writeRoots].sort(),
  };
}

/**
 * The digest of one role's whole capability map.
 *
 * It binds a role to every server it can reach, so a workstation that claims
 * a role can be checked by re-hashing the master for that role — no vault
 * access, no engine running.
 */
export function roleCapabilitiesSha256(fleet: Fleet, role: string): string {
  const caps = fleet.capabilities[role] ?? {};
  const normalised: Record<string, unknown> = {};
  for (const serverId of Object.keys(caps).sort()) {
    const cap = caps[serverId];
    if (cap !== undefined) normalised[serverId] = normaliseCapability(cap);
  }
  return sha256Hex(canonical(normalised));
}

/* ────────────────────────────────────────────────────────────────────────────
 * 4. THE RESOLUTION
 *
 * The master says what the studio wants; the resolution is what the studio
 * will actually get. Every role × server pair is resolved to concrete roots,
 * concrete capability sets and the engine dialect that will carry them.
 * ──────────────────────────────────────────────────────────────────────────── */

export type RootEnforcement = "engine" | "worker";

export interface Sandbox {
  /** Who polices the roots: the engine itself, or the worker in front of it. */
  readonly enforcedBy: RootEnforcement;
  /** The flags actually handed to the engine. Empty when it does not police the roots. */
  readonly engineFlags: readonly string[];
  /** The worker always polices the roots as well, engine or not. */
  readonly workerEnforced: boolean;
}

export interface ResolvedServer {
  readonly role: string;
  readonly server: string;
  readonly app: App;
  readonly binary: string;
  readonly readRoots: readonly string[];
  readonly writeRoots: readonly string[];
  /** The primary root — the one an engine that takes a single directory gets. */
  readonly readRoot: string;
  readonly writeRoot: string;
  readonly allow: readonly string[];
  readonly deny: readonly string[];
  readonly requireApproval: readonly string[];
  /** Allow plus the approval-gated commands: everything the role may reach. */
  readonly effectiveAllow: readonly string[];
  readonly surface: EngineSurface;
  readonly sandbox: Sandbox;
}

/** The engine's sandbox flags, or an empty list when the engine rejects them. */
export function engineSandboxFlags(surface: EngineSurface, readRoot: string, writeRoot: string): string[] {
  if (!surface.enforcesRoots) return [];
  return ["--automation-read-root", readRoot, "--automation-write-root", writeRoot];
}

/** Resolve every role × server pair of the fleet, in a stable order. */
export function resolveFleet(fleet: Fleet): ResolvedServer[] {
  const resolved: ResolvedServer[] = [];
  for (const role of [...fleet.roles].sort()) {
    for (const server of resolveRole(fleet, role)) resolved.push(server);
  }
  return resolved;
}

/** Resolve the servers one role can reach. */
export function resolveRole(fleet: Fleet, role: string): ResolvedServer[] {
  const caps = fleet.capabilities[role];
  if (!caps) throw new Error(`no capability block for role "${role}"`);
  const out: ResolvedServer[] = [];
  for (const server of fleet.servers) {
    const cap = caps[server.id];
    if (!cap) continue; // the role cannot see this server at all
    const surface = ENGINE_SURFACES[server.app];
    const readRoots = [...(cap.readRoots ?? server.readRoots)].sort();
    const writeRoots = [...(cap.writeRoots ?? server.writeRoots)].sort();
    const readRoot = readRoots[0] ?? fleet.fleet.defaultReadRoots[0] ?? "/";
    const writeRoot = writeRoots[0] ?? fleet.fleet.defaultWriteRoots[0] ?? "/";
    const allow = [...cap.allow].sort();
    const deny = [...cap.deny].sort();
    const requireApproval = [...cap.requireApproval].sort();
    const effectiveAllow = [...new Set([...allow, ...requireApproval])].sort();
    out.push({
      role,
      server: server.id,
      app: server.app,
      binary: server.binary,
      readRoots,
      writeRoots,
      readRoot,
      writeRoot,
      allow,
      deny,
      requireApproval,
      effectiveAllow,
      surface,
      sandbox: {
        enforcedBy: surface.enforcesRoots ? "engine" : "worker",
        engineFlags: engineSandboxFlags(surface, readRoot, writeRoot),
        workerEnforced: true,
      },
    });
  }
  return out.sort((a, b) => (a.server < b.server ? -1 : a.server > b.server ? 1 : 0));
}

/** The digest of one resolved server's capability set. */
export function serverCapabilitiesSha256(resolved: ResolvedServer): string {
  return sha256Hex(
    canonical({
      allow: resolved.allow,
      deny: resolved.deny,
      requireApproval: resolved.requireApproval,
      readRoots: resolved.readRoots,
      writeRoots: resolved.writeRoots,
    }),
  );
}

/* ────────────────────────────────────────────────────────────────────────────
 * 5. THE SHIM CONTRACT
 *
 * Cursor and Claude Code cannot subtract tools from an MCP registry: both
 * surface the engine's full command list through the discovery tool, and
 * `command_run { id }` will happily run anything the engine exposes. The
 * only seam left is the worker: a shim binary that presents itself to the
 * IDE, forwards the stdio stream to the real engine, and refuses the calls
 * the policy refuses.
 *
 *   mcp-shim
 *     --app            <app>
 *     --real-binary    <absolute path to <app>-cli>
 *     --server         <server id>
 *     --role           <role name>
 *     --read-root      <absolute>
 *     --write-root     <absolute>
 *     --cap-hash       <sha256(roleCapabilities)>
 *     --fleet-lock     <path to mcp.fleet.lock.json>
 *     --vault-key-ref  <key id>
 *     --
 *     mcp  [the engine's own flags, e.g. --automation-read-root DIR]
 *
 * The shim strips everything before `--`, checks its own arguments against
 * the lock file, and then dispatches. Three things happen on the way:
 *
 * - On a "run one" call it decodes the command id out of the engine's own
 *   argument name — `id` for `command_run`, `command` for `execute` and
 *   `execute_command` — and refuses it when it is denied (40) or when it is
 *   approval-gated and no approval token came with the request (41).
 * - On a "run many" call it applies the same rule to every step.
 * - On a discovery call it rewrites the registry it returns, so the IDE sees
 *   the role's allow-list and not the engine's full command table.
 *
 * The exit codes are the shim's contract with the IDE: 0 is a clean exit,
 * and 40..44 are the five ways a governed call fails.
 * ──────────────────────────────────────────────────────────────────────────── */

export const SHIM_EXIT = {
  /** The session ended cleanly. */
  OK: 0,
  /** The request named a denied command. */
  DENIED_COMMAND: 40,
  /** The command needs an approval token that the request did not carry. */
  APPROVAL_REQUIRED: 41,
  /** The request touched a path outside the read or write root. */
  SANDBOX_VIOLATION: 42,
  /** The lock file does not describe the role the shim was started with. */
  LOCK_MISMATCH: 43,
  /** The compiled-in capability hash is not the one in the lock file. */
  CAPABILITY_MISMATCH: 44,
} as const;

export type ShimExit = (typeof SHIM_EXIT)[keyof typeof SHIM_EXIT];

/* ────────────────────────────────────────────────────────────────────────────
 * 6. THE DERIVATIONS
 *
 * All three surfaces get the same envelope: the shim is the command, the
 * policy travels in the arguments, and the environment carries vault
 * pointers only. What differs is the file each surface reads and whether the
 * surface can gate a whole server.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface ServerConfig {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface CursorConfig {
  mcpServers: Record<string, ServerConfig>;
}

/** Claude Code reads the same `mcpServers` envelope, from a different file. */
export type ClaudeConfig = CursorConfig;

export interface OpenCodeConfig {
  $schema: string;
  mcp: Record<string, ServerConfig & { type: "stdio"; enabled: boolean }>;
}

/** Locate a binary on PATH so the shim can be pointed at an absolute path. */
export function resolveOnPath(binary: string): string {
  if (binary.includes("/")) return binary;
  for (const dir of (process.env["PATH"] ?? "").split(":")) {
    if (!dir) continue;
    const candidate = join(dir, binary);
    if (!existsSync(candidate)) continue;
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not executable — keep looking.
    }
  }
  return binary;
}

/** The shim invocation for one resolved server. */
export function shimInvocation(
  fleet: Fleet,
  resolved: ResolvedServer,
  server: ServerEntry,
  shimPath: string,
  lockPath: string,
): ServerConfig {
  return {
    command: shimPath,
    args: [
      "--app",
      resolved.app,
      "--real-binary",
      resolveOnPath(server.binary),
      "--server",
      resolved.server,
      "--role",
      resolved.role,
      "--read-root",
      resolved.readRoot,
      "--write-root",
      resolved.writeRoot,
      "--cap-hash",
      roleCapabilitiesSha256(fleet, resolved.role),
      "--fleet-lock",
      lockPath,
      "--vault-key-ref",
      fleet.fleet.keyRef,
      "--",
      "mcp",
      ...resolved.sandbox.engineFlags,
    ],
    env: { ...server.env },
  };
}

/**
 * Cursor: `.cursor/mcp.json`.
 *
 * Cursor has no way to hide a tool, so the shim carries the policy. The
 * environment holds vault pointers — the shim dereferences them at spawn
 * time, and the plaintext never reaches the config file.
 */
export function deriveCursor(
  fleet: Fleet,
  role: string,
  shimPath: string,
  lockPath: string,
): CursorConfig {
  const mcpServers: Record<string, ServerConfig> = {};
  for (const resolved of resolveRole(fleet, role)) {
    const server = fleet.servers.find((s) => s.id === resolved.server);
    if (!server) continue;
    mcpServers[resolved.server] = shimInvocation(fleet, resolved, server, shimPath, lockPath);
  }
  return { mcpServers };
}

/**
 * Claude Code: the project-scoped `.mcp.json`.
 *
 * The studio deliberately does not run `claude mcp add --scope user`: a user
 * scope leaks a role into every other project on the machine, and it is not
 * derivable from a repo-local policy file, so CI cannot re-verify it. The
 * project scope is the only scope a role may use.
 *
 * Claude Code keeps the project-scoped catalogue in two places — the
 * repo-local `.mcp.json`, and the `projects["<project path>"].mcpServers`
 * entry of the user's `~/.claude.json`. The generator writes the repo-local
 * file, because that is the artefact a commit can carry and a compliance
 * bot can diff; the user-level mirror is a workstation detail that the
 * operator installs from it.
 */
export function deriveClaudeCode(
  fleet: Fleet,
  role: string,
  shimPath: string,
  lockPath: string,
): ClaudeConfig {
  return deriveCursor(fleet, role, shimPath, lockPath);
}

/**
 * OpenCode: `opencode.json`.
 *
 * OpenCode is the one surface that can hide a whole server, so every server
 * of the fleet is listed and the ones the role cannot reach are switched off.
 * Inside an enabled server the deny-list still has to be enforced by the
 * shim, so the shim stays.
 */
export function deriveOpenCode(
  fleet: Fleet,
  role: string,
  shimPath: string,
  lockPath: string,
): OpenCodeConfig {
  const mcp: Record<string, ServerConfig & { type: "stdio"; enabled: boolean }> = {};
  const reachable = new Map(resolveRole(fleet, role).map((r) => [r.server, r]));
  for (const server of fleet.servers) {
    const resolved = reachable.get(server.id);
    const config = resolved
      ? shimInvocation(fleet, resolved, server, shimPath, lockPath)
      : { command: shimPath, args: [], env: { ...server.env } };
    mcp[server.id] = {
      type: "stdio",
      ...config,
      enabled: resolved !== undefined && resolved.effectiveAllow.length > 0,
    };
  }
  return { $schema: "https://opencode.ai/config.json", mcp };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 7. THE AUDIT ENVELOPE
 *
 * `mcp.fleet.lock.json` is the authoritative resolution. It carries one entry
 * per role × server pair, and every entry carries the envelope's signature:
 * a per-entry signature would only prove the entry, while a fleet is only
 * governed as a whole. The signature is taken over the canonical body of the
 * envelope with the signature fields removed, which is the same detached-
 * payload trick a JWS uses and which removes the self-reference problem.
 * ──────────────────────────────────────────────────────────────────────────── */

const LockEntrySchema = z.object({
  server: z.string().min(1),
  app: AppSchema,
  binary: z.string().min(1),
  role: z.string().min(1),
  readRoot: z.string().min(1),
  writeRoot: z.string().min(1),
  readRoots: z.array(z.string().min(1)),
  writeRoots: z.array(z.string().min(1)),
  sha256RoleCapabilities: z.string().regex(/^[0-9a-f]{64}$/),
  sha256ServerCapabilities: z.string().regex(/^[0-9a-f]{64}$/),
  generatorVersion: z.string().min(1),
  generatedAt: z.string().min(1),
  sandbox: z.object({
    enforcedBy: z.union([z.literal("engine"), z.literal("worker")]),
    engineFlags: z.array(z.string().min(1)),
    workerEnforced: z.boolean(),
  }),
  surface: SurfaceSchema,
  capabilities: z.object({
    allow: z.array(z.string().min(1)),
    deny: z.array(z.string().min(1)),
    requireApproval: z.array(z.string().min(1)),
    effectiveAllow: z.array(z.string().min(1)),
  }),
  signature: z.string().regex(/^[0-9a-f]{64}$/),
});

const LockEnvelopeSchema = z.object({
  envelopeVersion: z.literal("1"),
  studio: z.string().min(1),
  generatorVersion: z.string().min(1),
  generatedAt: z.string().min(1),
  roles: z.array(z.string().min(1)),
  entries: z.array(LockEntrySchema),
  signature: z.string().regex(/^[0-9a-f]{64}$/),
});

export type LockEntry = z.infer<typeof LockEntrySchema>;
export type LockEnvelope = z.infer<typeof LockEnvelopeSchema>;

/** The part of the envelope the signature is taken over. */
function envelopeBody(lock: LockEnvelope): Record<string, unknown> {
  const { signature: _signature, entries, ...rest } = lock;
  return {
    ...rest,
    entries: entries.map((entry) => {
      const { signature: _entrySignature, ...body } = entry;
      return body;
    }),
  };
}

/** Build the signed envelope for the whole fleet. */
export function buildLock(fleet: Fleet, secret: Buffer, now: () => string): LockEnvelope {
  const generatedAt = now();
  const resolved = resolveFleet(fleet);
  const entries: Omit<LockEntry, "signature">[] = resolved.map((r) => {
    const server = fleet.servers.find((s) => s.id === r.server);
    if (!server) throw new Error(`unknown server "${r.server}"`);
    return {
      server: r.server,
      app: r.app,
      binary: r.binary,
      role: r.role,
      readRoot: r.readRoot,
      writeRoot: r.writeRoot,
      readRoots: [...r.readRoots],
      writeRoots: [...r.writeRoots],
      sha256RoleCapabilities: roleCapabilitiesSha256(fleet, r.role),
      sha256ServerCapabilities: serverCapabilitiesSha256(r),
      generatorVersion: fleet.fleet.generatorVersion,
      generatedAt,
      sandbox: {
        enforcedBy: r.sandbox.enforcedBy,
        engineFlags: [...r.sandbox.engineFlags],
        workerEnforced: r.sandbox.workerEnforced,
      },
      surface: r.surface,
      capabilities: {
        allow: [...r.allow],
        deny: [...r.deny],
        requireApproval: [...r.requireApproval],
        effectiveAllow: [...r.effectiveAllow],
      },
    };
  });

  const body = {
    envelopeVersion: "1" as const,
    studio: fleet.fleet.studio,
    generatorVersion: fleet.fleet.generatorVersion,
    generatedAt,
    roles: [...fleet.roles].sort(),
    entries,
  };
  const signature = createHmac("sha256", secret).update(canonical(body)).digest("hex");
  return {
    ...body,
    entries: entries.map((entry) => ({ ...entry, signature })),
    signature,
  };
}

/**
 * Verify the envelope's signature on its own.
 *
 * A compliance bot needs no vault access to run this: it needs the key the
 * vault handed out for the fleet, and the lock file.
 */
export function verifyLockSignature(lock: LockEnvelope, secret: Buffer): void {
  const expected = createHmac("sha256", secret)
    .update(canonical(envelopeBody(lock)))
    .digest("hex");
  if (expected !== lock.signature) {
    throw new Error("envelope signature mismatch");
  }
  for (const entry of lock.entries) {
    if (entry.signature !== lock.signature) {
      throw new Error(`entry "${entry.role}/${entry.server}" carries a foreign signature`);
    }
  }
}

/**
 * Verify the envelope against the master: signature, digests, roots and
 * engine dialects. This is the check that catches drift between the policy
 * file and the workstations that were built from it.
 */
export function verifyLockAgainstFleet(lock: LockEnvelope, fleet: Fleet, secret: Buffer): void {
  verifyLockSignature(lock, secret);

  const expected = new Map<string, ResolvedServer>(
    resolveFleet(fleet).map((r) => [`${r.role}/${r.server}`, r]),
  );
  if (expected.size !== lock.entries.length) {
    throw new Error(`envelope has ${lock.entries.length} entries, expected ${expected.size}`);
  }

  for (const entry of lock.entries) {
    const key = `${entry.role}/${entry.server}`;
    const resolved = expected.get(key);
    if (!resolved) throw new Error(`envelope carries an unknown pair: ${key}`);

    if (entry.sha256RoleCapabilities !== roleCapabilitiesSha256(fleet, entry.role)) {
      throw new Error(`capability drift for ${key}`);
    }
    if (entry.sha256ServerCapabilities !== serverCapabilitiesSha256(resolved)) {
      throw new Error(`server capability drift for ${key}`);
    }
    if (entry.readRoot !== resolved.readRoot || entry.writeRoot !== resolved.writeRoot) {
      throw new Error(`sandbox drift for ${key}`);
    }
    if (entry.sandbox.enforcedBy !== resolved.sandbox.enforcedBy) {
      throw new Error(`sandbox enforcement drift for ${key}`);
    }
    const surface = ENGINE_SURFACES[entry.app];
    if (entry.surface.runTool !== surface.runTool || entry.surface.discoveryTool !== surface.discoveryTool) {
      throw new Error(`engine dialect drift for ${key}`);
    }
    if (entry.capabilities.effectiveAllow.join(",") !== resolved.effectiveAllow.join(",")) {
      throw new Error(`capability set drift for ${key}`);
    }
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * 8. THE DRIVER
 * ──────────────────────────────────────────────────────────────────────────── */

export interface GenerateOptions {
  /** Path to the master `mcp.fleet.json`. */
  readonly fleetPath: string;
  /** Directory the artefacts are written to. */
  readonly outDir: string;
  /** The HMAC key the envelope is signed with. */
  readonly secret: Buffer;
  /** The clock. Injectable so a build can be reproduced byte for byte. */
  readonly now?: () => string;
  /** Where the shim lives. Defaults to `<outDir>/bin/mcp-shim`. */
  readonly shimPath?: string;
  /** The roles to provision stations for. Defaults to every role. */
  readonly roles?: readonly string[];
}

export interface Station {
  readonly role: string;
  readonly cursor: CursorConfig;
  readonly claude: ClaudeConfig;
  readonly opencode: OpenCodeConfig;
}

export interface GeneratedFleet {
  readonly fleet: Fleet;
  readonly lock: LockEnvelope;
  readonly resolution: readonly ResolvedServer[];
  readonly stations: Readonly<Record<string, Station>>;
  /** Every written file, keyed by its path relative to `outDir`. */
  readonly files: Readonly<Record<string, string>>;
}

/** The class of error the generator raises for a policy that does not hold. */
export class FleetValidationError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`invalid mcp.fleet.json:\n${issues.map((i) => `  - ${i}`).join("\n")}`);
    this.name = "FleetValidationError";
    this.issues = issues;
  }
}

/** Parse a JSON document that may carry `//` and block comments. */
export function parseJsonc(text: string): unknown {
  let out = "";
  let inString = false;
  let inLineComment = false;
  let inBlockComment = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text.charAt(i);
    const next = text.charAt(i + 1);

    if (inLineComment) {
      if (char === "\n") {
        inLineComment = false;
        out += char;
      }
      continue;
    }
    if (inBlockComment) {
      if (char === "*" && next === "/") {
        inBlockComment = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += char;
      if (char === "\\") {
        out += text.charAt(i + 1);
        i += 1;
        continue;
      }
      if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      continue;
    }
    if (char === "/" && next === "/") {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (char === "/" && next === "*") {
      inBlockComment = true;
      i += 1;
      continue;
    }
    out += char;
  }
  return JSON.parse(out) as unknown;
}

/** Parse and validate the master policy. */
export function parseFleet(text: string): Fleet {
  let raw: unknown;
  try {
    raw = parseJsonc(text);
  } catch (error) {
    throw new FleetValidationError([`the file is not valid JSON: ${String(error)}`]);
  }
  const result = FleetSchema.safeParse(raw);
  if (!result.success) {
    throw new FleetValidationError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    );
  }
  return result.data;
}

/**
 * Parse and validate a lock file.
 *
 * This is the compliance bot's entry point: it reads the envelope off the
 * disk, checks that it is well formed, and then verifies its signature.
 */
export function parseLock(text: string): LockEnvelope {
  let raw: unknown;
  try {
    raw = parseJsonc(text);
  } catch (error) {
    throw new FleetValidationError([`the lock file is not valid JSON: ${String(error)}`]);
  }
  const result = LockEnvelopeSchema.safeParse(raw);
  if (!result.success) {
    throw new FleetValidationError(
      result.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`),
    );
  }
  return result.data;
}

function writeJson(path: string, value: unknown): string {
  mkdirSync(resolve(path, ".."), { recursive: true });
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(path, text, "utf8");
  return text;
}

/**
 * Project the master policy onto every artefact.
 *
 * The clock is injected rather than read, so the same policy file and the
 * same key always produce the same bytes — which is what lets a compliance
 * bot diff a workstation against the lock instead of re-deriving it.
 */
export function generateFleet(options: GenerateOptions): GeneratedFleet {
  const fleet = parseFleet(readFileSync(options.fleetPath, "utf8"));
  const now = options.now ?? (() => new Date().toISOString());
  const outDir = resolve(options.outDir);
  const shimPath = options.shimPath ?? resolve(outDir, "bin", "mcp-shim");
  const lockPath = resolve(outDir, "mcp.fleet.lock.json");

  const roles = options.roles ?? [...fleet.roles].sort();
  for (const role of roles) {
    if (!fleet.roles.includes(role)) throw new Error(`unknown role: ${role}`);
  }

  const lock = buildLock(fleet, options.secret, now);

  const files: Record<string, string> = {};
  const stations: Record<string, Station> = {};

  files["mcp.fleet.lock.json"] = sha256Hex(writeJson(lockPath, lock));

  for (const role of roles) {
    const stationDir = resolve(outDir, "stations", role);
    const cursor = deriveCursor(fleet, role, shimPath, lockPath);
    const claude = deriveClaudeCode(fleet, role, shimPath, lockPath);
    const opencode = deriveOpenCode(fleet, role, shimPath, lockPath);

    stations[role] = { role, cursor, claude, opencode };

    files[`stations/${role}/.cursor/mcp.json`] = sha256Hex(
      writeJson(resolve(stationDir, ".cursor", "mcp.json"), cursor),
    );
    files[`stations/${role}/.mcp.json`] = sha256Hex(
      writeJson(resolve(stationDir, ".mcp.json"), claude),
    );
    files[`stations/${role}/opencode.json`] = sha256Hex(
      writeJson(resolve(stationDir, "opencode.json"), opencode),
    );
  }

  // The manifest lets a compliance bot prove that nothing was touched after
  // the build without needing the vault key.
  const manifest = Object.entries(files)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([path, digest]) => `${digest}  ${path}`)
    .join("\n");
  writeFileSync(resolve(outDir, "mcp.fleet.manifest.sha256"), `${manifest}\n`, "utf8");

  return { fleet, lock, resolution: resolveFleet(fleet), stations, files };
}

/* ────────────────────────────────────────────────────────────────────────────
 * 9. THE LIVE REGISTRY ASSERTION
 *
 * The shim rewrites the registry the IDE sees, so the compliance bot's check
 * is on the *shimmed* surface: the ids the engine reports must be a subset
 * of the role's effective allow-list. The discovery tool and its argument
 * names come from the engine registry, because each engine spells them
 * differently.
 * ──────────────────────────────────────────────────────────────────────────── */

export interface McpCaller {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export interface RegistryCheckOptions {
  /**
   * An optional narrowing of the registry. It is sent under the engine's own
   * argument name — `filter` in most engines, `query` in WordCraft.
   */
  readonly filter?: string;
}

/** Unwrap an MCP tool reply: the payload is a JSON string in a text block. */
function unwrapContent(reply: unknown): unknown {
  if (reply === null || typeof reply !== "object") return reply;
  const content = (reply as Record<string, unknown>)["content"];
  if (!Array.isArray(content)) return reply;
  for (const block of content) {
    if (block === null || typeof block !== "object") continue;
    const text = (block as Record<string, unknown>)["text"];
    if (typeof text !== "string") continue;
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return reply;
}

/** Read the command ids out of a discovery reply, whatever shape it has. */
export function registryIds(reply: unknown): string[] {
  const payload = unwrapContent(reply);
  const containers: unknown[] = [];
  if (payload !== null && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    containers.push(record["commands"], record["engine_commands"]);
  }
  containers.push(payload);
  for (const container of containers) {
    if (!Array.isArray(container)) continue;
    const ids: string[] = [];
    for (const item of container) {
      if (item !== null && typeof item === "object") {
        const id = (item as Record<string, unknown>)["id"];
        if (typeof id === "string") ids.push(id);
      }
    }
    if (ids.length > 0) return ids;
  }
  return [];
}

/**
 * Assert that the registry a role can see is a subset of its allow-list.
 *
 * The discovery call is built from the engine's own dialect: WordCraft's
 * registry is `list_commands { query }` and has no "enabled only" switch at
 * all, and DesignCraft's is `list_commands { filter, enabledOnly }`.
 */
export async function assertRegistrySubset(
  mcp: McpCaller,
  app: App,
  effectiveAllow: ReadonlySet<string>,
  options: RegistryCheckOptions = {},
): Promise<{ app: App; tool: string; count: number }> {
  const surface = ENGINE_SURFACES[app];
  const args: Record<string, unknown> = {};
  if (options.filter !== undefined && surface.discoveryFilterArg !== null) {
    args[surface.discoveryFilterArg] = options.filter;
  }
  if (surface.discoveryEnabledArg !== null) args[surface.discoveryEnabledArg] = true;

  const reply = await mcp.callTool(surface.discoveryTool, args);
  const ids = registryIds(reply);
  const leaked = ids.filter((id) => !effectiveAllow.has(id));
  if (leaked.length > 0) {
    throw new Error(
      `${app}: registry leaked ${leaked.length} command ids outside the role's allow-list: ${leaked
        .slice(0, 5)
        .join(", ")}`,
    );
  }
  return { app, tool: surface.discoveryTool, count: ids.length };
}
