// ============================================================================
// Exercise 5 — Design-System MCP Server (design document)
// ============================================================================
//
// Two concurrent roles:
//   * MCP SERVER  — faces the three agents (copywriting, layout, color).
//   * MCP CLIENT  — fronts GridCraft and DeckCraft subprocesses.
//
// The wire protocol is MCP; the security model is capability-based; the
// downstream resource is a pooled subprocess keyed on (app, readRoot, writeRoot).
// ============================================================================

// ---------------------------------------------------------------------------
// 1. Scope document — read once at startup, IMMUTABLE for the session.
//
// Rotation requires a fresh session. The server rejects mid-session token
// changes: if an incoming `Authorization` header differs from the token that
// created the session, the transport is torn down with -32010.
// ---------------------------------------------------------------------------

export interface ScopeDocument {
  readonly agentId: string;
  /** Opaque; the raw bytes are never logged. Kept in memory only. */
  readonly token: string;
  readonly resources: {
    /** Exact URIs (no wildcards) that may be read. */
    readonly uriPrefixes: readonly string[];
    /** RFC 6570 URI templates that are listed in resources/templates/list. */
    readonly templates: readonly string[];
  };
  readonly tools: readonly string[];
  readonly prompts: readonly string[];
  readonly roots: {
    readonly read: string;
    readonly write: string;
  };
}

// ---------------------------------------------------------------------------
// 2. MCP entity descriptors returned per-session by the handlers.
// ---------------------------------------------------------------------------

export interface ResourceDescriptor {
  readonly uri: string;                        // concrete URI, not template
  readonly name: string;
  readonly mimeType: string;                   // e.g. "application/json"
  readonly description?: string;
}

export interface ResourceTemplateDescriptor {
  readonly uriTemplate: string;                // RFC 6570
  readonly name: string;
  readonly mimeType: string;
  readonly description?: string;
}

export interface ResourceContent {
  readonly uri: string;
  readonly mimeType: string;
  readonly text?: string;
  readonly blob?: string;                      // base64 if binary
}

export interface ToolDescriptor {
  readonly name: string;
  readonly description: string;                // MUST include side-effect warning when applicable
  readonly inputSchema: Record<string, unknown>;
}

export interface ToolResult {
  readonly content: readonly { type: "text"; text: string }[];
  readonly isError?: boolean;
}

export interface PromptDescriptor {
  readonly name: string;
  readonly description: string;
  readonly arguments: readonly {
    readonly name: string;
    readonly description: string;
    readonly required: boolean;
  }[];
}

export interface PromptResult {
  readonly description: string;
  /** The prompt tells the HOST what to execute — it does not execute. */
  readonly messages: readonly {
    readonly role: "user" | "assistant";
    readonly content: { type: "text"; text: string };
  }[];
}

// ---------------------------------------------------------------------------
// 3. Session context — the security boundary object.
// ---------------------------------------------------------------------------

export interface SessionContext {
  readonly sessionId: string;                  // ULID
  readonly scope: ScopeDocument;              // deep-frozen at load
  readonly openedAt: number;
  readonly transport: "stdio" | "http-sse";
}

// ---------------------------------------------------------------------------
// 4. Downstream pool — GridCraft + DeckCraft subprocesses.
//
// Keying: (app, readRoot, writeRoot). Two sessions with identical roots
// share a subprocess; two sessions with different writeRoots get separate
// subprocesses. Rationale: GridCraft's MCP server is itself stateful and
// single-threaded per socket. A shared writeRoot means the sessions are
// cooperating on the same files — serializing them via one subprocess is
// correct. Different writeRoots mean they must not see each other's
// active document, so we cannot share.
// ---------------------------------------------------------------------------

export interface DownstreamPool {
  acquire(app: "gridcraft" | "deckcraft", roots: ScopeDocument["roots"]): Promise<AppLease>;
  release(lease: AppLease): Promise<void>;
  closeSession(session: SessionContext): Promise<void>;
}

export interface AppLease {
  readonly app: "gridcraft" | "deckcraft";
  readonly key: string;                        // `${app}::${read}::${write}`
  /** Serialized FIFO within a lease. */
  run(id: string, params: Record<string, unknown>): Promise<unknown>;
}

// ---------------------------------------------------------------------------
// 5. Handlers — the interface the exercise asks for.
// ---------------------------------------------------------------------------

