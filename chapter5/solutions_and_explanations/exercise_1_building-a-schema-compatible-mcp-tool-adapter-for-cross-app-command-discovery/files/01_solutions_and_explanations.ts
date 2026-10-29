// ============================================================================
// Exercise 1 — Cross-App Discovery Adapter
// ============================================================================
// The adapter is a *meta*-tool: it knows nothing about individual commands.
// All app-specific knowledge is confined to APP_SPECS (discovery shape) and
// the small params-string parser below.
// ============================================================================

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// 1. Contract types
// ---------------------------------------------------------------------------

export type AppId =
  | "photocraft" | "vectorcraft" | "filmcraft" | "effectcraft"
  | "designcraft" | "lightcraft" | "pdfcraft" | "wordcraft";

export interface NormalizedTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;   // JSON Schema 2020-12
  readonly commandId: string | null;
  readonly app: AppId;
  readonly looselyTyped: boolean;
  readonly enabledWithoutDoc: boolean;
  readonly _meta: {
    readonly isMetaTool: boolean;
    readonly rawParamsDoc: string;
    readonly disabledReason: string | null;
    readonly transport: "mcp-meta" | "engine-command";
  };
}

export interface SchemaPatch {
  readonly added: readonly NormalizedTool[];
  readonly removed: readonly string[];
  readonly changed: readonly { readonly name: string; readonly next: NormalizedTool }[];
}

export interface DiscoveryAdapter {
  discover(app: AppId): Promise<{ tools: readonly NormalizedTool[]; registryVersion: string }>;
  diff(prev: readonly NormalizedTool[], next: readonly NormalizedTool[]): SchemaPatch;
}

// ---------------------------------------------------------------------------
// 2. Per-app discovery specs — the ONLY place app-specific knowledge lives.
//    Every field cites the ground-truth meta-tool from the reference doc.
// ---------------------------------------------------------------------------

interface RawCommand {
  id: string;
  label?: string;
  menu?: string | string[];
  shortcut?: string | null;
  params?: string | Record<string, unknown> | null;
  enabled?: boolean;
  why?: string;
  disabled_reason?: string;
  tool?: string | null;    // PdfCraft: registry-id → MCP meta-tool map
  needsDocument?: boolean;
}

interface DiscoverSpec {
  readonly binary: string;
  readonly listTool: string;                // EXACT casing per app
  readonly listArgs: Record<string, unknown>; // EXACT arg casing per app
  /** Per-app launch flags. Not every server accepts the same sandbox flags. */
  readonly mcpArgs: (roots: { readRoot?: string; writeRoot?: string }) => string[];
  readonly extract: (raw: unknown) => RawCommand[];
}

/**
 * MCP tool replies arrive wrapped as `{ content: [{ type: "text", text }] }`
 * and the payload itself is JSON encoded as a string. Unwrap both layers so
 * the extractors below see the document the server actually returned.
 */
