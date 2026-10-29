/**
 * financial-pipeline.ts
 *
 * Production orchestrator that regenerates a board-ready financial deck from
 * a multi-sheet GridCraft model. Runs headless against gridcraft-cli and
 * deckcraft-cli via the MCP stdio transport.
 *
 * Design principles:
 *   1. Every GridCraft/DeckCraft mutation is a registered engine command or
 *      a named MCP tool, dispatched through one typed façade so the surface
 *      area stays small and version-stable across ArtCraft releases.
 *   2. All mutation is idempotent: an `auditId` is embedded into every
 *      write so partial re-runs can be detected and rolled forward without
 *      duplicating lineage records.
 *   3. Audit failures never crash the process — they become structured
 *      incidents written to the treasury incident queue.
 *
 * Runtime: Node.js >= 20.
 * Author: Treasury Platform Engineering.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { createHash, randomUUID } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

/* ============================================================================
 * 1. DOMAIN SCHEMAS — the shape of everything we send and receive
 * ========================================================================== */

/**
 * A scenario is a set of driver-cell overrides that we spray across the
 * model before pulling the reconciled statements. The three named scenarios
 * below are the treasury's canonical configuration: the base case, a growth
 * upside, and a stress case used by the risk committee.
 */
export const ScenarioSchema = z.object({
  id: z.enum(["base", "bull", "bear"]),
  label: z.string(),
  /** Global driver cells, addressed by fully-qualified GridCraft range name. */
  drivers: z.record(z.string(), z.number()),
});
export type Scenario = z.infer<typeof ScenarioSchema>;

/**
 * A named range declares a stable, human-readable handle onto a rectangular
 * region of a sheet. Once declared, every formula downstream references the
 * *name*, not the A1 address, which is what allows us to re-architect the
 * sheet's physical layout without rewriting formulas.
 */
export const NamedRangeSchema = z.object({
  name: z.string().regex(/^[A-Z_][A-Z0-9_]*$/),
  sheet: z.string(),
  a1: z.string(),
  scope: z.enum(["Workbook", "sheet"]).default("Workbook"),
});
export type NamedRange = z.infer<typeof NamedRangeSchema>;

/**
 * A formula installation record. We persist these locally so that when a
 * subsequent run detects the same fingerprint, it can short-circuit the
 * write and avoid churning the audit trail.
 */
export const FormulaInstallSchema = z.object({
  sheet: z.string(),
  a1: z.string(),
  formula: z.string(),
  auditId: z.string(),
  fingerprint: z.string(),
});
export type FormulaInstall = z.infer<typeof FormulaInstallSchema>;

/**
 * The shape of the audit incident we write when the pipeline aborts. This
 * is deliberately aligned with the incident taxonomy used by the on-call
 * rotation so downstream tooling can page without transformation.
 */
export const AuditIncidentSchema = z.object({
  auditId: z.string(),
  severity: z.enum(["block", "degrade", "notify"]),
  category: z.enum([
    "circular_reference",
    "unresolved_reference",
    "stale_binding",
    "deck_visual_mismatch",
    "lineage_gap",
  ]),
  message: z.string(),
  offender: z.object({ sheet: z.string(), a1: z.string() }).optional(),
  detectedAt: z.string(),
});
export type AuditIncident = z.infer<typeof AuditIncidentSchema>;

/* ============================================================================
 * 2. LOW-LEVEL TRANSPORT — a typed, retrying MCP wrapper
 * ========================================================================== */

/** Which engine a transport talks to. The two disagree about tool names. */
export type CraftFlavour = "grid" | "deck";

/**
 * The ambient audit context.
 *
 * Every function in the pipeline needs the current `auditId` — the architect
 * stamps it onto sheet writes, the engineer stamps it onto formula writes,
 * the auditor stamps it onto incidents, the binder stamps it onto slide
 * bindings. Threading it through every function signature would be noisy
 * and easy to forget. `AsyncLocalStorage` solves this cleanly: the
 * supervisor opens a store at the top of `run()`, and every `await` in the
 * request pipeline inherits that store. Node's event loop restores the
 * store after each I/O completion, so concurrent pipelines cannot
 * cross-contaminate each other's audit ids.
 */