export interface ServerHandlers {
  listResources(session: SessionContext): Promise<{ resources: ResourceDescriptor[] }>;
  listResourceTemplates(session: SessionContext): Promise<{ templates: ResourceTemplateDescriptor[] }>;
  readResource(session: SessionContext, uri: string): Promise<{ contents: ResourceContent[] }>;
  listTools(session: SessionContext): Promise<{ tools: ToolDescriptor[] }>;
  callTool(session: SessionContext, name: string, args: Record<string, unknown>): Promise<ToolResult>;
  listPrompts(session: SessionContext): Promise<{ prompts: PromptDescriptor[] }>;
  getPrompt(session: SessionContext, name: string, args: Record<string, unknown>): Promise<PromptResult>;
}

// ---------------------------------------------------------------------------
// 6. Behavior specification for each handler.
// ---------------------------------------------------------------------------

/**
 * listResources(session)
 * ──────────────────────
 * Returns ONLY the resources whose concrete URI begins with one of
 * session.scope.resources.uriPrefixes. The list is computed by reading the
 * scope's read root and enumerating files under each permitted prefix. The
 * server MUST NOT return descriptors for unauthorized resources even in
 * aggregate form — the count of unauthorized resources must not leak.
 *
 * Implementation detail: enumerate `<readRoot>/tokens/*.json` and
 * `<readRoot>/style-guide.md`, filtering by `scope.resources.uriPrefixes`.
 * Errors reading a permitted file degrade that entry to a stub descriptor
 * with no `description`, never to a "not found" for an unauthorized path.
 *
 * Conformance call: this is a pure read; no downstream app interaction.
 */

/**
 * listResourceTemplates(session)
 * ──────────────────────────────
 * Returns the templates listed in `session.scope.resources.templates`.
 * The `uriTemplate` field carries an RFC 6570 template, e.g.
 *   "designsystem://templates/{templateName}"
 * The list is static per session (from the scope document), so no filesystem
 * read is needed. The server MUST refuse to enumerate template *instances*
 * for a template the caller cannot list — otherwise a caller could probe.
 *
 * Specific exercise example: the layout agent gets
 *   ["designsystem://templates/{templateName}"]
 * but the copywriting and color agents get []. Their listResourceTemplates
 * response is `{ templates: [] }`, indistinguishable from a server that
 * has none — this is the anti-enumeration property.
 */

/**
 * readResource(session, uri)
 * ──────────────────────────
 * Order of checks:
 *   1. Parse the URI. Reject malformed URIs with -32602.
 *   2. Check `isPermitted(uri, session.scope.resources.uriPrefixes)` OR
 *      `matchesTemplate(uri, session.scope.resources.templates)`.
 *      If NOT permitted: return JSON-RPC error -32010 ("capability denied")
 *      with a GENERIC message. It MUST NOT reveal that the resource exists.
 *   3. Resolve the URI to a filesystem path under `session.scope.roots.read`.
 *      Any path traversal (`..`) is rejected with -32602. Symlinks are
 *      resolved and re-checked; a resolved path outside the root fails the
 *      same way.
 *   4. For static resources, read and return the file. For composite
 *      resources (contrast-pairs), compute the derived content:
 *        - Read `<readRoot>/tokens/colors.json`.
 *        - For each ordered pair (c1, c2), compute WCAG 2.1 contrast ratio.
 *        - Return `{ pairs: [...], _source: "derived@wcag21" }`.
 *
 * Specific resource: `designsystem://tokens/contrast-pairs` is COMPOSITE.
 * The response body MUST contain `_source: "derived@wcag21"` so the caller
 * knows the data is generated, not authored. Static reads carry
 * `_source: "static"`.
 */

/**
 * listTools(session)
 * ──────────────────
 * Returns ONLY the tools in `session.scope.tools`. Tool descriptions MUST
 * include an explicit side-effect warning if the tool writes:
 *
 *   {
 *     name: "design.system.generate_layout",
 *     description:
 *       "Generate a GridCraft layout from a template and token set. " +
 *       "WRITES to the target GridCraft document.",
 *     inputSchema: { ... }
 *   }
 *
 * The description is the LLM's primary safety signal. Missing it is a
 * security defect: the agent will invoke a writer thinking it's a reader.
 * The list is filtered server-side, so an unauthorized tool is not just
 * uncallable — it is invisible.
 */