function unwrapToolResult(raw: unknown): unknown {
  const content = (raw as { content?: Array<{ type?: string; text?: string }> })?.content;
  if (!Array.isArray(content)) return raw;
  const text = content.find((c) => typeof c.text === "string")?.text;
  if (typeof text !== "string") return raw;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Registry listings differ per app: some return a bare array, others wrap it
 * in `commands` or in an `engine_commands` envelope.
 */
function extractCommands(r: unknown): RawCommand[] {
  if (Array.isArray(r)) return r as RawCommand[];
  const box = r as { commands?: RawCommand[]; engine_commands?: { commands?: RawCommand[] } };
  return box?.commands ?? box?.engine_commands?.commands ?? [];
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");

const APP_SPECS: Record<AppId, DiscoverSpec> = {
  designcraft: {
    binary: "designcraft-cli",
    // DesignCraft's headless server takes no sandbox flags: it confines to cwd.
    mcpArgs: () => [],
    listTool: "list_commands",              // DesignCraft uses camelCase args
    listArgs: { enabledOnly: false },
    extract: extractCommands,
  },
  photocraft: {
    binary: "photocraft-cli",
    mcpArgs: (r) => [
      "--automation-read-root", r.readRoot ?? ".",
      "--automation-write-root", r.writeRoot ?? ".",
    ],
    listTool: "command_list",               // PhotoCraft uses snake_case args
    listArgs: { enabled_only: false },
    extract: extractCommands,
  },
  effectcraft: {
    binary: "effectcraft-cli",
    // EffectCraft needs a project; `--demo` opens its headless sample project.
    mcpArgs: () => ["--demo"],
    listTool: "list_commands",              // EffectCraft: opt-in JSON schemas
    listArgs: { enabled_only: false, schemas: true },
    extract: extractCommands,
  },
  vectorcraft: {
    binary: "vectorcraft-cli",
    mcpArgs: (r) => [
      "--automation-read-root", r.readRoot ?? ".",
      "--automation-write-root", r.writeRoot ?? ".",
    ],
    listTool: "list_commands",              // VectorCraft: camelCase
    listArgs: { enabledOnly: false },
    extract: extractCommands,
  },
  filmcraft: {
    binary: "filmcraft-cli",
    mcpArgs: (r) => [
      "--automation-read-root", r.readRoot ?? ".",
      "--automation-write-root", r.writeRoot ?? ".",
    ],
    listTool: "command_list",               // FilmCraft uses command_list
    listArgs: { enabled_only: false },
    extract: extractCommands,
  },
  lightcraft: {
    binary: "lightcraft-cli",
    // LightCraft imports the files it is given and confines to cwd.
    mcpArgs: () => [],
    listTool: "command_list",               // LightCraft: command_list is canonical
    listArgs: { enabled_only: false },
    extract: extractCommands,
  },
  pdfcraft: {
    binary: "pdfcraft-cli",
    mcpArgs: (r) => ["--root", r.readRoot ?? "."],
    listTool: "command_list",               // PdfCraft uses command_list
    listArgs: { enabled_only: false },
    extract: extractCommands,
  },
  wordcraft: {
    binary: "wordcraft-cli",
    mcpArgs: (r) => [
      "--automation-read-root", r.readRoot ?? ".",
      "--automation-write-root", r.writeRoot ?? ".",
    ],
    listTool: "list_commands",              // WordCraft: query filter
    listArgs: {},
    extract: extractCommands,
  },
};

// ---------------------------------------------------------------------------
// 3. The params-doc parser. Best-effort, but never fabricates a required arg.
// ---------------------------------------------------------------------------

interface ValueSchema { schema: Record<string, unknown>; ok: boolean; }

function parseParamsDoc(doc: string | null | undefined):
  { schema: Record<string, unknown>; looselyTyped: boolean } {
  const EMPTY = { type: "object", properties: {}, additionalProperties: false };
  if (!doc || !doc.trim() || doc.trim() === "{}") {
    return { schema: EMPTY, looselyTyped: false };
  }

  const block = findBalancedBrace(doc);
  if (!block) {
    // No braces at all — free-form doc. Degrade but do not block.
    return { schema: { type: "object", additionalProperties: true }, looselyTyped: true };
  }

  try {
    const pairs = splitTopLevelCommas(block);
    const properties: Record<string, unknown> = {};
    const required: string[] = [];

    for (const raw of pairs) {
      const trimmed = raw.trim();
      if (!trimmed) continue;
      const { key, value } = splitAtTopLevelColon(trimmed);
      const optional = key.endsWith("?");
      const cleanKey = stripQuotes(optional ? key.slice(0, -1) : key);
      if (!cleanKey || cleanKey in properties) continue;

      const { schema, ok } = valueToSchema(value);
      if (!ok) {
        // One unparsable field ⇒ whole schema goes loose. We deliberately
        // refuse to guess: silently dropping a required argument would let
        // an LLM emit a command that fails at dispatch.
        return { schema: { type: "object", additionalProperties: true }, looselyTyped: true };
      }
      properties[cleanKey] = schema;
      if (!optional) required.push(cleanKey);
    }

    const out: Record<string, unknown> = {
      type: "object",
      properties,
      additionalProperties: false,
    };
    if (required.length) out.required = required;
    return { schema: out, looselyTyped: false };
  } catch {
    return { schema: { type: "object", additionalProperties: true }, looselyTyped: true };
  }
}

function valueToSchema(raw: string): ValueSchema {
  let v = raw.trim();

  // Strip a trailing default: "…=N" or "…=\"lit\"".
  let def: unknown;
  const eq = findUnbracketed(v, "=");
  if (eq >= 0) {
    def = parseLiteralOrDefault(v.slice(eq + 1).trim());
    v = v.slice(0, eq).trim();
  }

  // Strip prose tails (e.g. " (spread coords)").
  v = v.split(/\s+\(/)[0].trim();

  // Alternation a|b|c → anyOf.
  const alts = splitAlternation(v);
  if (alts.length > 1) {
    const anyOf = alts.map(a => valueToSchema(a).schema);
    return finish({ anyOf }, def);
  }

  // Numeric range lo..hi (either bound may be negative).
  const m = /^(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)$/.exec(v);
  if (m) return finish({ type: "number", minimum: +m[1], maximum: +m[2] }, def);

  // Quoted single-literal → const.
  if (/^"[^"]*"$/.test(v) || /^'[^']*'$/.test(v)) {
    return finish({ type: "string", const: stripQuotes(v) }, def);
  }
  if (v.startsWith("[") && v.endsWith("]")) return finish({ type: "array" }, def);
  if (v.startsWith("{") && v.endsWith("}")) {
    return finish(parseParamsDoc(v).schema, def);
  }

  switch (v.toLowerCase()) {
    case "str": case "string": case "text": case "path": case "url": case "name":
      return finish({ type: "string" }, def);
    case "bool": case "boolean":              return finish({ type: "boolean" }, def);
    case "n": case "int": case "integer":
    case "i32": case "u32": case "u64": case "index":
      return finish({ type: "integer" }, def);
    case "number": case "f64": case "percent": case "px": case "pt": case "mm":
      return finish({ type: "number" }, def);
    case "json": case "any": case "object":
      return finish({ type: "object", additionalProperties: true }, def);
  }

  // A bare identifier that survived all of the above (e.g. `Filter`) is
  // treated as a free-form sub-object — the params doc references a type.
  if (/^[A-Z][A-Za-z0-9]*$/.test(v)) {
    return finish({ type: "object", additionalProperties: true }, def);
  }
  // Lowercase word that isn't a keyword — treat as a string constant.
  if (/^[a-z][a-zA-Z0-9]*$/.test(v)) return finish({ type: "string" }, def);

  return { schema: {}, ok: false };
}

function finish(s: Record<string, unknown>, def: unknown): ValueSchema {
  if (def !== undefined) s = { ...s, default: def };
  return { schema: s, ok: true };
}

// --- Small lexical helpers (kept in one place for clarity) ---
function findBalancedBrace(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"' || c === "'") { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === "{") depth++;
    else if (c === "}") { depth--; if (depth === 0) return s.slice(start + 1, i); }
  }
  return null;
}
function splitTopLevelCommas(s: string): string[] {
  const out: string[] = []; let depth = 0, inStr = false, esc = false, buf = "";
  for (const c of s) {
    if (esc) { buf += c; esc = false; continue; }
    if (c === "\\") { buf += c; esc = true; continue; }
    if (c === '"' || c === "'") { inStr = !inStr; buf += c; continue; }
    if (!inStr) {
      if ("{[(".includes(c)) depth++;
      else if ("}])".includes(c)) depth--;
      else if (c === "," && depth === 0) { out.push(buf); buf = ""; continue; }
    }
    buf += c;
  }
  if (buf.trim()) out.push(buf);
  return out;
}
function splitAtTopLevelColon(s: string): { key: string; value: string } {
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"' || c === "'") { inStr = !inStr; continue; }
    if (inStr) continue;
    if ("{[(".includes(c)) depth++;
    else if ("}])".includes(c)) depth--;
    else if (c === ":" && depth === 0) {
      return { key: s.slice(0, i).trim(), value: s.slice(i + 1).trim() };
    }
  }
  // key-only (e.g. "{path}") — no value, means "string".
  return { key: s.trim(), value: "str" };
}
function splitAlternation(s: string): string[] {
  const out: string[] = []; let depth = 0, inStr = false, esc = false, buf = "";
  for (const c of s) {
    if (esc) { buf += c; esc = false; continue; }
    if (c === "\\") { buf += c; esc = true; continue; }
    if (c === '"' || c === "'") { inStr = !inStr; buf += c; continue; }
    if (!inStr) {
      if ("{[(".includes(c)) depth++;
      else if ("}])".includes(c)) depth--;
      else if (c === "|" && depth === 0) { out.push(buf); buf = ""; continue; }
    }
    buf += c;
  }
  out.push(buf);
  return out.map(x => x.trim()).filter(Boolean);
}
function findUnbracketed(s: string, ch: string): number {
  let depth = 0, inStr = false, esc = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (esc) { esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"' || c === "'") { inStr = !inStr; continue; }
    if (inStr) continue;
    if ("{[(".includes(c)) depth++;
    else if ("}])".includes(c)) depth--;
    else if (c === ch && depth === 0) return i;
  }
  return -1;
}
function stripQuotes(s: string): string {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
function parseLiteralOrDefault(s: string): unknown {
  const t = s.trim();
  if (/^-?\d+$/.test(t)) return Number(t);
  if (/^-?\d+\.\d+$/.test(t)) return Number(t);
  if (t === "true") return true;
  if (t === "false") return false;
  if (t === "null") return null;
  return stripQuotes(t);
}

// ---------------------------------------------------------------------------
// 4. Main adapter
// ---------------------------------------------------------------------------

export class ArtCraftDiscoveryAdapter implements DiscoveryAdapter {
  constructor(private readonly configPath = ".mcp/config.json") {}

  // --- Per-app discovery ---------------------------------------------------
  async discover(app: AppId): Promise<{ tools: readonly NormalizedTool[]; registryVersion: string }> {
    const spec = APP_SPECS[app];
    const cfg = JSON.parse(await (await import("node:fs/promises")).readFile(this.configPath, "utf8"));
    const roots = cfg?.apps?.[app] ?? {};

    const transport = new StdioClientTransport({
      command: spec.binary,
      args: ["mcp", ...spec.mcpArgs(roots)],
      cwd: process.cwd(),
    });
    const client = new Client({ name: `discover-${app}`, version: "1.0.0" }, { capabilities: {} });
    await client.connect(transport);

    try {
      const raw = unwrapToolResult(
        await client.callTool({ name: spec.listTool, arguments: spec.listArgs }),
      );
      const commands = spec.extract(raw);

      const tools: NormalizedTool[] = [];

      // (a) Meta-tools come from the worker's own `tools/list`, not from a
      //     hand-written table: the registry is the ground truth, and every
      //     app names its meta-tools differently (PhotoCraft `command_run`,
      //     DesignCraft and WordCraft `execute`, EffectCraft `execute_command`,
      //     PdfCraft `doc_open`, …).
      const listed = await client.listTools();
      for (const t of listed.tools) {
        tools.push(Object.freeze({
          name: `${app}_${t.name.replace(/[^A-Za-z0-9]+/g, "_")}`,
          description: `[${app}] ${t.description ?? t.name}`,
          parameters: (t.inputSchema as Record<string, unknown> | undefined)
            ?? { type: "object", additionalProperties: true },
          commandId: null,
          app,
          looselyTyped: false,
          enabledWithoutDoc: true,
          _meta: Object.freeze({
            isMetaTool: true, rawParamsDoc: "", disabledReason: null, transport: "mcp-meta",
          }),
        } as NormalizedTool));
      }

      // Names must be unique: a registry id like `command.list` normalizes
      // to the same string as the meta-tool `command_list`. The meta-tool
      // wins (it is the supported route), so the duplicate is skipped.
      const taken = new Set(tools.map((t) => t.name));

      // (b) Registry commands. When the `tool` field is set (PdfCraft), the
      // registry identity wins — the map is the auditable, schema-versioned
      // surface the agent should prefer.
      for (const cmd of commands) {
        const { schema, looselyTyped } = parseParamsDoc(
          typeof cmd.params === "string" ? cmd.params : cmd.params ? JSON.stringify(cmd.params) : null
        );

        const disabledReason =
          cmd.enabled === false
            ? (cmd.disabled_reason ?? cmd.why ?? "disabled")
            : null;

        // Distinguish "no document open" (recoverable — agent opens one first)
        // from a hard precondition ("nothing selected").
        const needsDoc =
          cmd.needsDocument === true ||
          /no document open|no composition open|no photos selected/i.test(disabledReason ?? "");
        const selOnly = /nothing selected|no selection|select text/i.test(disabledReason ?? "");

        if (selOnly && cmd.enabled === false) {
          // Hide entirely: the LLM has no way to satisfy this precondition
          // until it makes a selection. A later diff will surface it.
          continue;
        }

        const menuPath = Array.isArray(cmd.menu) ? cmd.menu.join(" › ") : (cmd.menu ?? "");
        const desc = [
          `[${app}] ${cmd.label ?? cmd.id}`,
          menuPath ? `Location: ${menuPath}` : "",
          cmd.shortcut ? `Shortcut: ${cmd.shortcut}` : "",
          typeof cmd.params === "string" && cmd.params ? `Params doc: ${cmd.params}` : "",
          needsDoc ? "Will require opening a document first." : "",
          cmd.tool ? `Backed by MCP meta-tool \`${cmd.tool}\`.` : "",
        ].filter(Boolean).join("\n");

        const commandName = `${app}_${slug(cmd.id)}`;
        if (taken.has(commandName)) continue;
        taken.add(commandName);

        tools.push(Object.freeze({
          name: commandName,
          description: desc,
          parameters: schema,
          commandId: cmd.id,
          app,
          looselyTyped,
          enabledWithoutDoc: !needsDoc && cmd.enabled !== false,
          _meta: Object.freeze({
            isMetaTool: false,
            rawParamsDoc: typeof cmd.params === "string" ? cmd.params : "",
            disabledReason,
            transport: cmd.tool ? "mcp-meta" : "engine-command",
          }),
        } as NormalizedTool));
      }

      // (c) Null the connection's identity away: a payload-hash version is a
      // sufficient cache key and doesn't leak command lists into the transport.
      const version = createHash("sha256")
        .update(tools.map(t => t.name).sort().join("\n"))
        .digest("hex");

      return Object.freeze({ tools: Object.freeze(tools), registryVersion: version });
    } finally {
      await client.close();
    }
  }

  // --- Immutable diff ------------------------------------------------------
  diff(prev: readonly NormalizedTool[], next: readonly NormalizedTool[]): SchemaPatch {
    const prevByName = new Map(prev.map(t => [t.name, t] as const));
    const nextByName = new Map(next.map(t => [t.name, t] as const));

    const added:   NormalizedTool[] = [];
    const removed: string[]         = [];
    const changed: { name: string; next: NormalizedTool }[] = [];

    for (const [name, t] of nextByName) {
      if (!prevByName.has(name)) added.push(t);
    }
    for (const [name] of prevByName) {
      if (!nextByName.has(name)) removed.push(name);
    }
    for (const [name, t] of nextByName) {
      const old = prevByName.get(name);
      if (!old) continue;
      // Compare only the fields the LLM actually sees.
      if (
        old.description !== t.description ||
        old.looselyTyped !== t.looselyTyped ||
        old.enabledWithoutDoc !== t.enabledWithoutDoc ||
        JSON.stringify(old.parameters) !== JSON.stringify(t.parameters)
      ) {
        changed.push({ name, next: t });
      }
    }
    return Object.freeze({
      added: Object.freeze(added),
      removed: Object.freeze(removed),
      changed: Object.freeze(changed),
    });
  }
}

// ---------------------------------------------------------------------------
// 5. Capability index (name → origin), used by the agent's tool router.
// ---------------------------------------------------------------------------
export function buildCapabilityIndex(
  tools: readonly NormalizedTool[],
): ReadonlyMap<string, { app: AppId; commandId: string | null; isMetaTool: boolean;
                         transportRequired: "mcp" | "tcp" }> {
  const idx = new Map<string, any>();
  for (const t of tools) {
    idx.set(t.name, Object.freeze({
      app: t.app,
      commandId: t.commandId,
      isMetaTool: t._meta.isMetaTool,
      // Registry commands always go through the app's own MCP server; the
      // meta-tools map identically on the transport side.
      transportRequired: "mcp" as const,
    }));
  }
  return idx;
}
