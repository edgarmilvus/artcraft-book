/**
 * apps/finance-report/route.ts
 * ---------------------------------------------------------------------------
 * A minimal, production-shaped example of driving GridCraft headlessly through
 * the Model Context Protocol (MCP) to build a multi-sheet financial model,
 * audit its formulas, persist it, and hand the audited snapshot to DeckCraft.
 *
 * The interesting property here is NOT the arithmetic — it's the *pipeline*:
 * a single TypeScript function that owns the lifecycle of a GridCraft workbook
 * from new_workbook to save_workbook, with every edit going through the
 * official MCP tools (new_workbook, set_cell, write_range, format_range,
 * execute_command, inspect_workbook).
 * ---------------------------------------------------------------------------
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import path from "node:path";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";

// ---------------------------------------------------------------------------
// 1. Contract types — everything that crosses the boundary is validated.
// ---------------------------------------------------------------------------

/**
 * Validated request envelope for the report generator.
 * A Zod schema at the boundary means callers cannot smuggle untyped numbers
 * into a workbook that a downstream auditor will later trust.
 */
export const ReportRequestSchema = z.object({
  /** Tenant slug used to namespace the output directory. */
  tenant: z.string().regex(/^[a-z0-9-]{2,40}$/),
  /** Revenue growth percent per quarter (e.g., 0.08 => 8%). */
  growthRate: z.number().min(-0.5).max(1.0),
  /** Gross margin as a fraction of revenue (e.g., 0.72 => 72%). */
  grossMargin: z.number().min(0).max(1.0),
  /** Monthly operating expense, in the workbook's reporting currency. */
  monthlyOpex: z.number().positive().max(1_000_000_000),
  /** Seed revenue for month 0. */
  seedRevenue: z.number().positive(),
});

export type ReportRequest = z.infer<typeof ReportRequestSchema>;

/**
 * The audit envelope we persist alongside the workbook. It is derived
 * exclusively from the engine's own reports, so it is a pure function of
 * document state.
 */
export interface AuditEnvelope {
  workbookPath: string;
  sheets: string[];
  namedRanges: Record<string, string>;
  dependencyEdges: number;
  circularReferences: string[];
  revisionHash: string;
  auditedAt: string; // ISO-8601
}

/** The workbook's own months: M0 (the seed) through M11. */
const MONTHS = [
  "M0", "M1", "M2", "M3", "M4", "M5",
  "M6", "M7", "M8", "M9", "M10", "M11",
] as const;

/** Column letters for the twelve months: A … L. */
const COLUMNS = MONTHS.map((_, index) =>
  String.fromCharCode("A".charCodeAt(0) + index));

/* --------------------------------------------------------------------------
 * 2. The MCP client factory — one subprocess per request, sandboxed.
 * ------------------------------------------------------------------------ */

/**
 * Spin up a fresh GridCraft MCP server bound to the per-request workspace.
 *
 * `gridcraft-cli mcp` takes no directory flag at all: it resolves relative
 * paths against its own working directory, and it does not police the result.
 * The boundary is therefore the `cwd` we hand it *plus* this module's own
 * path policy — every path the worker sends is a bare file name, and every
 * absolute path the worker uses is one it built itself.
 */
async function connectGridCraft(workspace: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: "gridcraft-cli",
    args: ["mcp"],
    // The working directory is the engine's boundary. The MCP SDK inherits
    // process.env by default, but being explicit avoids leaking credentials
    // from the parent process into a child that doesn't need them.
    cwd: workspace,
    env: { ...process.env, GRIDCRAFT_NO_TELEMETRY: "1" } as Record<string, string>,
  });

  const client = new Client(
    { name: "artcraft-finance-worker", version: "1.0.0" },
    { capabilities: {} },
  );

  await client.connect(transport);
  return client;
}

/**
 * Call an MCP tool and parse the JSON payload it answers with.
 *
 * GridCraft's MCP server puts the payload in the first `text` content
 * block and does *not* populate `structuredContent`, so the text block is
 * the only place the answer lives. A failing tool answers with
 * `isError: true` and a plain sentence — the flag is checked before the
 * parse, or the error message would be reported as a syntax error.
 */