/**
 * callTool(session, name, args)
 * ─────────────────────────────
 * Order of checks — identical to readResource's anti-enumeration policy:
 *   1. If `name` is not in `session.scope.tools`, return JSON-RPC error
 *      -32601 ("method not found") with a GENERIC message. It must be
 *      INDISTINGUISHABLE from a call to a genuinely-missing tool. Never
 *      return "capability denied" for a tool the session cannot see;
 *      the caller must not be able to prove the tool exists.
 *   2. Validate `args` against the tool's schema. Failure → -32602.
 *   3. Acquire an AppLease from the pool for the tool's target app and
 *      session.scope.roots.
 *   4. Dispatch via lease.run(namespace_command_id, translated_args).
 *      Translation: MCP tool name → GridCraft/DeckCraft registry command id.
 *      E.g. `design.system.generate_layout` → `grid.layout.applyTemplate`.
 *      (If GridCraft does not expose a matching command, the tool is
 *      refused at registration time; it is not visible in listTools.)
 *   5. Release the lease.
 *   6. Structured log line: {sessionId, agentId, tool, durationMs, outcome}.
 */

/**
 * listPrompts(session)
 * ────────────────────
 * Prompts are NOT scoped by resource. They are gated by
 * `session.scope.prompts`. The three-agents table from the exercise maps:
 *   copywriting       → []
 *   layout            → ["layout:generate_grid", "designsystem:apply_brand_kit"]
 *   color-consistency → ["designsystem:apply_brand_kit"]
 * A caller that asks for an unauthorized prompt by name gets -32601, same
 * as callTool. `designsystem:apply_brand_kit` when authorized returns the
 * SAME output regardless of which agent requested it; the scope check is
 * the only difference.
 */

/**
 * getPrompt(session, name, args)
 * ──────────────────────────────
 * Validates `name ∈ session.scope.prompts`; on failure, -32601.
 * Validates `args` against the prompt's declared arguments; on failure, -32602.
 * Returns a `messages` array of instruction text. The prompt output is a
 * SEQUENCE of `{tool, params}` tuples that the HOST decides whether to
 * execute. This is a real security boundary: the prompt cannot execute
 * anything itself. If the LLM at the host ignores the prompt's suggested
 * tools or substitutes different ones, that is the host's responsibility;
 * the server provides suggestions only.
 *
 * Example output for `designsystem:apply_brand_kit {brand: "Acme", target: "deck"}`:
 *   messages: [
 *     { role: "user", content: {
 *       type: "text",
 *       text: "Apply the Acme brand kit to a new deck:\n" +
 *             "1. design.system.resolve_token {token: \"acme.primary\"}\n" +
 *             "2. design.system.generate_layout {template: \"acme-title\", target: \"deck\"}\n" +
 *             "3. design.system.validate_contrast {pairs: [...]}" } }
 *   ]
 */

// ---------------------------------------------------------------------------
// 7. Downstream pool keying + graceful shutdown state machine.
// ---------------------------------------------------------------------------

/**
 * Pool keying
 * ───────────
 * Key: `${app}::${readRoot}::${writeRoot}`.
 * Value: { process, mutex, activeLeases, generation }.
 *
 * When a session calls `acquire`, the pool:
 *   - Searches for an existing entry with the same key that is not
 *     draining.
 *   - If found, increments activeLeases; on lease release, decrements.
 *   - If not found, spawns `<app>-cli mcp --automation-read-root <r>
 *     --automation-write-root <w>` and connects the MCP client.
 *
 * Serialization: `lease.run` acquires the entry's mutex exclusively. The
 * mutex is a fair FIFO queue — the reference warns that the apps' internal
 * queues are not fair, so the pool's own queue must be. Long-running calls
 * (e.g. grid.render.preview with a large artboard) are expected to hold the
 * mutex; a short read call queued behind it will still complete, just not
 * immediately. If the wait exceeds a per-call timeout (default 120 s), the
 * call fails with -32011 (downstream timeout).
 *
 * Generation tagging: if a subprocess crashes (socket closed unexpectedly),
 * the pool bumps the entry's generation and refuses all new leases for that
 * generation. Sessions holding leases with the old generation get an error
 * on next use; the pool then spawns a fresh subprocess and issues new
 * leases. This prevents "zombie" leases from calling into a dead process.
 */