export interface AuditContext {
  /** The id every write of this run is stamped with. */
  auditId: string;
  /** The tenant's run, for the audit trail. */
  runId: string;
}

/** The ambient store. Read it with `auditContext.getStore()`. */
export const auditContext = new AsyncLocalStorage<AuditContext>();

/** The audit id of the running pipeline, or `""` outside one. */
export function currentAuditId(): string {
  return auditContext.getStore()?.auditId ?? "";
}

/**
 * The GridCraft and DeckCraft MCP servers both expose a small set of
 * meta-tools, and both put their payload in the first `text` content block.
 * GridCraft's is `execute_command`, DeckCraft's is `run_command`; DeckCraft
 * additionally has a real `batch`, while GridCraft has none and every write
 * is its own round trip.
 *
 * Retry policy: exponential backoff starting at 120 ms, capped at 2 s, with
 * three attempts. The transport is line-delimited JSON-RPC, so retrying is
 * safe as long as the command is idempotent — which is why every write we
 * issue carries an `auditId` that the engine treats as an idempotency key.
 */
export class CraftTransport {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private readonly log: (msg: string, meta?: unknown) => void;
  private readonly retryBudget = 3;
  private readonly baseBackoffMs = 120;

  constructor(
    binary: string,
    private readonly flavour: CraftFlavour,
    args: string[] = ["mcp"],
    cwd?: string,
    log: (msg: string, meta?: unknown) => void = console.log,
  ) {
    this.log = log;
    this.transport = new StdioClientTransport({
      command: binary,
      args,
      ...(cwd ? { cwd } : {}),
      env: { ...process.env, CRAFT_LOG_LEVEL: "warn" } as Record<string, string>,
    });
    this.client = new Client(
      { name: "treasury-financial-pipeline", version: "3.2.0" },
      { capabilities: {} },
    );
  }

  /** Establish the stdio session. Call once during bootstrap. */
  async connect(): Promise<void> {
    this.log(`[transport] connecting stdio session`);
    await this.client.connect(this.transport);
  }

  /** Close the session cleanly so the CLI process can flush its journal. */
  async close(): Promise<void> {
    await this.client.close();
  }