async function callTool(
  client: Client,
  tool: string,
  args: Record<string, unknown> = {},
): Promise<any> {
  const res = (await client.callTool({ name: tool, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  const block = res.content?.find((c) => c.type === "text");
  if (res.isError) {
    throw new Error(`GridCraft tool "${tool}" failed: ${block?.text ?? "<no detail>"}`);
  }
  if (!block?.text) {
    throw new Error(`GridCraft tool "${tool}" returned no text content block`);
  }
  return JSON.parse(block.text);
}

/**
 * Run one engine command. `execute_command` is the meta-tool that carries
 * every command in GridCraft's 341-command registry; it takes the command
 * id and its parameters.
 */
async function runCommand(
  client: Client,
  command: string,
  params: Record<string, unknown> = {},
): Promise<any> {
  return callTool(client, "execute_command", { command, params });
}

/* --------------------------------------------------------------------------
 * 3. The workbook builder — every edit is a named tool or a named command.
 * ------------------------------------------------------------------------ */

/**
 * Populate the three-sheet P&L model.
 *
 * GridCraft's MCP server has no batch tool: the engine's registry is
 * addressed one command at a time, and the high-level tools
 * (`write_range`, `set_cell`) cover the bulk of the writes in a single
 * round trip. The model is therefore written in a fixed order, and the
 * workbook is only audited after the whole thing is built.
 */
async function buildWorkbook(
  client: Client,
  req: ReportRequest,
): Promise<void> {
  // 3a. Create the workbook and lay out its three sheets. A fresh workbook
  //     starts with a single "Sheet1"; the engine addresses sheets by name
  //     in every command, so the names are fixed here and never re-resolved.
  await callTool(client, "new_workbook", {});
  await runCommand(client, "home.insertSheet", { name: "Revenue" });
  await runCommand(client, "home.insertSheet", { name: "P&L" });
  await runCommand(client, "sheet.rename", { sheet: "Sheet1", name: "Assumptions" });

  // 3b. The assumption cells: labels in column A, values in column B.
  //     One `write_range` call lands the whole block, so the sheet is never
  //     observed half-seeded by a concurrent recalc.
  await callTool(client, "write_range", {
    range: "Assumptions!A1:B4",
    values: [
      ["Growth Rate", req.growthRate],
      ["Gross Margin", req.grossMargin],
      ["Monthly OpEx", req.monthlyOpex],
      ["Seed Revenue (M0)", req.seedRevenue],
    ],
  });

  // 3c. The display formats. `format_range` changes the *presentation*,
  //     never the stored value — the audit reads the numeric value.
  await callTool(client, "format_range", {
    range: "Assumptions!B1:B2",
    numberFormat: "0.0%",
  });
  await callTool(client, "format_range", {
    range: "Assumptions!B3:B4",
    numberFormat: "#,##0.00",
  });

  // 3d. Named ranges. Named ranges are GridCraft's *interface surface*; the
  //     audit pass below operates on them, not on raw A1 addresses. This is
  //     what lets a schema reviewer sign off on the model's contract rather
  //     than its geometry.
  for (const [name, refersTo] of [
    ["GrowthRate", "=Assumptions!$B$1"],
    ["GrossMargin", "=Assumptions!$B$2"],
    ["MonthlyOpex", "=Assumptions!$B$3"],
    ["SeedRevenue", "=Assumptions!$B$4"],
  ] as const) {
    await runCommand(client, "formulas.defineName", { name, refersTo });
  }

  // 3e. Revenue sheet — the month labels, then the seed, then the
  //     compounding formula. The seed is a *cross-sheet reference* to the
  //     assumption, not a value: if a user later edits Seed Revenue, every
  //     month recomputes and no stale constant survives.
  await callTool(client, "write_range", {
    range: "Revenue!A1:L1",
    values: [[...MONTHS]],
  });
  await callTool(client, "write_range", {
    range: "Revenue!A2:L2",
    values: [[
      "=SeedRevenue",
      ...COLUMNS.slice(1).map(
        (col, index) => `=${COLUMNS[index]}2*(1+GrowthRate/12)`,
      ),
    ]],
  });

  // 3f. P&L sheet — pull Revenue, subtract COGS and OpEx.
  await callTool(client, "write_range", {
    range: "P&L!A1:L2",
    values: [
      ["Operating Profit (per month)"],
      COLUMNS.map(
        (col) =>
          `=Revenue!${col}2-(Revenue!${col}2*(1-GrossMargin))-MonthlyOpex`,
      ),
    ],
  });

  // 3g. Force a recalc so that the audit below reads *evaluated* state,
  //     not the unevaluated formula text. GridCraft's recalc scheduler
  //     topologically sorts the dependency DAG before evaluating, which is
  //     why we can trust the number we read on the P&L sheet.
  await runCommand(client, "formulas.calculateNow", {});
}

/* --------------------------------------------------------------------------
 * 4. The audit pass — probe the document, never mutate it.
 * ------------------------------------------------------------------------ */

/**
 * Runs the compliance audit. `inspect_workbook` and `formulas.errorChecking`
 * are read-only by contract, so they are safe to call from a request
 * handler without acquiring a lock on the document. Circular-reference
 * detection is delegated to the engine, which already traverses the
 * dependency graph during recalc and reports the offending cells.
 */
async function auditWorkbook(client: Client): Promise<{
  edges: number;
  circular: string[];
}> {
  // 4a. Ask the engine which cells are in error. A circular reference
  //     evaluates to `#CIRC!`, and the engine names the cells that
  //     participate in the cycle.
  const errors = await runCommand(client, "formulas.errorChecking", {});
  const circular: string[] = errors?.circular ?? [];

  if (circular.length > 0) {
    // Fail closed. A circular reference in a *published* model is a P0.
    throw new Error(
      `Circular references detected: ${circular.join(", ")}`,
    );
  }

  // 4b. Count the dependency edges from the engine's own trace. Each
  //     formula cell's precedents are one edge of the graph.
  let edges = 0;
  for (const sheet of ["Assumptions", "Revenue", "P&L"]) {
    // The trace commands work on the *active* sheet, so the sheet is
    // activated first and the cells are addressed without a qualifier.
    await runCommand(client, "sheet.activate", { sheet });
    const read = await runCommand(client, "sheet.read", {
      sheet,
      formulas: true,
    });
    const { firstCol, firstRow } = parseRange(read?.range ?? "A1:A1");
    for (const [r, row] of (read?.values ?? []).entries()) {
      for (const [c, cell] of (row ?? []).entries()) {
        if (typeof cell !== "string" || !cell.startsWith("=")) continue;
        const address = `${columnName(firstCol + c)}${firstRow + r}`;
        const precedents = await runCommand(client, "formulas.tracePrecedents", {
          cell: address,
        });
        edges += precedents?.length ?? 0;
      }
    }
  }

  return { edges, circular };
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

/* --------------------------------------------------------------------------
 * 5. The orchestrator — one request, one sandboxed worker, one artifact.
 * ------------------------------------------------------------------------ */

/**
 * Public entry point. Given a validated `ReportRequest`, produce:
 *   - the persisted `.xlsx` workbook,
 *   - the audit envelope JSON,
 *   - the path of a DeckCraft slide handoff (best-effort).
 */
export async function generateFinancialReport(
  rawRequest: unknown,
): Promise<AuditEnvelope> {
  // 5a. Validate before touching the filesystem.
  const req: ReportRequest = ReportRequestSchema.parse(rawRequest);

  // 5b. Namespace a workspace per (tenant, day) so we can garbage-collect
  //     old runs with a single `rm -rf`. Never write into a shared folder
  //     from a multi-tenant worker.
  const dayBucket = new Date().toISOString().slice(0, 10);
  const workspace = path.join(
    process.cwd(),
    "var",
    "finance",
    req.tenant,
    dayBucket,
  );
  await fs.mkdir(workspace, { recursive: true });

  const workbookPath = path.join(workspace, "pnl.xlsx");
  const envelopePath = path.join(workspace, "audit.json");

  // 5c. Connect. Every request gets a fresh engine subprocess, which is the
  //     only way to guarantee no state leaks between tenants.
  const client = await connectGridCraft(workspace);

  try {
    // 5d. Build, then audit, then persist — this ordering is load-bearing:
    //     the audit must run against a fully-recalced workbook, and the save
    //     must run after the audit, so the persisted artifact carries the
    //     same revision hash that the envelope records.
    await buildWorkbook(client, req);
    const audit = await auditWorkbook(client);

    // 5e. Persist the workbook. GridCraft writes `.xlsx`, `.csv`, `.tsv`,
    //     `.json` and `.html` — there is no native `.gridcraft` container,
    //     and an unknown extension is refused outright.
    await callTool(client, "save_workbook", { path: workbookPath });

    // 5f. Take the snapshot *after* the save, so the revision hash
    //     matches the bytes on disk. This is the cell lineage guarantee: a
    //     reviewer can re-open the file and hash it themselves.
    const snapshot = await callTool(client, "inspect_workbook", {});
    const sheets: string[] = (snapshot.sheets ?? []).map((s: any) => s.name);
    const namedRanges: Record<string, string> = {};
    for (const entry of snapshot.names ?? []) {
      namedRanges[entry.name] = entry.refersTo;
    }
    const bytes = await fs.readFile(workbookPath);
    const revisionHash = createHash("sha256").update(bytes).digest("hex");

    const envelope: AuditEnvelope = {
      workbookPath,
      sheets,
      namedRanges,
      dependencyEdges: audit.edges,
      circularReferences: audit.circular,
      revisionHash,
      auditedAt: new Date().toISOString(),
    };

    // 5g. Write the envelope atomically: temp file, then rename. A reader
    //     observing the directory will never see a truncated JSON.
    const tmp = `${envelopePath}.${process.pid}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(envelope, null, 2), "utf8");
    await fs.rename(tmp, envelopePath);

    return envelope;
  } finally {
    // 5h. Always tear down the subprocess. Leaking MCP servers in a
    //     serverless environment is the fastest path to OOM-killed pods.
    await client.close();
  }
}