/**
 * Graceful shutdown — state machine
 * ─────────────────────────────────
 * On `shutdown` or socket close for a session:
 *
 *   State OPEN
 *     │ session.shutdown received or transport closed
 *     ▼
 *   State DRAINING
 *     │   * Refuse new tool/resource/prompt calls for this session
 *     │     (return -32000 "session draining").
 *     │   * Await in-flight tool calls (bounded by 5 s grace).
 *     ▼
 *   State PERSISTING     (per-dirty-document)
 *     │   For each document opened by this session across any lease:
 *     │     If the document is dirty and unsaved:
 *     │       * GridCraft: dispatch `grid.saveRecovery {path}` via
 *     │         lease.run. Consult the GridCraft registry: if a
 *     │         saveRecovery command doesn't exist, fall back to
 *     │         `command_run {id: "doc_save", params: {path:
 *     │         "<writeRoot>/.recovery/<sessionId>/<name>.grid"}}`.
 *     │       * DeckCraft: same pattern with `deck.saveRecovery`, else
 *     │         `doc_save` to the recovery path.
 *     │     Then dispatch `doc_close` on the app. Do NOT pass
 *     │     discard_changes: true — the persisted recovery file IS the
 *     │     discard target.
 *     │   Every write goes under `<writeRoot>/.recovery/<sessionId>/`
 *     │   so a crashed session's state is recoverable but not published.
 *     ▼
 *   State RELEASING
 *     │   * For each lease held: pool.release(lease).
 *     │   * If a lease's activeLeases count drops to zero, terminate
 *     │     the subprocess: send SIGTERM; wait up to 5 s; if still
 *     │     alive, send SIGKILL. Log the escalation.
 *     ▼
 *   State CLOSED
 */

// ---------------------------------------------------------------------------
// 8. Observability contract.
// ---------------------------------------------------------------------------

/**
 * Every tool invocation emits ONE structured log line. Fields:
 *
 *   {
 *     ts: ISO-8601 UTC,
 *     sessionId: ULID,
 *     agentId: string,             // from scope
 *     tool: string,                // e.g. "design.system.generate_layout"
 *     durationMs: number,
 *     outcome: "ok" | "error" | "denied"
 *   }
 *
 * Rules:
 *   * Token material is NEVER logged, in whole or in part.
 *   * Resource CONTENTS are NEVER logged (may contain unreleased tokens).
 *   * The `agentId` is logged, not the token. This lets operators filter
 *     by agent without risking credential leakage.
 *   * Errors include the JSON-RPC error code but not the raw args
 *     (args may carry PII in a design-token name).
 *   * Logs go to a rotating sink capped at 100 MB per file, 10 files,
 *     old files gzipped. Rotation is size-triggered, not time-triggered,
 *     to bound on-disk volume under burst load.
 *
 * Sink choice: append-only NDJSON, one line per event, no multiline fields.
 * This makes the log safe to tail and grep under concurrency.
 */

// ---------------------------------------------------------------------------
// 9. Error code map (JSON-RPC 2.0 envelopes — no 200-with-error-body).
// ---------------------------------------------------------------------------

export const ErrorCodes = {
  METHOD_NOT_FOUND: -32601,     // unknown tool/prompt/resource name (generic, no existence leak)
  INVALID_PARAMS:   -32602,     // schema validation failure, malformed URI, path traversal
  CAPABILITY_DENIED:-32010,     // reserved for cases where returning existence is safe (e.g. templates)
  DOWNSTREAM_UNAVAILABLE: -32011, // app subprocess dead, no replacement yet
  DOWNSTREAM_TIMEOUT:     -32012, // app lease mutex timed out
  SESSION_DRAINING:       -32013,
} as const;

// ---------------------------------------------------------------------------
// 10. Concrete capability table for the three agents (per the exercise).
// ---------------------------------------------------------------------------

export const SCOPES: Record<string, ScopeDocument> = {
  copywriting: {
    agentId: "copywriting",
    token: "<opaque>",
    resources: {
      uriPrefixes: ["designsystem://tokens/type-scale", "designsystem://style-guide"],
      templates: [],
    },
    tools: ["design.system.describe"],
    prompts: [],
    roots: { read: "/work/design-system", write: "/work/scratch/copywriting" },
  },
  layout: {
    agentId: "layout",
    token: "<opaque>",
    resources: {
      uriPrefixes: ["designsystem://tokens/spacing"],
      templates: ["designsystem://templates/{templateName}"],
    },
    tools: [
      "design.system.generate_layout",
      "design.system.resolve_token",
      "design.system.validate_contrast",
    ],
    prompts: ["layout:generate_grid", "designsystem:apply_brand_kit"],
    roots: { read: "/work/design-system", write: "/work/scratch/layout" },
  },
  color: {
    agentId: "color-consistency",
    token: "<opaque>",
    resources: {
      uriPrefixes: [
        "designsystem://tokens/colors",
        "designsystem://tokens/contrast-pairs",
      ],
      templates: [],
    },
    tools: ["design.system.resolve_token", "design.system.validate_contrast"],
    prompts: ["designsystem:apply_brand_kit"],
    roots: { read: "/work/design-system", write: "/work/scratch/color" },
  },
};
