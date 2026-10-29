// src/policy/schema.ts
import { z } from "zod";

/**
 * A Craft binding describes one ArtCraft application (PhotoCraft, FilmCraft, …)
 * as it is reachable from the studio. The `binary` field is the CLI entry point;
 * `args` is the fixed argv with which the MCP server should be spawned, and
 * `roots` scopes its filesystem sandbox — through the `--automation-read-root`
 * and `--automation-write-root` flags for the engines that accept them, and
 * through the spawn's working directory for the ones that do not.
 */
export const CraftBinding = z.object({
  /** Stable logical name used in policy references (e.g. "photocraft"). */
  id: z.string().regex(/^[a-z][a-z0-9_-]{1,31}$/),
  /** Absolute path or PATH-resolved executable name. */
  binary: z.string().min(1),
  /** Fixed argv passed before the server is initialised. */
  args: z.array(z.string()).default([]),
  /** Filesystem sandbox. Both roots must exist and must be absolute. */
  roots: z.object({
    read: z.array(z.string()).min(1),
    write: z.array(z.string()).min(1),
  }),
  /**
   * Whether the engine accepts `--automation-read-root` /
   * `--automation-write-root`.
   *
   * Only PhotoCraft, FilmCraft, VectorCraft and DeckCraft do. The others —
   * DesignCraft, LightCraft, WordCraft, PdfCraft and GridCraft — reject the
   * flags outright ("unknown option"), and they are bounded by their
   * *working directory* instead. A policy that projects the same roots
   * into every client has to know which is which, or the spawn fails.
   */
  sandboxFlags: z.boolean().default(true),
  /** Optional capability allow-list by command-id prefix. Empty = deny all. */
  allow: z.array(z.string()).default([]),
  /** Command-id prefixes that are always refused, even if allowed above. */
  deny: z.array(z.string()).default([]),
  /** Whether this Craft may receive ui_pointer / ui_set / ui_screenshot calls. */
  desktopControl: z.boolean().default(false),
  /** Environment variable names to resolve from the vault and inject at spawn. */
  secretEnv: z.array(z.string()).default([]),
});

export type CraftBinding = z.infer<typeof CraftBinding>;

/**
 * An AgentBinding maps one logical agent (e.g. "cursor:lead-designer",
 * "claude-code:ci-runner", "opencode:asset-pipeline") to the set of Crafts
 * it is permitted to talk to, and the role that governs its authorization.
 */
export const AgentBinding = z.object({
  id: z.string().min(1),
  /** Which shell compiles this binding: cursor | claude-code | opencode. */
  shell: z.enum(["cursor", "claude-code", "opencode"]),
  /** Role name looked up in the policy's roles table. */
  role: z.string().min(1),
  /** Craft ids this agent may invoke. */
  crafts: z.array(z.string()).min(1),
  /** Optional per-agent override of the role's command allow-list. */
  overrides: z
    .object({
      allow: z.array(z.string()).optional(),
      deny: z.array(z.string()).optional(),
      desktopControl: z.boolean().optional(),
    })
    .default({}),
  /** Environment variables this agent is allowed to see (subset of vault keys). */
  visibleSecrets: z.array(z.string()).default([]),
});

export type AgentBinding = z.infer<typeof AgentBinding>;

/**
 * A Role is a reusable authorization profile. Roles decouple the identity of
 * an agent (the person or process) from the set of capabilities it holds.
 */
export const Role = z.object({
  name: z.string().min(1),
  /** Command-id prefixes this role may run. `*` allows everything (audited). */
  allow: z.array(z.string()).min(1),
  /** Command-id prefixes that are prohibited regardless of the allow-list. */
  deny: z.array(z.string()).default([]),
  /** Whether the role may export to disk (doc_save with a path, file.exportPdf). */
  mayExport: z.boolean().default(false),
  /** Whether the role may call ui_pointer / ui_set / ui_screenshot on desktop. */
  mayDriveDesktop: z.boolean().default(false),
  /** If true, every command invocation is prefixed with an interactive ack. */
  requiresHumanInTheLoop: z.boolean().default(false),
});

export type Role = z.infer<typeof Role>;

/** The top-level Studio Policy object. */
export const StudioPolicy = z.object({
  $schema: z.string().url().optional(),
  version: z.literal("1.0"),
  /** Deterministic output directory for compiled agent configs. */
  workspace: z.string().min(1),
  crafts: z.array(CraftBinding).min(1),
  roles: z.array(Role).min(1),
  agents: z.array(AgentBinding).min(1),
  audit: z.object({
    /** Append-only JSONL log destination. */
    path: z.string().min(1),
    /** Whether to hash-chain the log (recommended). */
    chained: z.boolean().default(true),
    /** Whether to also emit a per-run bundle under workspace/runs/<id>/. */
    bundle: z.boolean().default(true),
  }),
  secrets: z.object({
    /** Ciphertext blob (AES-256-GCM) holding all studio secrets. */
    ciphertext: z.string().min(1),
    /** scrypt salt, base64. */
    salt: z.string().min(1),
    /** IV for the AES-GCM ciphertext, base64. */
    iv: z.string().min(1),
    /** AES-GCM auth tag, base64. */
    tag: z.string().min(1),
  }),
});

export type StudioPolicy = z.infer<typeof StudioPolicy>;