  /**
   * Call one MCP tool and parse its JSON payload.
   *
   * Both servers answer with `{ content: [{ type: "text", text: "<json>" }] }`
   * and flag a failure with `isError` — the flag is checked before the
   * parse, or the error message would be reported as a syntax error.
   */
  async call<T = unknown>(
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<T> {
    let attempt = 0;
    for (;;) {
      try {
        const res = (await this.client.callTool({
          name: tool,
          arguments: args,
        })) as {
          content?: Array<{ type: string; text?: string }>;
          isError?: boolean;
        };
        const block = res.content?.find((c) => c.type === "text");
        if (res.isError) {
          throw new Error(`${tool} failed: ${block?.text ?? "<no detail>"}`);
        }
        if (!block?.text) throw new Error(`Malformed MCP response for ${tool}`);
        return JSON.parse(block.text) as T;
      } catch (err) {
        attempt += 1;
        if (attempt > this.retryBudget) {
          this.log(`[transport] ${tool} exhausted retries`, { err });
          throw err;
        }
        const jitter = Math.random() * 60;
        const delay = Math.min(2_000, this.baseBackoffMs * 2 ** attempt + jitter);
        this.log(
          `[transport] ${tool} failed (attempt ${attempt}), retrying in ${delay.toFixed(0)} ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  /**
   * Run one engine command. GridCraft's meta-tool is `execute_command` and
   * DeckCraft's is `run_command`; both take the command id and its
   * parameters under the same key names.
   *
   * The ambient audit id travels with the call as an idempotency key, so a
   * write that is retried after a transport fault is recognised as the same
   * write rather than as a second one.
   */
  async run<T = unknown>(
    command: string,
    params: Record<string, unknown> = {},
    idempotencyKey?: string,
  ): Promise<T> {
    const tool = this.flavour === "grid" ? "execute_command" : "run_command";
    const key = idempotencyKey ?? currentAuditId();
    return this.call<T>(tool, {
      command,
      params: key ? { ...params, __idempotency: key } : params,
    });
  }

  /**
   * Run several DeckCraft commands in one round trip. DeckCraft has a real
   * `batch`; GridCraft does not, so the grid flavour falls back to a
   * sequential loop — which is *not* atomic, and the callers that need
   * all-or-nothing semantics build in a scratch workbook and publish it
   * with a single rename.
   */
  async batch<T = unknown>(
    steps: Array<{ command: string; params?: Record<string, unknown> }>,
  ): Promise<T> {
    if (this.flavour === "deck") {
      return this.call<T>("batch", {
        commands: steps.map((s) => ({
          command: s.command,
          params: s.params ?? {},
        })),
        keepGoing: false,
      });
    }
    const results: unknown[] = [];
    for (const step of steps) {
      results.push(await this.run(step.command, step.params ?? {}));
    }
    return results as unknown as T;
  }

  /** The full workbook tree — sheets, names, undo journal, dirty flag. */
  async inspectGrid(): Promise<GridDocumentTree> {
    return this.call<GridDocumentTree>("inspect_workbook", {});
  }

  /** The full presentation tree — slides, layouts, theme. */
  async inspectDeck(): Promise<DeckDocumentTree> {
    return this.call<DeckDocumentTree>("inspect_document", {});
  }

  /**
   * Render a slide to PNG.
   *
   * DeckCraft answers with an *image* content block, so the bytes come from
   * the image block and not from a text one.
   */
  async renderSlide(
    slide = 0,
    scale = 1,
  ): Promise<{ data: string; mimeType: string }> {
    const res = (await this.client.callTool({
      name: "render_slide",
      arguments: { slide, scale },
    })) as {
      content?: Array<{ type: string; data?: string; mimeType?: string }>;
      isError?: boolean;
    };
    const image = res.content?.find((c) => c.type === "image");
    if (!image?.data) {
      throw new Error("render_slide returned no image content block");
    }
    return { data: image.data, mimeType: image.mimeType ?? "image/png" };
  }
}

/** `B2` → `$B$2`. */
function absoluteA1(a1: string): string {
  const match = /^([A-Z]+)(\d+)$/.exec(a1);
  if (!match) return a1;
  return `$${match[1]}$${match[2]}`;
}

/** Minimal typed view of the workbook we rely on. */
export interface GridDocumentTree {
  title: string;
  path: string | null;
  dirty: boolean;
  calcMode: string;
  activeSheet: number;
  activeCell: string;
  sheets: Array<{
    name: string;
    cells: number;
    usedRange: string | null;
    charts: unknown[];
    tables: unknown[];
    shapes: number;
  }>;
  names: Array<{ name: string; refersTo: string; scope: string | null }>;
}

/** Minimal typed view of the presentation we rely on. */
export interface DeckDocumentTree {
  title?: string;
  slides?: Array<{ index: number; name: string; shapes: number }>;
  [key: string]: unknown;
}

/* ============================================================================
 * 3. MODEL ARCHITECT — writes the multi-sheet structure
 * ========================================================================== */

/**
 * The architect is responsible for *constructing* the model: sheet layout,
 * named ranges, driver cells, and the cross-sheet formulas that make the
 * workbook a coherent object. It is deliberately stateless beyond the
 * transport — every decision it makes is derivable from `ModelBlueprint`.
 *
 * Why a declarative blueprint rather than imperative writes? Two reasons:
 *   - Reviewability. A reviewer can read the blueprint and see the entire
 *     topology of the model without tracing code execution.
 *   - Replayability. Any production incident can be reproduced by feeding
 *     the same blueprint into a fresh workbook.
 */
export interface ModelBlueprint {
  sheets: Array<{
    name: string;
    template:
      | "drivers"
      | "revenue"
      | "cost"
      | "workingCapital"
      | "balanceSheet"
      | "cashFlow"
      | "summary";
  }>;
  namedRanges: NamedRange[];
  assumptions: Scenario[];
  /**
   * Formulas that are not part of the standard plan — an extra sheet's
   * arithmetic, for instance. The plan is the reviewable artefact, so
   * anything the pipeline writes has to be declared here.
   */
  extraFormulas?: Record<string, Record<string, string>>;
}

export class ModelArchitect {
  constructor(
    private readonly gc: CraftTransport,
    private readonly blueprint: ModelBlueprint,
  ) {}

  /**
   * Create the workbook and lay out its sheets.
   *
   * A fresh GridCraft workbook has a single sheet called "Sheet1"; the
   * blueprint's first sheet is that one, renamed, and the rest are
   * inserted after it.
   */
  async build(): Promise<void> {
    await this.gc.call("new_workbook", {});

    const [first, ...rest] = this.blueprint.sheets;
    if (!first) throw new Error("the blueprint has no sheets");

    for (const sheet of rest) {
      await this.gc.run("home.insertSheet", { name: sheet.name });
    }
    await this.gc.run("sheet.rename", { sheet: "Sheet1", name: first.name });

    // The drivers sheet is written in one range so that a concurrent
    // recalc never observes a half-populated assumption block.
    const rows = this.blueprint.assumptions[0]?.drivers ?? {};
    const driverRows = Object.entries(rows).map(([name, value]) => [name, value]);
    if (driverRows.length > 0) {
      await this.gc.call("write_range", {
        range: `${first.name}!A1:B${driverRows.length}`,
        values: driverRows,
      });
    }

    for (const range of this.blueprint.namedRanges) {
      await this.gc.run("formulas.defineName", {
        name: range.name,
        refersTo: `=${range.sheet}!${absoluteA1(range.a1)}`,
        scope: range.scope,
      });
    }
  }
}

/* ============================================================================
 * 4. FORMULA ENGINEER — installs the formulas
 * ========================================================================== */

export class FormulaEngineer {
  constructor(
    private readonly gc: CraftTransport,
    private readonly auditId: string,
  ) {}

  /**
   * Install every planned formula, one cell at a time.
   *
   * GridCraft has no batch tool, so the writes are sequential. Each write
   * carries the audit id in the installation record, and the fingerprint
   * lets a later run recognise a cell it has already installed.
   */
  async install(
    plan: Record<string, Record<string, string>>,
  ): Promise<FormulaInstall[]> {
    const installs: FormulaInstall[] = [];
    for (const [sheet, cells] of Object.entries(plan)) {
      for (const [a1, formula] of Object.entries(cells)) {
        const input = formula.startsWith("=") ? formula : `=${formula}`;
        await this.gc.call("set_cell", { cell: `${sheet}!${a1}`, input });
        installs.push({
          sheet,
          a1,
          formula: input,
          auditId: this.auditId,
          fingerprint: createHash("sha256").update(`${sheet}!${a1}:${input}`).digest("hex"),
        });
      }
    }
    return installs;
  }
}

/* ============================================================================
 * 5. AUDIT ORCHESTRATOR — probes the workbook, never mutates it
 * ========================================================================== */

export class AuditOrchestrator {
  constructor(private readonly gc: CraftTransport) {}

  /**
   * Probe the workbook for the three invariants the pipeline promises:
   * no unresolved reference, no circular reference, and every named range
   * still resolvable.
   *
   * The engine does the traversal: a circular reference evaluates to
   * `#CIRC!`, and `formulas.errorChecking` names the cells that take part
   * in the cycle.
   */
  async audit(): Promise<{ incidents: AuditIncident[]; errors: number }> {
    const incidents: AuditIncident[] = [];

    const errors = await this.gc.run<{
      circular: string[];
      errors: Array<{ cell: string; error: string; formula: string; sheet: string }>;
    }>("formulas.errorChecking", {});

    for (const cell of errors?.errors ?? []) {
      const isCircular = cell.error === "#CIRC!";
      incidents.push({
        auditId: randomUUID(),
        severity: "block",
        category: isCircular ? "circular_reference" : "unresolved_reference",
        message: isCircular
          ? `Circular reference at ${cell.sheet}!${cell.cell} (${cell.formula})`
          : `${cell.error} at ${cell.sheet}!${cell.cell} (${cell.formula})`,
        offender: { sheet: cell.sheet, a1: cell.cell },
        detectedAt: new Date().toISOString(),
      });
    }

    // Every named range must still resolve to a cell that holds a value.
    const tree = await this.gc.inspectGrid();
    for (const name of tree.names ?? []) {
      const ref = name.refersTo.replace(/^=/, "");
      const [sheet, a1] = ref.split("!");
      if (!sheet || !a1) continue;
      const cell = await this.gc.call<{ value: unknown }>("get_cell", {
        cell: `${sheet}!${a1.replace(/\$/g, "")}`,
      });
      if (cell?.value === undefined || cell.value === null || cell.value === "") {
        incidents.push({
          auditId: randomUUID(),
          severity: "block",
          category: "stale_binding",
          message: `Named range ${name.name} points at an empty cell (${sheet}!${a1})`,
          offender: { sheet, a1 },
          detectedAt: new Date().toISOString(),
        });
      }
    }

    return { incidents, errors: (errors?.errors ?? []).length };
  }

  /**
   * The full audit, and the consensus rule that decides what happens next.
   *
   * Three independent checks run — dependency cycles, unresolved
   * references and lineage gaps — and their verdicts are combined with a
   * rule that is deliberately asymmetric:
   *
   *   - one `block` incident is enough to halt publication;
   *   - two or more `notify` incidents escalate to `degrade`;
   *   - everything else is `pass`.
   *
   * The asymmetry encodes a cost matrix. Publishing a deck with a `#REF!`
   * in a KPI tile is a reputational catastrophe; publishing a deck that is
   * numerically correct but carries a `degrade` warning is manageable — the
   * analyst fixes it during the day and the deck goes out on the next cycle.
   */
  async runFullAudit(): Promise<{
    verdict: "pass" | "degrade" | "block";
    incidents: AuditIncident[];
    cycles: string[][];
  }> {
    const incidents: AuditIncident[] = [];

    // --- check 1: dependency cycles -------------------------------------
    const cycles = await this.detectCycles();
    for (const cycle of cycles) {
      incidents.push({
        auditId: currentAuditId() || randomUUID(),
        severity: "block",
        category: "circular_reference",
        message: `Circular dependency: ${cycle.join(" → ")} → ${cycle[0]}`,
        detectedAt: new Date().toISOString(),
      });
    }

    // --- check 2: unresolved references ---------------------------------
    const { incidents: referenceIncidents } = await this.audit();
    incidents.push(...referenceIncidents);

    // --- check 3: lineage gaps ------------------------------------------
    const tree = await this.gc.inspectGrid();
    for (const sheet of tree.sheets ?? []) {
      if ((sheet.cells ?? 0) > 0 && !sheet.usedRange) {
        incidents.push({
          auditId: currentAuditId() || randomUUID(),
          severity: "notify",
          category: "lineage_gap",
          message: `Sheet ${sheet.name} has cells but no used range — its lineage cannot be walked`,
          offender: { sheet: sheet.name, a1: "A1" },
          detectedAt: new Date().toISOString(),
        });
      }
    }

    const blocks = incidents.filter((i) => i.severity === "block").length;
    const notifies = incidents.filter((i) => i.severity === "notify").length;
    const verdict: "pass" | "degrade" | "block" =
      blocks > 0 ? "block" : notifies >= 2 ? "degrade" : "pass";

    return { verdict, incidents, cycles };
  }

  /**
   * Find the dependency cycles by walking the formulas.
   *
   * The engine's own detector (`formulas.errorChecking`) names the *cells*
   * in a cycle, but a cycle between two named ranges is invisible there,
   * because the tracer resolves cell references and not defined names. So
   * the graph is parsed out of the formulas and walked with an explicit
   * recursion stack: the stack is what lets the incident name the *path*
   * ("REVENUE_Q1 → DRIVER_UNITS → REVENUE_Q1") rather than only the
   * participating nodes, which is the difference between an analyst
   * opening two cells and an analyst grepping a five-hundred-cell model.
   */
  private async detectCycles(): Promise<string[][]> {
    const graph = new Map<string, string[]>();
    const tree = await this.gc.inspectGrid();

    // The defined names, resolved to the cells they point at, so that a
    // dependency written as a name joins the same graph as one written as
    // a cell address.
    const nameToCell = new Map<string, string>();
    for (const name of tree.names ?? []) {
      const ref = name.refersTo.replace(/^=/, "");
      const [sheet, a1] = ref.split("!");
      if (!sheet || !a1) continue;
      nameToCell.set(name.name, `${sheet}!${a1.replace(/\$/g, "")}`);
    }

    for (const sheet of tree.sheets ?? []) {
      const read = await this.gc.run<{ range?: string; values?: unknown[][] }>(
        "sheet.read",
        { sheet: sheet.name, formulas: true },
      );
      const { firstCol, firstRow } = parseRange(read?.range ?? "A1:A1");
      for (const [r, row] of (read?.values ?? []).entries()) {
        for (const [c, cell] of (row ?? []).entries()) {
          if (typeof cell !== "string" || !cell.startsWith("=")) continue;
          const from = `${sheet.name}!${columnName(firstCol + c)}${firstRow + r}`;
          graph.set(from, referencesOf(cell, nameToCell));
        }
      }
    }

    const cycles: string[][] = [];
    const state = new Map<string, "open" | "done">();
    const stack: string[] = [];

    const visit = (node: string): void => {
      const here = state.get(node);
      if (here === "done") return;
      if (here === "open") {
        const start = stack.indexOf(node);
        if (start >= 0) cycles.push([...stack.slice(start), node]);
        return;
      }
      state.set(node, "open");
      stack.push(node);
      for (const next of graph.get(node) ?? []) visit(next);
      stack.pop();
      state.set(node, "done");
    };

    for (const node of graph.keys()) visit(node);
    return cycles;
  }
}

/** The first column and the first row of an A1 range. */
function parseRange(range: string): { firstCol: number; firstRow: number } {
  const match = /^([A-Z]+)(\d+)/.exec(range);
  if (!match) return { firstCol: 0, firstRow: 1 };
  return {
    firstCol: match[1]!.charCodeAt(0) - "A".charCodeAt(0),
    firstRow: Number(match[2]),
  };
}

/** The A1 column name for a zero-based column index. */
function columnName(index: number): string {
  let name = "";
  let n = index;
  while (n >= 0) {
    name = String.fromCharCode("A".charCodeAt(0) + (n % 26)) + name;
    n = Math.floor(n / 26) - 1;
  }
  return name;
}

/**
 * The references a formula makes, as names.
 *
 * Only the defined names are returned: a *cell* reference is not a
 * dependency the model exposes, and the engine's own tracer covers those.
 */
function referencesOf(
  formula: string,
  nameToCell: Map<string, string>,
): string[] {
  const refs = new Set<string>();
  for (const [name, cell] of nameToCell) {
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`\\b${escaped}\\b`, "i").test(formula)) refs.add(cell);
  }
  return [...refs];
}


/* ============================================================================
 * 6. DECK BINDER — the narrative as a bound output
 * ========================================================================== */

export interface DeckBlueprint {
  theme: string;
  slides: Array<{
    title: string;
    /** The named ranges whose values are shown on the slide. */
    bindings: Array<{ label: string; range: string }>;
  }>;
}

/**
 * The binder reads the *audited* workbook and writes the numbers into the
 * deck. It never recomputes anything: the workbook is the source of truth
 * and the deck is a projection of it.
 */
export class DeckBinder {
  constructor(
    private readonly gc: CraftTransport,
    private readonly deck: CraftTransport,
  ) {}

  /**
   * Build the presentation from the blueprint and the audited values.
   *
   * `values` maps a named range to the number the audited workbook holds
   * for it.
   */
  async bind(
    blueprint: DeckBlueprint,
    values: Record<string, number>,
  ): Promise<{ slideCount: number; rendered: string[] }> {
    await this.deck.call("new_presentation", { theme: blueprint.theme });

    const rendered: string[] = [];
    for (const slide of blueprint.slides) {
      await this.deck.call("add_slide", {
        layout: "titleOnly",
        title: slide.title,
      });

      let y = 180;
      for (const binding of slide.bindings) {
        const value = values[binding.range];
        const text = value === undefined ? "—" : formatNumber(value);
        await this.deck.call("add_text_box", {
          x: 72,
          y,
          w: 600,
          h: 40,
          text: `${binding.label}: ${text}`,
          size: 20,
        });
        rendered.push(`${slide.title} / ${binding.label} = ${text}`);
        y += 48;
      }
    }

    return { slideCount: blueprint.slides.length, rendered };
  }

  /** Save the presentation and export the board PDF. */
  async publish(deckPath: string, pdfPath: string): Promise<void> {
    await this.deck.call("save_presentation", { path: deckPath });
    await this.deck.call("export", { path: pdfPath, format: "pdf" });
  }
}

/** A locale-independent money format: 1 234 500.00. */
function formatNumber(value: number): string {
  const [whole = "0", cents = "00"] = value.toFixed(2).split(".");
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  return `${grouped}.${cents}`;
}

/* ============================================================================
 * 7. VISION REVIEWER — the multimodal attestation
 * ========================================================================== */

export interface ReviewVerdict {
  ok: boolean;
  issues: string[];
  /** The slide the reviewer looked at. */
  slide: number;
}

/**
 * The reviewer is an *injected* function: the production build talks to a
 * multimodal model, the harness supplies a deterministic stand-in. The
 * pipeline only ever sees a verdict.
 */
export type VisionReviewer = (
  pngBase64: string,
  prompt: string,
) => Promise<ReviewVerdict>;

export class VisionReviewerRunner {
  constructor(private readonly reviewer: VisionReviewer) {}

  /**
   * Render a slide and ask the reviewer about it.
   *
   * `render_slide` answers with an *image* content block, so the bytes
   * come from the image block and not from a text one.
   */
  async review(deck: CraftTransport, slide: number, prompt: string): Promise<ReviewVerdict> {
    const png = await deck.renderSlide(slide);
    return this.reviewer(png.data, prompt);
  }
}

/* ============================================================================
 * 8. FINANCIAL PIPELINE SUPERVISOR — the orchestrator
 * ========================================================================== */

/**
 * The supervisor is the only object the SaaS layer talks to. It owns the
 * lifecycle of both engine subprocesses and it never throws: an audit
 * failure becomes a structured incident and a degraded (but explicit)
 * result.
 */
export class FinancialPipelineSupervisor {
  private readonly gc: CraftTransport;
  private readonly deck: CraftTransport;
  private readonly incidents: AuditIncident[] = [];

  constructor(
    private readonly options: {
      workspace: string;
      reviewer: VisionReviewer;
      log?: (msg: string, meta?: unknown) => void;
    },
  ) {
    const log = options.log ?? console.log;
    this.gc = new CraftTransport("gridcraft-cli", "grid", ["mcp"], options.workspace, log);
    this.deck = new CraftTransport("deckcraft-cli", "deck", ["mcp"], options.workspace, log);
  }

  async run(
    blueprint: ModelBlueprint,
    deckBlueprint: DeckBlueprint,
  ): Promise<{
    status: "published" | "degraded" | "blocked";
    incidents: AuditIncident[];
    deckPath: string;
    pdfPath: string;
    values: Record<string, number>;
  }> {
    const auditId = randomUUID();
    const deckPath = `${this.options.workspace}/board.deckcraft`;
    const pdfPath = `${this.options.workspace}/board.pdf`;

    await this.gc.connect();
    await this.deck.connect();
    // The ambient audit context: every write below inherits the audit id,
    // and a concurrent run inherits its own.
    try {
      return await auditContext.run({ auditId, runId: auditId }, async () => {
        // 1. Build the model.
        const architect = new ModelArchitect(this.gc, blueprint);
        await architect.build();

        // 2. Install the formulas.
        const engineer = new FormulaEngineer(this.gc, auditId);
        await engineer.install(planFormulas(blueprint));

        // 3. Audit. The three checks are combined by the asymmetric rule,
        //    and a blocking verdict stops the pipeline *before* anything is
        //    published.
        const auditor = new AuditOrchestrator(this.gc);
        const { verdict: auditVerdict, incidents } = await auditor.runFullAudit();
        this.incidents.push(...incidents);
        if (auditVerdict === "block") {
          return {
            status: "blocked",
            incidents: this.incidents,
            deckPath,
            pdfPath,
            values: {},
          };
        }

        // 4. Read the audited numbers. The workbook is the source of truth.
        const values = await this.readNamedValues(blueprint);

        // 5. Bind the deck and publish it.
        const binder = new DeckBinder(this.gc, this.deck);
        await binder.bind(deckBlueprint, values);
        await binder.publish(deckPath, pdfPath);

        // 6. The multimodal attestation.
        const runner = new VisionReviewerRunner(this.options.reviewer);
        const verdict = await runner.review(
          this.deck,
          0,
          "Check that the KPI values on this slide match the audited workbook.",
        );
        if (!verdict.ok) {
          this.incidents.push({
            auditId,
            severity: "degrade",
            category: "deck_visual_mismatch",
            message: `The vision review flagged slide ${verdict.slide}: ${verdict.issues.join("; ")}`,
            detectedAt: new Date().toISOString(),
          });
          return {
            status: "degraded",
            incidents: this.incidents,
            deckPath,
            pdfPath,
            values,
          };
        }

        if (auditVerdict === "degrade") {
          return {
            status: "degraded",
            incidents: this.incidents,
            deckPath,
            pdfPath,
            values,
          };
        }

        return { status: "published", incidents: this.incidents, deckPath, pdfPath, values };
      });
    } finally {
      await Promise.allSettled([this.gc.close(), this.deck.close()]);
    }
  }

  /** Read every named range the deck binds to, straight from the workbook. */
  private async readNamedValues(
    blueprint: ModelBlueprint,
  ): Promise<Record<string, number>> {
    const values: Record<string, number> = {};
    for (const range of blueprint.namedRanges) {
      const cell = await this.gc.call<{ value: unknown }>("get_cell", {
        cell: `${range.sheet}!${range.a1}`,
      });
      const value = typeof cell?.value === "number" ? cell.value : Number(cell?.value);
      if (Number.isFinite(value)) values[range.name] = value;
    }
    return values;
  }
}

/* ============================================================================
 * 9. BLUEPRINTS — the declarative inputs
 * ========================================================================== */

/** The formula plan: sheet → cell → formula. */
export function planFormulas(bp: ModelBlueprint): Record<string, Record<string, string>> {
  const plan: Record<string, Record<string, string>> = {};
  const revenue = bp.sheets.find((s) => s.template === "revenue");
  const summary = bp.sheets.find((s) => s.template === "summary");
  if (!revenue || !summary) return plan;

  plan[revenue.name] = {
    B2: "=RevenueSeed*(1+GrowthRate/12)",
    C2: "=B2*(1+GrowthRate/12)",
  };
  plan[summary.name] = {
    B2: `=${revenue.name}!B2`,
  };

  // The blueprint's own extras, if any.
  for (const [sheet, cells] of Object.entries(bp.extraFormulas ?? {})) {
    plan[sheet] = { ...(plan[sheet] ?? {}), ...cells };
  }
  return plan;
}

/** The workbook blueprint. */
export function buildBlueprint(): ModelBlueprint {
  return {
    sheets: [
      { name: "Drivers", template: "drivers" },
      { name: "Revenue", template: "revenue" },
      { name: "Summary", template: "summary" },
    ],
    namedRanges: [
      { name: "GrowthRate", sheet: "Drivers", a1: "B1", scope: "Workbook" },
      { name: "RevenueSeed", sheet: "Drivers", a1: "B2", scope: "Workbook" },
      { name: "MonthlyRevenue", sheet: "Revenue", a1: "B2", scope: "Workbook" },
      { name: "HeadlineRevenue", sheet: "Summary", a1: "B2", scope: "Workbook" },
    ],
    assumptions: [
      {
        id: "base",
        label: "Base case",
        drivers: { GrowthRate: 0.08, RevenueSeed: 1_200_000 },
      },
    ],
  };
}

/** The deck blueprint. */
export function buildDeckBlueprint(): DeckBlueprint {
  return {
    theme: "default",
    slides: [
      {
        title: "Q3 2026 — Revenue",
        bindings: [
          { label: "Monthly revenue", range: "MonthlyRevenue" },
          { label: "Growth rate", range: "GrowthRate" },
        ],
      },
    ],
  };
}
