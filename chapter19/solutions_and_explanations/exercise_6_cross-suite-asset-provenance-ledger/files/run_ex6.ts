// run_ex6.ts — the harness for the cross-suite provenance ledger.
//
// It runs the real pipeline: LightCraft grades the raw, PhotoCraft builds
// the mock-up, DesignCraft lays out the catalogue, PdfCraft checks and
// archives the PDF — every call going through the wrapper shim, every hop
// landing in the SQLite ledger. Then it audits the ledger the way a
// compliance bot would: it replays the hash chain, runs the query contract
// both in TypeScript and in the `sqlite3` command line, and reconciles the
// files on disk against the recorded calls.
//
// The harness needs no API key and no network.

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import type { ProvenanceHop as ContractHop, ProvenanceQuery } from "./02_typescript.js";
import {
  canonicalJson,
  detectIde,
  Ledger,
  reconcileArtefacts,
  runStudioRun,
  SCHEMA_SQL,
  uuidv7,
  type CraftApp,
  type HopRecord,
  type Json,
  type ProvenanceRow,
} from "./06_cross-suite-asset-provenance-ledger-stretch.js";

// The exercise's own directory, so the harness can be run from anywhere.
const FILES = resolve(fileURLToPath(import.meta.url), "..");
const OUTPUT = resolve(FILES, "..", "output");
const WORK = resolve(OUTPUT, "work");
const LEDGER_PATH = resolve(WORK, "provenance.sqlite");
const AUDIT = resolve(OUTPUT, "audit");
const HMAC_KEY = Buffer.from(
  "2f7c1d0b9a4e6358c0d1f2a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f",
  "hex",
);

let passed = 0;
function ok(label: string, condition: boolean, detail = ""): void {
  if (!condition) {
    console.error(`FAIL ${label}${detail ? ` — ${detail}` : ""}`);
    process.exit(1);
  }
  passed += 1;
  console.log(`PASS ${label}`);
}

function equal<T>(label: string, actual: T, expected: T): void {
  ok(label, Object.is(actual, expected), `expected ${String(expected)}, got ${String(actual)}`);
}

/** The item at an index, or the harness stops. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) {
    throw new Error(`the harness expected an item at ${String(index)}`);
  }
  return item;
}

/**
 * An independent canonical JSON writer. The harness must not borrow the
 * solution's own serialiser, or the digest check proves nothing.
 */
function independentCanonical(value: Json): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(independentCanonical).join(",")}]`;
  }
  const record = value as { [key: string]: Json };
  const keys = Object.keys(record).sort();
  return `{${keys
    .map((key) => {
      const member = record[key];
      if (member === undefined) {
        throw new Error(`the harness expected a member at ${key}`);
      }
      return `${JSON.stringify(key)}:${independentCanonical(member)}`;
    })
    .join(",")}}`;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function sqlite3Available(): boolean {
  try {
    execFileSync("sqlite3", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runSqlite(sql: string, database = ":memory:"): string {
  return execFileSync("sqlite3", ["-batch", "-noheader", "-separator", "|", database], {
    input: sql,
    encoding: "utf8",
  });
}

/**
 * Start an engine's MCP server and wait for its `initialize` answer. The
 * engines that do not take the automation roots say so and exit; the ones
 * that do answer with their server info.
 */
function startEngine(
  binary: string,
  args: string[],
): Promise<{ accepted: boolean; version?: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: {
      accepted: boolean;
      version?: string;
      error?: string;
    }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      resolve(result);
    };
    const timer = setTimeout(
      () => finish({ accepted: false, error: "the engine did not answer" }),
      20_000,
    );
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim().length === 0) continue;
        try {
          const frame = JSON.parse(line) as {
            result?: { serverInfo?: { version?: string } };
          };
          const version = frame.result?.serverInfo?.version;
          if (version !== undefined) finish({ accepted: true, version });
        } catch {
          // Not a frame: keep reading.
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("exit", (code) => {
      finish({ accepted: false, error: stderr.trim() || `exit ${String(code)}` });
    });
    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "harness", version: "0" },
        },
      })}\n`,
    );
  });
}

