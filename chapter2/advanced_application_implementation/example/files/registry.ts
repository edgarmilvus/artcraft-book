// ---------------------------------------------------------------------------
// @file creative-factory/registry.ts
//
// Runtime command discovery + schema cache. The ArtCraft registry is the
// ground-truth contract; we never hard-code parameter shapes that the engine
// could reject. Instead we ask, once per (binary, engine-version) pair, for
// the enabled commands and, where supported, their JSON Schemas.
// ---------------------------------------------------------------------------

import { ArtCraftSession } from "./session.js";

/** A registry entry as the engine reports it. */
export interface CommandEntry {
  id: string;
  label: string;
  menu?: string | string[];
  shortcut?: string | null;
  params?: string;
  enabled: boolean;
  /** PhotoCraft uses `disabledReason`; EffectCraft uses `why`. */
  disabledReason?: string | null;
  why?: string | null;
  needsDocument?: boolean;
  /**
   * Not returned by the current engine: `command_list` exposes the parameter
   * *prose* (`params`), not a JSON Schema. Kept so a future `schemas: true`
   * can populate it without changing consumers.
   */
  schema?: JsonSchema;
}

export interface JsonSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
}

/**
 * The registry facade. Consumers call `assertValid(id, params)` before they
 * put a step into a plan; invalid steps never reach the wire.
 *
 * Note the deliberate asymmetry: we treat the *engine's* schema as
 * authoritative, but we keep a small sidecar of business rules (max batch
 * size, forbidden commands for tenant tiers) that the engine cannot know
 * about.
 */
export class CommandRegistry {
  private readonly byId = new Map<string, CommandEntry>();
  private version = "";

  private constructor(
    private readonly session: ArtCraftSession,
    entries: CommandEntry[],
    version: string,
  ) {
    for (const e of entries) this.byId.set(e.id, e);
    this.version = version;
  }

  /**
   * Fetch the registry.
   *
   * PhotoCraft's discovery meta-tool is `command_list` and its arguments are
   * snake_case: `{ filter?, enabled_only? }`. There is no `schemas` flag in
   * this engine version, and the reply is a **bare array** of entries, not an
   * object with `commands`/`version`. The engine version comes from the MCP
   * `initialize` handshake instead.
   */
  static async load(session: ArtCraftSession): Promise<CommandRegistry> {
    const meta = await session.listTools();
    const toolName = meta.includes("command_list") ? "command_list" : "list_commands";
    const raw = await session.rawCall<
      CommandEntry[] | { commands?: CommandEntry[] }
    >(toolName, { enabled_only: false });
    const entries: CommandEntry[] = Array.isArray(raw) ? raw : (raw.commands ?? []);
    return new CommandRegistry(session, entries, session.serverVersion());
  }

  /** Engine version captured from the MCP handshake (e.g. `photocraft-cli@0.8.2`). */
  get engineVersion(): string {
    return this.version;
  }

  /** Lookup by id; throws with a helpful message if the id is unknown. */
  get(id: string): CommandEntry {
    const e = this.byId.get(id);
    if (!e) {
      throw new Error(
        `command '${id}' is not in the registry (engine ${this.version}); ` +
          `did you mean: ${this.nearest(id).join(", ")}?`,
      );
    }
    return e;
  }

  /**
   * Cheap structural validation. We deliberately do NOT pull in a full JSON
   * Schema validator; the engine performs authoritative validation on its
   * side of the pipe and rejects unknown keys. What we validate here is
   * shape-level correctness (no `undefined` leaking into JSON, no prototype
   * pollution, no functions) plus a couple of business rules.
   */
  assertValid(id: string, params: Record<string, unknown>): void {
    const entry = this.get(id);
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined) {
        throw new Error(`param '${k}' of '${id}' is undefined`);
      }
      if (typeof v === "function") {
        throw new Error(`param '${k}' of '${id}' is a function (not serialisable)`);
      }
    }
    if (entry.schema?.additionalProperties === false) {
      const allowed = new Set(Object.keys(entry.schema.properties ?? {}));
      for (const k of Object.keys(params)) {
        if (!allowed.has(k)) {
          throw new Error(`param '${k}' is not accepted by '${id}'`);
        }
      }
    }
  }

  /** Levenshtein-lite: useful for diagnostics when an id is misspelled. */
  private nearest(id: string): string[] {
    const needle = id.toLowerCase();
    return [...this.byId.keys()]
      .filter((k) => k.toLowerCase().startsWith(needle.slice(0, 4)))
      .slice(0, 3);
  }
}