async function main(): Promise<void> {
  rmSync(WORK, { recursive: true, force: true });
  rmSync(AUDIT, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  mkdirSync(AUDIT, { recursive: true });

  // ── the pipeline, for real ───────────────────────────────────────────────
  const run = await runStudioRun({
    workDir: WORK,
    ledgerPath: LEDGER_PATH,
    hmacKey: HMAC_KEY,
    ide: "opencode",
  });

  ok("the ingest raw was written", existsSync(run.rawPath), run.rawPath);
  ok(
    "the raw is a PNG",
    readFileSync(run.rawPath).subarray(0, 8).toString("hex") === "89504e470d0a1a0a",
  );
  equal(
    "the asset root is the hash of the raw",
    run.assetRootId,
    sha256(readFileSync(run.rawPath)),
  );
  ok("the ledger file was written", existsSync(LEDGER_PATH), LEDGER_PATH);
  ok(
    "the ledger is a SQLite database",
    readFileSync(LEDGER_PATH).subarray(0, 15).toString("latin1") === "SQLite format 3",
  );

  // ── the hops ─────────────────────────────────────────────────────────────
  const ledger = Ledger.open(LEDGER_PATH, HMAC_KEY);
  const rows = ledger.rows(run.assetRootId);
  const intents = ledger.intentRows();
  const report = ledger.verify();

  equal("the pipeline made eighteen hops", run.hops.length, 18);
  equal("the ledger holds one row per hop", rows.length, run.hops.length);
  equal("every hop announced itself first", intents.length, run.hops.length);

  const apps = rows.map((row) => row.app);
  const byApp = (app: CraftApp): number => apps.filter((a) => a === app).length;
  equal("lightcraft made three hops", byApp("lightcraft"), 3);
  equal("photocraft made five hops", byApp("photocraft"), 5);
  equal("designcraft made seven hops", byApp("designcraft"), 7);
  equal("pdfcraft made three hops", byApp("pdfcraft"), 3);

  const rowWith = (needle: string, app?: CraftApp): ProvenanceRow | undefined =>
    rows.find(
      (row) => row.tool_call.includes(needle) && (app === undefined || row.app === app),
    );

  const firstHop = at(rows, 0);
  ok(
    "the first hop is the lightcraft develop",
    firstHop.tool_call.includes("develop.set") && firstHop.app === "lightcraft",
    firstHop.tool_call,
  );
  ok(
    "the develop hop names the lightcraft command",
    firstHop.tool_call.includes('"id":"develop.set"'),
    firstHop.tool_call,
  );
  ok(
    "the render hop is lightcraft's render_photo",
    at(rows, 1).tool_call.includes("render_photo") && at(rows, 1).app === "lightcraft",
    at(rows, 1).tool_call,
  );
  ok(
    "the tiff export is a lightcraft app.export",
    at(rows, 2).tool_call.includes("app.export") && at(rows, 2).tool_call.includes("tiff"),
    at(rows, 2).tool_call,
  );
  ok(
    "the mock-up is placed with photocraft's doc_place",
    rowWith("doc_place", "photocraft") !== undefined,
    rows.map((row) => row.tool_call).join(" | "),
  );
  ok(
    "the mock-up is captioned with photocraft's type.create",
    rowWith("type.create", "photocraft") !== undefined,
  );
  ok(
    "the mock-up is saved as a .pcraft master",
    rowWith("banner.pcraft", "photocraft") !== undefined,
  );
  ok(
    "the mock-up is also saved as a placed image",
    rowWith("banner.png", "photocraft") !== undefined,
  );
  ok(
    "the catalogue is laid out with designcraft's place_image",
    rowWith("place_image", "designcraft") !== undefined,
    rows.map((row) => row.tool_call).join(" | "),
  );
  ok(
    "the catalogue is rendered with designcraft's render_page",
    rows.filter((row) => row.tool_call.includes("render_page")).length === 2,
  );
  ok(
    "the catalogue leaves designcraft as a PDF",
    rowWith("file.exportPdf", "designcraft") !== undefined,
  );
  ok(
    "the PDF is checked with pdfcraft's pdfa_verify",
    rowWith("pdfa_verify", "pdfcraft") !== undefined,
  );
  ok(
    "the PDF is archived with pdfcraft's doc_save",
    rowWith("doc_save", "pdfcraft") !== undefined,
  );

  // ── the recorded facts ───────────────────────────────────────────────────
  const versions = new Map<string, string>();
  for (const row of rows) versions.set(row.app, row.binary_version);
  equal("lightcraft's version came from the engine", versions.get("lightcraft"), "0.5.0");
  equal("photocraft's version came from the engine", versions.get("photocraft"), "0.8.2");
  equal("designcraft's version came from the engine", versions.get("designcraft"), "0.4.0");
  equal("pdfcraft's version came from the engine", versions.get("pdfcraft"), "0.5.0");

  ok(
    "every row carries the IDE that made the call",
    rows.every((row) => row.ide === "opencode"),
    rows.map((row) => row.ide).join(","),
  );
  ok(
    "every row carries the workstation operator",
    rows.every((row) => row.operator.length > 0),
  );
  ok(
    "every digest is a sha256",
    rows.every((row) => /^[0-9a-f]{64}$/.test(row.result_digest)),
  );
  ok(
    "the digests are not all the same",
    new Set(rows.map((row) => row.result_digest)).size === rows.length,
  );

  // The digest has to be the digest of the result the engine really
  // returned, computed by an independent serialiser.
  const digestsMatch = run.hops.every((hop: HopRecord, index: number) => {
    const row = rows[index];
    if (row === undefined) return false;
    if (row.tool_call !== hop.toolCall) return false;
    return row.result_digest === sha256(independentCanonical(hop.payload));
  });
  ok("every digest is the sha256 of the result that came back", digestsMatch);

  // ── the hash chain ───────────────────────────────────────────────────────
  ok("the replay of the ledger is clean", report.ok, JSON.stringify(report.failures));
  equal("the replay saw every hop", report.hops, rows.length);

  // The auditor is handed one file, so the write-ahead log is folded in
  // before the ledger is copied for the tamper tests.
  ledger.checkpoint();

  const tampered = resolve(AUDIT, "tampered.sqlite");
  writeFileSync(tampered, readFileSync(LEDGER_PATH));
  const tamperDb = new DatabaseSync(tampered);
  tamperDb.exec(
    "UPDATE provenance SET result_digest = '0000000000000000000000000000000000000000000000000000000000000000' WHERE seq = (SELECT min(seq) FROM provenance);",
  );
  tamperDb.close();
  const tamperedLedger = Ledger.open(tampered, HMAC_KEY);
  const tamperedReport = tamperedLedger.verify();
  ok(
    "a flipped character breaks the chain",
    !tamperedReport.ok && tamperedReport.failures[0]?.code === "CHAIN_BROKEN",
    JSON.stringify(tamperedReport.failures),
  );
  tamperedLedger.close();

  const dropped = resolve(AUDIT, "dropped.sqlite");
  writeFileSync(dropped, readFileSync(LEDGER_PATH));
  const dropDb = new DatabaseSync(dropped);
  dropDb.exec("PRAGMA foreign_keys = OFF;");
  dropDb.exec("DELETE FROM provenance WHERE seq = (SELECT min(seq) FROM provenance);");
  dropDb.close();
  const droppedLedger = Ledger.open(dropped, HMAC_KEY);
  const droppedReport = droppedLedger.verify();
  ok(
    "a deleted hop breaks the chain",
    !droppedReport.ok && droppedReport.failures.length > 0,
    JSON.stringify(droppedReport.failures),
  );
  droppedLedger.close();

  const orphan = resolve(AUDIT, "orphan.sqlite");
  writeFileSync(orphan, readFileSync(LEDGER_PATH));
  const orphanDb = new DatabaseSync(orphan);
  orphanDb.exec("PRAGMA foreign_keys = OFF;");
  orphanDb.exec("DELETE FROM provenance_intent WHERE seq = (SELECT min(seq) FROM provenance_intent);");
  orphanDb.close();
  const orphanLedger = Ledger.open(orphan, HMAC_KEY);
  const orphanReport = orphanLedger.verify();
  ok(
    "a hop without its intent is caught",
    !orphanReport.ok &&
      orphanReport.failures.some((failure) => failure.code === "INTENT_MISSING"),
    JSON.stringify(orphanReport.failures),
  );
  orphanLedger.close();

  // ── the query contract ──────────────────────────────────────────────────
  // The shim's ledger answers the contract the exercise asks for; the
  // assignment below is checked by the compiler.
  const contract: ProvenanceQuery = ledger;
  const contractHops: ContractHop[] = await contract.traceProvenance(run.assetRootId);
  equal("the ledger answers the query contract", contractHops.length, rows.length);

  const hops = await ledger.traceProvenance(run.assetRootId);
  equal("the trace returns every hop of the asset", hops.length, rows.length);
  ok(
    "the trace is ordered by event id",
    hops.every((hop, index) => index === 0 || hop.eventId > at(hops, index - 1).eventId),
  );
  ok(
    "every hop but the first has a parent",
    hops.slice(1).every((hop) => hop.parentEventId !== null) &&
      at(hops, 0).parentEventId === null,
  );
  ok(
    "the parents chain the hops together",
    hops.every(
      (hop, index) => index === 0 || hop.parentEventId === at(hops, index - 1).eventId,
    ),
    hops.map((hop) => hop.parentEventId).join(","),
  );

  const pageZero = await ledger.traceProvenance(run.assetRootId, 0);
  ok(
    "the page hint narrows the chain",
    pageZero.length < hops.length && pageZero.length > 0,
    `${pageZero.length} of ${hops.length}`,
  );
  ok(
    "the page hint keeps the hops that touch the page",
    pageZero.some((hop) => hop.toolCall.includes("render_page") && hop.toolCall.includes('"page":0')),
  );
  ok(
    "the page hint drops the other page's hops",
    !pageZero.some((hop) => hop.toolCall.includes('"page":1')),
  );
  ok(
    "the page hint keeps the hops that touch no page",
    pageZero.some((hop) => hop.app === "lightcraft"),
  );
  equal(
    "the trace and the ledger agree",
    pageZero.map((hop) => hop.eventId).join(","),
    rows.filter((row) => row.page === null || row.page === 0).map((row) => row.event_id).join(","),
  );

  const other = await ledger.traceProvenance("0".repeat(64));
  equal("an unknown asset has no hops", other.length, 0);

  // ── the SQL contract ────────────────────────────────────────────────────
  const hasSqlite = sqlite3Available();
  if (hasSqlite) {
    const contract = runSqlite(
      `${SCHEMA_SQL}\nSELECT count(*) FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%';`,
    );
    equal("the schema loads into a fresh database", contract.trim(), "3");

    const rowsFromCli = runSqlite(
      `SELECT event_id, app FROM provenance WHERE asset_root_id='${run.assetRootId}' ORDER BY event_id;`,
      LEDGER_PATH,
    )
      .trim()
      .split("\n")
      .filter((line) => line.length > 0);
    equal("the SQL contract returns the same hops", rowsFromCli.length, rows.length);
    ok(
      "the SQL contract agrees with the trace",
      rowsFromCli[0]?.split("|")[0] === hops[0]?.eventId,
      rowsFromCli[0] ?? "",
    );

    const pageRows = runSqlite(
      `SELECT count(*) FROM provenance WHERE asset_root_id='${run.assetRootId}' AND (page IS NULL OR page=0);`,
      LEDGER_PATH,
    ).trim();
    equal("the SQL page filter matches the trace", Number(pageRows), pageZero.length);

    const plan = runSqlite(
      `EXPLAIN QUERY PLAN SELECT event_id FROM provenance WHERE asset_root_id='x' ORDER BY event_id;`,
      LEDGER_PATH,
    );
    ok(
      "the trace query uses the index, not a table scan",
      plan.includes("idx_provenance_root") && !plan.includes("SCAN provenance"),
      plan.trim(),
    );

    // The schema file and the schema in the code have to be the same one.
    const schemaFile = readFileSync(resolve(FILES, "01_sql.sql"), "utf8");
    const fromFile = runSqlite(
      `${schemaFile}\nSELECT group_concat(name) FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name;`,
    ).trim();
    const fromCode = runSqlite(
      `${SCHEMA_SQL}\nSELECT group_concat(name) FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name;`,
    ).trim();
    equal("the schema file is the schema in the code", fromFile, fromCode);
  } else {
    ok("the sqlite3 command line is not installed, the ledger was still read", true);
  }

  // ── reconciling the workspace ───────────────────────────────────────────
  // The ledger and the ingest raw are not studio artefacts: the raw
  // arrived from outside the studio, and the ledger is the audit trail
  // itself.
  const exempt = [
    run.rawPath,
    LEDGER_PATH,
    `${LEDGER_PATH}-wal`,
    `${LEDGER_PATH}-shm`,
  ];
  const reconciliation = reconcileArtefacts(rows, WORK, exempt);
  ok(
    "every artefact in the workspace is accounted for",
    reconciliation.unaccounted.length === 0,
    reconciliation.unaccounted.join(", "),
  );
  ok(
    "the reconciliation sees the real artefacts",
    reconciliation.accounted.length >= 7,
    reconciliation.accounted.join(", "),
  );

  // ── the failure injection: a bypass behind the shim's back ──────────────
  const bypass = resolve(WORK, "photocraft", "bypass.png");
  writeFileSync(bypass, readFileSync(resolve(WORK, "photocraft", "banner.png")));
  const afterBypass = reconcileArtefacts(rows, WORK, exempt);
  ok(
    "a file written behind the shim's back is not accounted for",
    afterBypass.unaccounted.includes("photocraft/bypass.png"),
    afterBypass.unaccounted.join(", "),
  );
  const stillClean = ledger.verify();
  ok("the ledger itself is still intact after the bypass", stillClean.ok);
  equal(
    "the bypass did not add a hop",
    (await ledger.traceProvenance(run.assetRootId)).length,
    hops.length,
  );
  rmSync(bypass, { force: true });

  // ── the shim's own rules ─────────────────────────────────────────────────
  equal("the launcher tag cursor is recognised", detectIde({ MCP_CLIENT: "cursor" }), "cursor");
  equal(
    "the launcher tag claude-code is recognised",
    detectIde({ MCP_CLIENT: "claude-code" }),
    "claude-code",
  );
  equal(
    "the launcher tag opencode is recognised",
    detectIde({ MCP_CLIENT: "opencode" }),
    "opencode",
  );
  equal(
    "the launcher tag is normalised",
    detectIde({ MCP_CLIENT: "CLAUDE_CODE" }),
    "claude-code",
  );
  let rejected = false;
  try {
    detectIde({ MCP_CLIENT: "emacs" });
  } catch {
    rejected = true;
  }
  ok("an unknown launcher is refused", rejected);

  const ids = [uuidv7(), uuidv7(), uuidv7()];
  ok("the event ids are unique", new Set(ids).size === 3);
  ok("the event ids sort in creation order", at(ids, 0) < at(ids, 1) && at(ids, 1) < at(ids, 2));
  ok(
    "the event ids are uuidv7",
    ids.every((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)),
    ids.join(" "),
  );

  equal(
    "canonical json does not care about key order",
    canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] } as Json),
    canonicalJson({ a: [2, { c: 3, d: 4 }], b: 1 } as Json),
  );
  equal(
    "canonical json drops the whitespace",
    canonicalJson({ a: 1 } as Json),
    '{"a":1}',
  );

  // ── the sandbox roots are a per-craft fact ──────────────────────────────
  // The shim only projects the automation roots into the engines that take
  // them, so the harness checks the two answers against the binaries.
  const designCraft = await startEngine("designcraft-cli", [
    "mcp",
    "--automation-read-root",
    WORK,
  ]);
  ok("designcraft refuses the automation roots", !designCraft.accepted, designCraft.error);
  ok(
    "designcraft says which option it does not know",
    (designCraft.error ?? "").includes("unknown mcp option"),
    designCraft.error,
  );

  const photoCraft = await startEngine("photocraft-cli", [
    "mcp",
    "--automation-read-root",
    WORK,
    "--automation-write-root",
    WORK,
  ]);
  ok("photocraft accepts the automation roots", photoCraft.accepted, photoCraft.error);
  equal("photocraft answers with its version", photoCraft.version, "0.8.2");

  ok(
    "photocraft's paths are relative to the sandbox root",
    (rowWith("doc_place", "photocraft")?.tool_call ?? "").includes(
      '"path":"lightcraft/banner.tif"',
    ),
    rowWith("doc_place", "photocraft")?.tool_call,
  );
  ok(
    "designcraft's paths are absolute, because it has no sandbox root",
    (rowWith("place_image", "designcraft")?.tool_call ?? "").includes(
      `"path":"${WORK}/photocraft/banner.png"`,
    ),
    rowWith("place_image", "designcraft")?.tool_call,
  );

  ledger.close();
  for (const [from, to] of [
    [LEDGER_PATH, "provenance.sqlite"],
    [resolve(AUDIT, "tampered.sqlite"), "tampered.sqlite"],
    [resolve(AUDIT, "orphan.sqlite"), "orphan.sqlite"],
    [resolve(AUDIT, "dropped.sqlite"), "dropped.sqlite"],
    [resolve(WORK, "design", "catalogue.pdf"), "catalogue.pdf"],
    [resolve(WORK, "pdf", "archive.pdf"), "archive.pdf"],
    [resolve(WORK, "lightcraft", "banner.tif"), "banner.tif"],
    [resolve(WORK, "lightcraft", "banner-render.png"), "banner-render.png"],
  ] as const) copyFileSync(from, resolve(OUTPUT, to));

  console.log(`\n${passed} assertions passed`);
}

void main();
