/**
 * provenance / shim.ts
 * --------------------
 * The studio's cross-suite provenance shim.
 *
 *   IDE agent ──MCP/stdio──►  shim  ──MCP/stdio──►  <craft>-cli mcp
 *                                 │
 *                                 └─► provenance.sqlite
 *                                     (append-only, HMAC-chained)
 *
 * The shim is the *only* write path into the ledger, so a row can exist
 * only for a call that really reached an engine. Every call is recorded
 * twice:
 *
 *   1. an **intent** row, written before the request leaves for the engine,
 *      so a crash in the middle of a call leaves evidence behind;
 *   2. a **commit** row, written after the engine's JSON comes back, carrying
 *      the SHA-256 of the canonicalised result.
 *
 * The commit rows form a hash chain: each row's `row_hmac` is the HMAC of
 * the previous row's canonicalised body, so a single flipped character in the
 * ledger breaks the chain and is found by the replay verifier.
 *
 * The engines of this chapter do not share a vocabulary, and the shim does
 * not pretend they do: the studio declares, per craft, whether the binary
 * accepts the automation sandbox roots, and the ledger stores the engine's
 * own tool names verbatim.
 */

import { createHash, createHmac, randomBytes } from "node:crypto";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { userInfo } from "node:os";
import { PassThrough, type Duplex, type Readable, type Writable } from "node:stream";
import { deflateSync } from "node:zlib";
import { mkdirSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/* ═══════════════════════════════════════════════════════════════════════════
   1. Canonical JSON — RFC 8785 (JCS)
   ───────────────────────────────────────────────────────────────────────────
   The digest of a result has to be stable across processes, machines and
   JSON writers, so the bytes that are hashed are never the bytes the
   engine printed. Canonical JSON fixes:
     · object keys  — ascending UTF-16 code units;
     · whitespace   — none;
     · numbers      — the ECMAScript Number::toString form (shortest round
                      trip), never a trailing ".0";
     · strings      — UTF-8 with the minimal JSON escapes.
   Anything that is not JSON (undefined, a function, NaN) is rejected rather
   than silently dropped: a ledger that digests "something that was there
   before" is worse than no ledger at all.
   ═══════════════════════════════════════════════════════════════════════════ */

export type Json =
  | null
  | boolean
  | number
  | string
  | Json[]
  | { [key: string]: Json };

export function canonicalJson(value: Json): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number": {
      if (!Number.isFinite(value)) {
        throw new Error(`canonical JSON: ${String(value)} is not a finite number`);
      }
      return Object.is(value, -0) ? "0" : String(value);
    }
    case "string":
      return JSON.stringify(value);
    case "undefined":
    case "function":
    case "symbol":
    case "bigint":
      throw new Error(`canonical JSON: ${typeof value} is not JSON`);
    default:
      break;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as { [key: string]: Json };
  // Array.prototype.sort compares strings by UTF-16 code unit, which is
  // exactly the ordering RFC 8785 asks for.
  const keys = Object.keys(record).sort();
  const members = keys.map((key) => {
    const member = record[key];
    if (member === undefined) {
      throw new Error(`canonical JSON: ${key} is undefined`);
    }
    return `${JSON.stringify(key)}:${canonicalJson(member)}`;
  });
  return `{${members.join(",")}}`;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hmacHex(key: Buffer, input: string): string {
  return createHmac("sha256", key).update(input).digest("hex");
}

/* ═══════════════════════════════════════════════════════════════════════════
   2. Event ids — UUIDv7
   ───────────────────────────────────────────────────────────────────────────
   The ledger is queried by (asset_root_id, event_id) and the hops of one
   asset have to come back in the order they happened. UUIDv7 puts a
   48-bit millisecond timestamp in the high bits and a 12-bit counter in
   rand_a, so the textual form sorts in creation order and the index scan
   on (asset_root_id, event_id) is already ordered.
   ═══════════════════════════════════════════════════════════════════════════ */

let lastTimestamp = 0;
let lastCounter = 0;

export function uuidv7(now: number = Date.now()): string {
  if (now > lastTimestamp) {
    lastTimestamp = now;
    lastCounter = 0;
  } else {
    now = lastTimestamp;
    lastCounter = (lastCounter + 1) & 0xfff;
    if (lastCounter === 0) {
      // The counter wrapped: borrow a millisecond so the ids stay strict.
      lastTimestamp += 1;
      now = lastTimestamp;
    }
  }
  const timeHex = now.toString(16).padStart(12, "0");
  const random = randomBytes(10);
  const versionAndCounterHigh = 0x70 | ((lastCounter >> 8) & 0x0f);
  const counterLow = lastCounter & 0xff;
  const variant = (random.readUInt8(0) & 0x3f) | 0x80;
  const hex =
    timeHex +
    versionAndCounterHigh.toString(16).padStart(2, "0") +
    counterLow.toString(16).padStart(2, "0") +
    variant.toString(16).padStart(2, "0") +
    random.subarray(1, 2).toString("hex") +
    random.subarray(2, 8).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/* ═══════════════════════════════════════════════════════════════════════════
   3. The studio's vocabulary
   ═══════════════════════════════════════════════════════════════════════════ */

export type CraftApp =
  | "lightcraft"
  | "photocraft"
  | "designcraft"
  | "filmcraft"
  | "effectcraft"
  | "pdfcraft"
  | "vectorcraft";

export type Ide = "cursor" | "claude-code" | "opencode";

/** The launcher tags the client; the shim records the tag on every row. */
const IDE_ALIASES: Readonly<Record<string, Ide>> = {
  cursor: "cursor",
  "claude-code": "claude-code",
  claudecode: "claude-code",
  claude: "claude-code",
  opencode: "opencode",
  "open-code": "opencode",
};

export function detectIde(env: NodeJS.ProcessEnv = process.env): Ide {
  const raw = (env["MCP_CLIENT"] ?? "").trim().toLowerCase().replace(/_/g, "-");
  const ide = IDE_ALIASES[raw] ?? IDE_ALIASES[raw.replace(/-/g, "")];
  if (ide === undefined) {
    throw new Error(
      `MCP_CLIENT does not name a studio client: ${JSON.stringify(env["MCP_CLIENT"])}`,
    );
  }
  return ide;
}

/**
 * The engines that accept the automation sandbox roots. PhotoCraft,
 * FilmCraft, VectorCraft and DeckCraft take `--automation-read-root` and
 * `--automation-write-root`; WordCraft, PdfCraft and GridCraft reject them
 * outright, and DesignCraft's `mcp` sub-command takes no directory flag at
 * all. A policy that projects the same roots into every client has to know
 * this, so the shim keeps the answer per craft.
 */
const SANDBOX_ROOT_CRAFTS: ReadonlySet<string> = new Set([
  "photocraft",
  "filmcraft",
  "vectorcraft",
  "deckcraft",
]);

/* ═══════════════════════════════════════════════════════════════════════════
   4. The ledger
   ───────────────────────────────────────────────────────────────────────────
   Two append-only tables. `provenance_intent` holds the pre-dispatch fact,
   `provenance` holds the post-dispatch fact and the hash chain. Nothing is
   ever updated or deleted: a hop that has to be retracted is retracted by
   appending the next hop, and the replay verifier reads the file as a log.
   ═══════════════════════════════════════════════════════════════════════════ */

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS provenance_intent (
  seq             INTEGER NOT NULL UNIQUE,
  event_id        TEXT PRIMARY KEY,
  asset_root_id   TEXT NOT NULL,
  app             TEXT NOT NULL CHECK (app IN
                   ('lightcraft','photocraft','designcraft','filmcraft',
                    'effectcraft','pdfcraft','vectorcraft')),
  binary_version  TEXT NOT NULL,
  tool_call       TEXT NOT NULL,
  page            INTEGER,
  operator        TEXT NOT NULL,
  ide             TEXT NOT NULL CHECK (ide IN ('cursor','claude-code','opencode')),
  timestamp       TEXT NOT NULL,
  row_hmac        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS provenance (
  seq             INTEGER NOT NULL UNIQUE,
  event_id        TEXT PRIMARY KEY,
  parent_event_id TEXT REFERENCES provenance(event_id),
  intent_event_id TEXT NOT NULL REFERENCES provenance_intent(event_id),
  asset_root_id   TEXT NOT NULL,
  app             TEXT NOT NULL CHECK (app IN
                   ('lightcraft','photocraft','designcraft','filmcraft',
                    'effectcraft','pdfcraft','vectorcraft')),
  binary_version  TEXT NOT NULL,
  tool_call       TEXT NOT NULL,
  result_digest   TEXT NOT NULL,
  page            INTEGER,
  operator        TEXT NOT NULL,
  ide             TEXT NOT NULL CHECK (ide IN ('cursor','claude-code','opencode')),
  timestamp       TEXT NOT NULL,
  row_hmac        TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ledger_sequence (
  id       INTEGER PRIMARY KEY CHECK (id = 1),
  next_seq INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_provenance_root
  ON provenance(asset_root_id, event_id);
CREATE INDEX IF NOT EXISTS idx_provenance_page
  ON provenance(asset_root_id, page, seq);
CREATE INDEX IF NOT EXISTS idx_provenance_intent
  ON provenance(intent_event_id);
`;

export type ProvenanceHop = {
  eventId: string;
  parentEventId: string | null;
  app: CraftApp;
  toolCall: string;
  resultDigest: string;
  timestamp: string;
  ide: Ide;
};

export type ProvenanceRow = {
  seq: number;
  event_id: string;
  parent_event_id: string | null;
  intent_event_id: string;
  asset_root_id: string;
  app: CraftApp;
  binary_version: string;
  tool_call: string;
  result_digest: string;
  page: number | null;
  operator: string;
  ide: Ide;
  timestamp: string;
  row_hmac: string;
};

export type VerifyFailureCode =
  | "CHAIN_BROKEN"
  | "INTENT_MISSING"
  | "INTENT_ORPHAN"
  | "PARENT_MISSING"
  | "PARENT_OUT_OF_ORDER"
  | "DIGEST_MALFORMED";

export type VerifyFailure = {
  code: VerifyFailureCode;
  seq: number;
  eventId: string;
  detail: string;
};

export type VerifyReport = {
  ok: boolean;
  hops: number;
  failures: VerifyFailure[];
};

/** The exit codes the compliance bot uses when it replays the ledger. */
export const VERIFY_EXIT_CODES: Readonly<Record<VerifyFailureCode, number>> = {
  CHAIN_BROKEN: 2,
  INTENT_MISSING: 3,
  INTENT_ORPHAN: 3,
  PARENT_MISSING: 4,
  PARENT_OUT_OF_ORDER: 4,
  DIGEST_MALFORMED: 5,
};

const GENESIS_MAC = "0".repeat(64);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRow(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error("ledger: expected a row object");
  }
  return value;
}

/** The exact object the row's MAC is computed over. */
function commitBody(row: ProvenanceRow): Json {
  return {
    seq: row.seq,
    event_id: row.event_id,
    parent_event_id: row.parent_event_id,
    intent_event_id: row.intent_event_id,
    asset_root_id: row.asset_root_id,
    app: row.app,
    binary_version: row.binary_version,
    tool_call: row.tool_call,
    result_digest: row.result_digest,
    page: row.page,
    operator: row.operator,
    ide: row.ide,
    timestamp: row.timestamp,
  };
}

function intentBody(row: ProvenanceRow): Json {
  return {
    seq: row.seq,
    event_id: row.event_id,
    asset_root_id: row.asset_root_id,
    app: row.app,
    binary_version: row.binary_version,
    tool_call: row.tool_call,
    page: row.page,
    operator: row.operator,
    ide: row.ide,
    timestamp: row.timestamp,
  };
}

export class Ledger {
  private readonly db: DatabaseSync;
  private readonly key: Buffer;

  private constructor(db: DatabaseSync, key: Buffer) {
    this.db = db;
    this.key = key;
  }

  static open(path: string, key: Buffer): Ledger {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL;");
    db.exec("PRAGMA foreign_keys = ON;");
    db.exec("PRAGMA busy_timeout = 5000;");
    db.exec(SCHEMA_SQL);
    db.exec("INSERT OR IGNORE INTO ledger_sequence (id, next_seq) VALUES (1, 1);");
    return new Ledger(db, key);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Fold the write-ahead log into the main file. An auditor who is handed
   * the ledger wants one file to hash, not a file and its sidecars.
   */
  checkpoint(): void {
    this.db.exec("PRAGMA wal_checkpoint(TRUNCATE);");
  }

  /**
   * One transaction, one row. Reading the head of the chain and appending
   * the next row have to happen together, or two shims writing at the same
   * time would chain onto the same predecessor.
   */
  private transaction<T>(body: () => T): T {
    this.db.exec("BEGIN IMMEDIATE;");
    try {
      const result = body();
      this.db.exec("COMMIT;");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK;");
      throw error;
    }
  }

  /** One sequence number for the whole ledger, intents and hops alike. */
  private nextSeq(): number {
    const row = asRow(
      this.db.prepare("SELECT next_seq FROM ledger_sequence WHERE id = 1").get(),
    );
    const seq = Number(row["next_seq"]);
    this.db
      .prepare("UPDATE ledger_sequence SET next_seq = ? WHERE id = 1")
      .run(seq + 1);
    return seq;
  }

  private macOf(prev: string, body: Json): string {
    return hmacHex(this.key, canonicalJson({ prev, body }));
  }

  /** The MAC that chains the next row of `table` onto the current head. */
  private headMac(table: "provenance" | "provenance_intent"): string {
    const row = this.db
      .prepare(`SELECT row_hmac FROM ${table} ORDER BY seq DESC LIMIT 1`)
      .get();
    if (row === undefined) return GENESIS_MAC;
    return String(asRow(row)["row_hmac"]);
  }

  /**
   * Record the intent: the call is about to leave for the engine. The row
   * carries no result, only the request that was made.
   */
  appendIntent(input: {
    assetRootId: string;
    app: CraftApp;
    binaryVersion: string;
    toolCall: string;
    page: number | null;
    operator: string;
    ide: Ide;
  }): { eventId: string; seq: number } {
    return this.transaction(() => {
      const seq = this.nextSeq();
      const eventId = uuidv7();
      const timestamp = new Date().toISOString();
      const body: Json = {
        seq,
        event_id: eventId,
        asset_root_id: input.assetRootId,
        app: input.app,
        binary_version: input.binaryVersion,
        tool_call: input.toolCall,
        page: input.page,
        operator: input.operator,
        ide: input.ide,
        timestamp,
      };
      const mac = this.macOf(this.headMac("provenance_intent"), body);
      this.db
        .prepare(
          `INSERT INTO provenance_intent
             (seq, event_id, asset_root_id, app, binary_version, tool_call, page,
              operator, ide, timestamp, row_hmac)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          seq,
          eventId,
          input.assetRootId,
          input.app,
          input.binaryVersion,
          input.toolCall,
          input.page,
          input.operator,
          input.ide,
          timestamp,
          mac,
        );
      return { eventId, seq };
    });
  }

  /**
   * Record the result: the engine answered, and this is the digest of what
   * it answered. The row chains onto the previous hop's MAC.
   */
  appendCommit(input: {
    intentEventId: string;
    parentEventId: string | null;
    assetRootId: string;
    app: CraftApp;
    binaryVersion: string;
    toolCall: string;
    resultDigest: string;
    page: number | null;
    operator: string;
    ide: Ide;
  }): { eventId: string; seq: number } {
    return this.transaction(() => {
      const seq = this.nextSeq();
      const eventId = uuidv7();
      const timestamp = new Date().toISOString();
      const body: Json = {
        seq,
        event_id: eventId,
        parent_event_id: input.parentEventId,
        intent_event_id: input.intentEventId,
        asset_root_id: input.assetRootId,
        app: input.app,
        binary_version: input.binaryVersion,
        tool_call: input.toolCall,
        result_digest: input.resultDigest,
        page: input.page,
        operator: input.operator,
        ide: input.ide,
        timestamp,
      };
      const mac = this.macOf(this.headMac("provenance"), body);
      this.db
        .prepare(
          `INSERT INTO provenance
             (seq, event_id, parent_event_id, intent_event_id, asset_root_id, app,
              binary_version, tool_call, result_digest, page, operator, ide,
              timestamp, row_hmac)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          seq,
          eventId,
          input.parentEventId,
          input.intentEventId,
          input.assetRootId,
          input.app,
          input.binaryVersion,
          input.toolCall,
          input.resultDigest,
          input.page,
          input.operator,
          input.ide,
          timestamp,
          mac,
        );
      return { eventId, seq };
    });
  }

  /** The newest committed hop of an asset — the parent of the next hop. */
  latestHop(assetRootId: string): ProvenanceRow | null {
    const row = this.db
      .prepare(
        `SELECT * FROM provenance
          WHERE asset_root_id = ?
          ORDER BY seq DESC LIMIT 1`,
      )
      .get(assetRootId);
    if (row === undefined) return null;
    return this.toProvenanceRow(asRow(row));
  }

  rows(assetRootId?: string): ProvenanceRow[] {
    const statement =
      assetRootId === undefined
        ? this.db.prepare("SELECT * FROM provenance ORDER BY seq ASC")
        : this.db.prepare(
            "SELECT * FROM provenance WHERE asset_root_id = ? ORDER BY seq ASC",
          );
    const raw =
      assetRootId === undefined
        ? statement.all()
        : statement.all(assetRootId);
    return raw.map((row) => this.toProvenanceRow(asRow(row)));
  }

  intentRows(): ProvenanceRow[] {
    return this.db
      .prepare("SELECT * FROM provenance_intent ORDER BY seq ASC")
      .all()
      .map((row) => this.toProvenanceRow(asRow(row)));
  }

  private toProvenanceRow(row: Record<string, unknown>): ProvenanceRow {
    return {
      seq: Number(row["seq"]),
      event_id: String(row["event_id"]),
      parent_event_id:
        row["parent_event_id"] === null || row["parent_event_id"] === undefined
          ? null
          : String(row["parent_event_id"]),
      intent_event_id: String(row["intent_event_id"]),
      asset_root_id: String(row["asset_root_id"]),
      app: String(row["app"]) as CraftApp,
      binary_version: String(row["binary_version"]),
      tool_call: String(row["tool_call"]),
      result_digest: String(row["result_digest"]),
      page: row["page"] === null || row["page"] === undefined ? null : Number(row["page"]),
      operator: String(row["operator"]),
      ide: String(row["ide"]) as Ide,
      timestamp: String(row["timestamp"]),
      row_hmac: String(row["row_hmac"]),
    };
  }

  /**
   * The query contract. `assetRootId` is the content hash of the original
   * raw; `pageHint` narrows the chain to the hops that touch one page.
   *
   * The query is an index seek on (asset_root_id, event_id) — the index
   * already carries the ordering, so the plan is O(log n) seeks plus the
   * matching rows, never a table scan.
   */
  async traceProvenance(
    assetRootId: string,
    pageHint?: number,
  ): Promise<ProvenanceHop[]> {
    const rows =
      pageHint === undefined
        ? this.db
            .prepare(
              `SELECT event_id, parent_event_id, app, tool_call, result_digest,
                      timestamp, ide
                 FROM provenance
                WHERE asset_root_id = ?
                ORDER BY event_id ASC`,
            )
            .all(assetRootId)
        : this.db
            .prepare(
              `SELECT event_id, parent_event_id, app, tool_call, result_digest,
                      timestamp, ide
                 FROM provenance
                WHERE asset_root_id = ?
                  AND (page IS NULL OR page = ?)
                ORDER BY event_id ASC`,
            )
            .all(assetRootId, pageHint);
    return rows.map((row) => {
      const record = asRow(row);
      return {
        eventId: String(record["event_id"]),
        parentEventId:
          record["parent_event_id"] === null ||
          record["parent_event_id"] === undefined
            ? null
            : String(record["parent_event_id"]),
        app: String(record["app"]) as CraftApp,
        toolCall: String(record["tool_call"]),
        resultDigest: String(record["result_digest"]),
        timestamp: String(record["timestamp"]),
        ide: String(record["ide"]) as Ide,
      };
    });
  }

  /**
   * The replay verifier. It walks the ledger as a log, recomputes every
   * MAC and stops at the first inconsistency. A clean replay must also
   * prove that every hop has an intent and every intent has a hop.
   */
  verify(): VerifyReport {
    const failures: VerifyFailure[] = [];
    const hops = this.rows();
    const intents = this.intentRows();

    // 1. the commit chain
    let prev = GENESIS_MAC;
    for (const row of hops) {
      const expected = this.macOf(prev, commitBody(row));
      if (expected !== row.row_hmac) {
        failures.push({
          code: "CHAIN_BROKEN",
          seq: row.seq,
          eventId: row.event_id,
          detail: `expected ${expected}, found ${row.row_hmac}`,
        });
      }
      prev = row.row_hmac;
    }

    // 2. the intent chain
    let prevIntent = GENESIS_MAC;
    for (const row of intents) {
      const expected = this.macOf(prevIntent, intentBody(row));
      if (expected !== row.row_hmac) {
        failures.push({
          code: "CHAIN_BROKEN",
          seq: row.seq,
          eventId: row.event_id,
          detail: `intent ${expected}, found ${row.row_hmac}`,
        });
      }
      prevIntent = row.row_hmac;
    }

    // 3. every hop has an intent, every intent has a hop
    const intentsById = new Map(intents.map((row) => [row.event_id, row]));
    const usedIntents = new Set<string>();
    for (const row of hops) {
      const intent = intentsById.get(row.intent_event_id);
      if (intent === undefined) {
        failures.push({
          code: "INTENT_MISSING",
          seq: row.seq,
          eventId: row.event_id,
          detail: `no intent row ${row.intent_event_id}`,
        });
        continue;
      }
      usedIntents.add(intent.event_id);
      if (intent.tool_call !== row.tool_call) {
        failures.push({
          code: "INTENT_MISSING",
          seq: row.seq,
          eventId: row.event_id,
          detail: "the intent and the hop disagree about the call",
        });
      }
    }
    for (const intent of intents) {
      if (!usedIntents.has(intent.event_id)) {
        failures.push({
          code: "INTENT_ORPHAN",
          seq: intent.seq,
          eventId: intent.event_id,
          detail: "the call was announced but never came back",
        });
      }
    }

    // 4. the asset chain: a parent has to exist and has to be older
    const hopsById = new Map(hops.map((row) => [row.event_id, row]));
    for (const row of hops) {
      if (row.parent_event_id === null) continue;
      const parent = hopsById.get(row.parent_event_id);
      if (parent === undefined) {
        failures.push({
          code: "PARENT_MISSING",
          seq: row.seq,
          eventId: row.event_id,
          detail: `no parent hop ${row.parent_event_id}`,
        });
      } else if (parent.seq >= row.seq) {
        failures.push({
          code: "PARENT_OUT_OF_ORDER",
          seq: row.seq,
          eventId: row.event_id,
          detail: `parent hop ${row.parent_event_id} is not older`,
        });
      }
    }

    // 5. the digest has to be a SHA-256
    for (const row of hops) {
      if (!/^[0-9a-f]{64}$/.test(row.result_digest)) {
        failures.push({
          code: "DIGEST_MALFORMED",
          seq: row.seq,
          eventId: row.event_id,
          detail: row.result_digest,
        });
      }
    }

    return { ok: failures.length === 0, hops: hops.length, failures };
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   5. MCP framing
   ───────────────────────────────────────────────────────────────────────────
   The engines speak JSON-RPC 2.0 over stdio, one JSON object per line.
   ═══════════════════════════════════════════════════════════════════════════ */

export type JsonRpcFrame = {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

export type ToolResult = {
  content?: { type?: string; text?: string; data?: string }[];
  isError?: boolean;
  structuredContent?: Json;
};

function readFrames(stream: Readable, onFrame: (frame: JsonRpcFrame) => void): void {
  let buffer = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    buffer += chunk;
    let index = buffer.indexOf("\n");
    while (index >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (line.length > 0) {
        try {
          onFrame(JSON.parse(line) as JsonRpcFrame);
        } catch {
          // Not a frame: the engines only ever speak JSON on stdout.
        }
      }
      index = buffer.indexOf("\n");
    }
  });
}

/* ═══════════════════════════════════════════════════════════════════════════
   6. The shim
   ───────────────────────────────────────────────────────────────────────────
   The shim owns the engine process and relays every frame in both
   directions. It reads the `tools/call` requests on the way down and the
   matching results on the way up, and it is the only thing that writes to
   the ledger.
   ═══════════════════════════════════════════════════════════════════════════ */

export type HopContext = {
  assetRootId?: string;
  parentEventId?: string | null;
  page?: number | null;
};

export type ShimOptions = {
  app: CraftApp;
  binary: string;
  ledger: Ledger;
  cwd: string;
  /** The studio's ingest hash for the asset being worked on. */
  assetRootId?: string;
  operator?: string;
  readRoot?: string;
  writeRoot?: string;
  /** Extra arguments for the engine's `mcp` sub-command. */
  extraArgs?: string[];
  env?: NodeJS.ProcessEnv;
};

type PendingCall = {
  intentEventId: string;
  assetRootId: string;
  parentEventId: string | null;
  toolCall: string;
  page: number | null;
};

export class Shim {
  readonly app: CraftApp;
  readonly input: Writable;
  readonly output: Duplex;

  private readonly engine: ChildProcessWithoutNullStreams;
  private readonly ledger: Ledger;
  private readonly operator: string;
  private readonly ide: Ide;
  private readonly defaultAssetRootId: string;
  private readonly pending = new Map<number | string, PendingCall>();
  private binaryVersion = "unknown";
  private closed = false;

  private constructor(
    options: ShimOptions,
    engine: ChildProcessWithoutNullStreams,
    input: Writable,
    output: Duplex,
  ) {
    this.app = options.app;
    this.engine = engine;
    this.ledger = options.ledger;
    this.operator = options.operator ?? userInfo().username;
    this.ide = detectIde(options.env ?? process.env);
    this.defaultAssetRootId = options.assetRootId ?? "unknown";
    this.input = input;
    this.output = output;
  }

  static start(options: ShimOptions): Shim {
    const args = ["mcp"];
    if (SANDBOX_ROOT_CRAFTS.has(options.app)) {
      if (options.readRoot !== undefined) {
        args.push("--automation-read-root", options.readRoot);
      }
      if (options.writeRoot !== undefined) {
        args.push("--automation-write-root", options.writeRoot);
      }
    }
    if (options.extraArgs !== undefined) args.push(...options.extraArgs);

    const engine = spawn(options.binary, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    engine.stdout.setEncoding("utf8");
    engine.stderr.setEncoding("utf8");

    const input = new PassThrough();
    const output = new PassThrough();
    const shim = new Shim(options, engine, input, output);

    // Down: the client asks the shim, the shim asks the engine.
    readFrames(input, (frame) => {
      shim.onClientFrame(frame);
    });
    // Up: the engine answers the shim, the shim answers the client.
    readFrames(engine.stdout, (frame) => {
      shim.onEngineFrame(frame);
    });
    // The engine's own diagnostics belong to whoever runs the shim.
    engine.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(chunk);
    });
    return shim;
  }

  /** The engine's own version string, taken from its `initialize` reply. */
  get version(): string {
    return this.binaryVersion;
  }

  private onClientFrame(frame: JsonRpcFrame): void {
    if (frame.method !== "tools/call") {
      this.forward(frame);
      return;
    }
    const params = isRecord(frame.params) ? frame.params : {};
    const name = typeof params["name"] === "string" ? params["name"] : "";
    const args = isRecord(params["arguments"]) ? params["arguments"] : {};
    const context = readHopContext(params);
    const page = context.page ?? pageOfArguments(args);
    const assetRootId = context.assetRootId ?? this.defaultAssetRootId;
    const parentEventId =
      context.parentEventId !== undefined
        ? context.parentEventId
        : (this.ledger.latestHop(assetRootId)?.event_id ?? null);
    const toolCall = canonicalJson({ tool: name, args: args as Json });

    const intent = this.ledger.appendIntent({
      assetRootId,
      app: this.app,
      binaryVersion: this.binaryVersion,
      toolCall,
      page,
      operator: this.operator,
      ide: this.ide,
    });

    if (frame.id !== undefined) {
      this.pending.set(frame.id, {
        intentEventId: intent.eventId,
        assetRootId,
        parentEventId,
        toolCall,
        page,
      });
    }

    // The provenance metadata is the studio's own channel: it is read here
    // and never handed to the engine.
    const forwarded: Record<string, unknown> = { ...params };
    delete forwarded["_meta"];
    const request: JsonRpcFrame = {
      jsonrpc: "2.0",
      method: frame.method,
      params: forwarded,
    };
    if (frame.id !== undefined) request.id = frame.id;
    this.forward(request);
  }

  private onEngineFrame(frame: JsonRpcFrame): void {
    const serverInfo = isRecord(frame.result) ? frame.result["serverInfo"] : undefined;
    if (isRecord(serverInfo) && typeof serverInfo["version"] === "string") {
      this.binaryVersion = serverInfo["version"];
    }
    if (frame.id !== undefined) {
      const call = this.pending.get(frame.id);
      if (call !== undefined) {
        this.pending.delete(frame.id);
        const payload = payloadOf(frame);
        this.ledger.appendCommit({
          intentEventId: call.intentEventId,
          parentEventId: call.parentEventId,
          assetRootId: call.assetRootId,
          app: this.app,
          binaryVersion: this.binaryVersion,
          toolCall: call.toolCall,
          resultDigest: sha256Hex(canonicalJson(payload)),
          page: call.page,
          operator: this.operator,
          ide: this.ide,
        });
      }
    }
    this.output.write(`${JSON.stringify(frame)}\n`);
  }

  private forward(frame: JsonRpcFrame): void {
    this.engine.stdin.write(`${JSON.stringify(frame)}\n`);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.engine.stdin.end();
    this.engine.kill();
    await new Promise<void>((resolve) => {
      this.engine.once("exit", () => resolve());
    });
  }
}

/** The provenance metadata a client may attach to a `tools/call`. */
function readHopContext(params: Record<string, unknown>): HopContext {
  const context: HopContext = {};
  const meta = params["_meta"];
  if (!isRecord(meta)) return context;
  const provenance = meta["provenance"];
  if (!isRecord(provenance)) return context;
  const assetRootId = provenance["assetRootId"];
  if (typeof assetRootId === "string") context.assetRootId = assetRootId;
  const parentEventId = provenance["parentEventId"];
  if (parentEventId === null) context.parentEventId = null;
  else if (typeof parentEventId === "string") context.parentEventId = parentEventId;
  const page = provenance["page"];
  if (typeof page === "number" && Number.isInteger(page)) context.page = page;
  return context;
}

/** `render_page` and friends carry the page in their own parameters. */
function pageOfArguments(args: Record<string, unknown>): number | null {
  const page = args["page"];
  return typeof page === "number" && Number.isInteger(page) ? page : null;
}

/** What the digest is computed over: the result, or the error. */
function payloadOf(frame: JsonRpcFrame): Json {
  if ("result" in frame) return frame.result as Json;
  return { error: (frame.error ?? null) as Json };
}

/* ═══════════════════════════════════════════════════════════════════════════
   7. A minimal MCP client
   ───────────────────────────────────────────────────────────────────────────
   The studio's launcher (or an IDE) talks to the shim exactly the way it
   would talk to any other MCP server.
   ═══════════════════════════════════════════════════════════════════════════ */

export class McpClient {
  private readonly write: Writable;
  private nextId = 1;
  private readonly pending = new Map<
    number,
    { resolve: (frame: JsonRpcFrame) => void; reject: (error: Error) => void }
  >();

  private constructor(write: Writable, read: Readable) {
    this.write = write;
    readFrames(read, (frame) => {
      if (typeof frame.id !== "number") return;
      const waiter = this.pending.get(frame.id);
      if (waiter === undefined) return;
      this.pending.delete(frame.id);
      waiter.resolve(frame);
    });
  }

  static connect(shim: Shim): McpClient {
    return new McpClient(shim.input, shim.output);
  }

  private request(method: string, params: unknown): Promise<JsonRpcFrame> {
    const id = this.nextId++;
    const answer = new Promise<JsonRpcFrame>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
    });
    this.write.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    return answer;
  }

  notify(method: string, params: unknown): void {
    this.write.write(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  }

  async initialize(): Promise<JsonRpcFrame> {
    const frame = await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "studio-pipeline", version: "1.0.0" },
    });
    this.notify("notifications/initialized", {});
    return frame;
  }

  /**
   * Call a tool through the shim. `context` carries the studio's
   * provenance metadata — the asset the call belongs to and, for a
   * page-scoped call, the page it touches.
   */
  async callTool(
    name: string,
    args: Record<string, Json>,
    context?: HopContext,
  ): Promise<JsonRpcFrame> {
    const params: Record<string, unknown> = { name, arguments: args };
    if (context !== undefined) {
      params["_meta"] = { provenance: context };
    }
    return this.request("tools/call", params);
  }
}

/* ═══════════════════════════════════════════════════════════════════════════
   8. The studio run
   ───────────────────────────────────────────────────────────────────────────
   One banner, four suites, one ledger:

     LightCraft   the raw is graded and exported as a TIFF
     PhotoCraft   the TIFF is placed in a mock-up and saved as .pcraft
     DesignCraft  the mock-up is placed in a catalogue, which is rendered
                  page by page and exported as a PDF
     PdfCraft     the PDF is opened, checked against PDF/A and archived
   ═══════════════════════════════════════════════════════════════════════════ */

export type HopRecord = {
  app: CraftApp;
  tool: string;
  toolCall: string;
  args: Json;
  payload: Json;
  digest: string;
  eventId: string;
  parentEventId: string | null;
  page: number | null;
  binaryVersion: string;
  timestamp: string;
};

export type StudioRun = {
  assetRootId: string;
  rawPath: string;
  ledgerPath: string;
  hops: HopRecord[];
};

export type StudioRunOptions = {
  workDir: string;
  ledgerPath: string;
  hmacKey: Buffer;
  ide: Ide;
  operator?: string;
};

function crc32(bytes: Buffer): number {
  let crc = ~0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return ~crc >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([length, body, checksum]);
}

/**
 * The studio's ingest fixture: a deterministic stand-in for the camera
 * original, so the pipeline is reproducible offline. A real deployment
 * hashes the file that arrived from the camera instead.
 */
function writeRawFixture(path: string): Buffer {
  const width = 640;
  const height = 400;
  const bands: [number, number, number][] = [
    [214, 58, 44],
    [236, 148, 40],
    [238, 208, 62],
    [58, 168, 92],
    [40, 110, 190],
    [122, 72, 178],
  ];
  const raw = Buffer.alloc(height * (1 + width * 3));
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    raw[offset] = 0; // filter: none
    offset += 1;
    for (let x = 0; x < width; x += 1) {
      const bandIndex = Math.floor((x / width) * bands.length) % bands.length;
      // The index is inside the palette by construction; the fallback is
      // only there to keep the type honest.
      const band = bands[bandIndex] ?? [0, 0, 0];
      const shade = 1 - (y / height) * 0.35;
      raw[offset] = Math.round(band[0] * shade);
      raw[offset + 1] = Math.round(band[1] * shade);
      raw[offset + 2] = Math.round(band[2] * shade);
      offset += 3;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8 bits per channel
  header[9] = 2; // truecolour
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(raw)),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function textOf(frame: JsonRpcFrame): string {
  const result = isRecord(frame.result) ? frame.result : {};
  const content = result["content"];
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const entry of content) {
    if (isRecord(entry) && typeof entry["text"] === "string") {
      parts.push(entry["text"]);
    }
  }
  return parts.join("");
}

/** A number the engine put in its JSON answer, or zero. */
function numberField(value: Json, key: string): number {
  if (!isRecord(value)) return 0;
  const field = value[key];
  return typeof field === "number" ? field : 0;
}

function jsonOf(text: string): Json {
  try {
    return JSON.parse(text) as Json;
  } catch {
    return text;
  }
}

export async function runStudioRun(options: StudioRunOptions): Promise<StudioRun> {
  const workDir = resolve(options.workDir);
  const operator = options.operator ?? userInfo().username;
  const env: NodeJS.ProcessEnv = { ...process.env, MCP_CLIENT: options.ide };

  for (const folder of ["raw", "lightcraft", "photocraft", "design", "pdf"]) {
    mkdirSync(join(workDir, folder), { recursive: true });
  }

  // The ingest: the raw arrives from outside the studio, so it has no
  // ledger row. Its content hash is the key every hop is filed under.
  const rawPath = join(workDir, "raw", "banner.png");
  const rawBytes = writeRawFixture(rawPath);
  writeFileSync(rawPath, rawBytes);
  const assetRootId = sha256Hex(rawBytes);

  const ledger = Ledger.open(options.ledgerPath, options.hmacKey);
  const hops: HopRecord[] = [];

  // The shim appends the hop before it relays the answer, so the ledger is
  // already up to date when the call returns.
  const record = (
    app: CraftApp,
    tool: string,
    args: Record<string, Json>,
    frame: JsonRpcFrame,
    binaryVersion: string,
  ): HopRecord => {
    const payload = payloadOf(frame);
    const row = ledger.latestHop(assetRootId);
    const hop: HopRecord = {
      app,
      tool,
      toolCall: row?.tool_call ?? "",
      args: args as Json,
      payload,
      digest: sha256Hex(canonicalJson(payload)),
      eventId: row?.event_id ?? "",
      parentEventId: row?.parent_event_id ?? null,
      page: row?.page ?? null,
      binaryVersion,
      timestamp: row?.timestamp ?? new Date().toISOString(),
    };
    hops.push(hop);
    return hop;
  };

  /**
   * The call site of one app. It makes the call, refuses a failed hop, and
   * records the hop.
   *
   * `page` is the page the studio says the hop touches. It travels to the
   * shim as provenance metadata, and the shim records it; when the engine's
   * own parameters already say which page a call is about — `render_page`,
   * for instance — the studio says nothing and the shim reads the page out
   * of the parameters.
   */
  const caller = (
    shim: Shim,
    client: McpClient,
  ): ((
    name: string,
    args: Record<string, Json>,
    page?: number | null,
  ) => Promise<JsonRpcFrame>) => {
    return async (name, args, page = null) => {
      const context = page === null ? undefined : { page };
      const frame = await client.callTool(name, args, context);
      if (isRecord(frame.result) && frame.result["isError"] === true) {
        throw new Error(`${shim.app}: ${name} failed: ${textOf(frame)}`);
      }
      record(shim.app, name, args, frame, shim.version);
      return frame;
    };
  };

  try {
    /* -- LightCraft: grade the raw, render it, export a TIFF ------------- */
    {
      const shim = Shim.start({
        app: "lightcraft",
        binary: "lightcraft-cli",
        ledger,
        cwd: workDir,
        assetRootId,
        operator,
        env,
        extraArgs: [rawPath],
      });
      const client = McpClient.connect(shim);
      await client.initialize();
      const call = caller(shim, client);

      await call("command_run", {
        id: "develop.set",
        params: { control: "light.exposure", value: 0.35 },
      });

      await call("render_photo", {
        path: "lightcraft/banner-render.png",
        format: "png",
        size: 640,
      });

      // The TIFF the mock-up is built from.
      await call("command_run", {
        id: "app.export",
        params: { path: "lightcraft/banner.tif", format: "tiff", longEdge: 800 },
      });

      await shim.close();
    }

    /* -- PhotoCraft: place the TIFF, caption it, save the mock-up -------- */
    {
      const shim = Shim.start({
        app: "photocraft",
        binary: "photocraft-cli",
        ledger,
        cwd: workDir,
        assetRootId,
        operator,
        env,
        readRoot: workDir,
        writeRoot: workDir,
      });
      const client = McpClient.connect(shim);
      await client.initialize();
      const call = caller(shim, client);

      await call("doc_new", {
        width: 1200,
        height: 800,
        mode: "rgb",
        depth: 8,
        background: "#101418",
      });

      // The path is relative to the automation read root the shim granted.
      await call("doc_place", { path: "lightcraft/banner.tif", scale: 80 });

      await call("command_run", {
        id: "type.create",
        params: { x: 60, y: 700, text: "ARTCRAFT STUDIO", size: 48, color: "#f2f2f2" },
      });

      // The master, in PhotoCraft's own format ...
      await call("doc_save", { path: "photocraft/banner.pcraft" });
      // ... and the flattened copy the catalogue can place.
      await call("doc_save", { path: "photocraft/banner.png" });

      await shim.close();
    }

    /* -- DesignCraft: build the catalogue, place the mock-up, render ----- */
    {
      const shim = Shim.start({
        app: "designcraft",
        binary: "designcraft-cli",
        ledger,
        cwd: workDir,
        assetRootId,
        operator,
        env,
      });
      const client = McpClient.connect(shim);
      await client.initialize();
      const call = caller(shim, client);

      await call("new_document", {
        pages: 2,
        preset: "A4",
        title: "Studio Catalogue",
      });

      // The first page carries the mock-up.
      const frame = await call(
        "execute",
        { command: "frame.create", params: { rect: [40, 40, 555, 400], content: "graphic" } },
        0,
      );
      const frameId = numberField(jsonOf(textOf(frame)), "id");

      // DesignCraft takes no automation roots, so its paths are absolute.
      await call(
        "place_image",
        { path: join(workDir, "photocraft", "banner.png"), frame: frameId },
        0,
      );

      // The second page carries the caption, on the facing page of the
      // spread - the catalogue is printed double sided.
      await call(
        "execute",
        {
          command: "frame.create",
          params: {
            rect: [635, 40, 1150, 400],
            content: "text",
            text: "Studio catalogue - second page",
          },
        },
        1,
      );

      for (const page of [0, 1]) {
        // The parameters already say which page this is, so the studio
        // declares nothing and the shim reads the page out of them.
        await call("render_page", {
          page,
          path: join(workDir, "design", `page-${page}.png`),
          scale: 2,
        });
      }

      await call("execute", {
        command: "file.exportPdf",
        params: { path: join(workDir, "design", "catalogue.pdf") },
      });

      await shim.close();
    }

    /* -- PdfCraft: open the PDF, check it, archive it -------------------- */
    {
      const shim = Shim.start({
        app: "pdfcraft",
        binary: "pdfcraft-cli",
        ledger,
        cwd: workDir,
        assetRootId,
        operator,
        env,
      });
      const client = McpClient.connect(shim);
      await client.initialize();
      const call = caller(shim, client);

      const opened = await call("doc_open", {
        path: join(workDir, "design", "catalogue.pdf"),
      });
      const docId = numberField(jsonOf(textOf(opened)), "doc");

      // The compliance check: the catalogue is archived whether or not it
      // is PDF/A, and the answer is in the ledger either way.
      await call("pdfa_verify", { doc: docId, level: "2b" });

      await call("doc_save", { doc: docId, path: join(workDir, "pdf", "archive.pdf") });

      await shim.close();
    }
  } finally {
    ledger.close();
  }
  return { assetRootId, rawPath, ledgerPath: options.ledgerPath, hops };
}

/* ═══════════════════════════════════════════════════════════════════════════
   9. Reconciling the files on disk
   ───────────────────────────────────────────────────────────────────────────
   The ledger proves what went through MCP. It does not, by itself, prove
   that nothing else touched the files — so the auditor walks the workspace
   and asks which artefacts no hop accounts for. A file that was written
   behind the shim's back shows up here and nowhere else.
   ═══════════════════════════════════════════════════════════════════════════ */

/** The paths a recorded call mentions. */
export function pathsOf(toolCall: string): string[] {
  const paths: string[] = [];
  const collect = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) collect(item);
      return;
    }
    if (!isRecord(value)) return;
    for (const [key, item] of Object.entries(value)) {
      if (
        (key === "path" || key === "paths" || key === "dir" || key === "file") &&
        typeof item === "string"
      ) {
        paths.push(item);
      } else {
        collect(item);
      }
    }
  };
  try {
    collect(JSON.parse(toolCall) as unknown);
  } catch {
    // A tool call that is not JSON mentions no path.
  }
  return paths;
}

export type Reconciliation = {
  accounted: string[];
  unaccounted: string[];
};

export function reconcileArtefacts(
  rows: ProvenanceRow[],
  workDir: string,
  exempt: string[] = [],
): Reconciliation {
  const root = resolve(workDir);
  const mentioned = new Set<string>();
  for (const row of rows) {
    for (const path of pathsOf(row.tool_call)) {
      mentioned.add(isAbsolute(path) ? resolve(path) : resolve(root, path));
    }
  }
  const exemptPaths = new Set(
    exempt.map((path) => (isAbsolute(path) ? resolve(path) : resolve(root, path))),
  );

  const accounted: string[] = [];
  const unaccounted: string[] = [];
  const walk = (folder: string): void => {
    for (const entry of readdirSync(folder)) {
      const full = join(folder, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (exemptPaths.has(full)) continue;
      if (mentioned.has(full)) accounted.push(relative(root, full));
      else unaccounted.push(relative(root, full));
    }
  };
  walk(root);
  accounted.sort();
  unaccounted.sort();
  return { accounted, unaccounted };
}

/* ═══════════════════════════════════════════════════════════════════════════
   10. The standalone proxy
   ───────────────────────────────────────────────────────────────────────────
   Run as a program, the shim is what an IDE's MCP configuration points at:

     provenance-shim --app photocraft --ledger /var/lib/studio/provenance.sqlite

   It reads the client's JSON-RPC on stdin and writes it to the engine, and
   the engine's answers back to the client, recording the ledger on the way.
   ═══════════════════════════════════════════════════════════════════════════ */

export function runProxyFromEnv(env: NodeJS.ProcessEnv = process.env): void {
  const app = (env["ARTCRAFT_APP"] ?? "photocraft") as CraftApp;
  const binary = env["ARTCRAFT_BINARY"] ?? `${app}-cli`;
  const ledgerPath = env["ARTCRAFT_LEDGER"] ?? "provenance.sqlite";
  const keyHex = env["ARTCRAFT_HMAC_KEY"] ?? "";
  if (keyHex.length === 0) {
    // The chain is only worth anything if the key comes from the vault.
    throw new Error("ARTCRAFT_HMAC_KEY is missing: the ledger cannot be chained");
  }
  const ledger = Ledger.open(ledgerPath, Buffer.from(keyHex, "hex"));
  const options: ShimOptions = {
    app,
    binary,
    ledger,
    cwd: env["ARTCRAFT_CWD"] ?? process.cwd(),
    env,
  };
  const assetRootId = env["ARTCRAFT_ASSET_ROOT"];
  if (assetRootId !== undefined) options.assetRootId = assetRootId;
  const readRoot = env["ARTCRAFT_READ_ROOT"];
  if (readRoot !== undefined) options.readRoot = readRoot;
  const writeRoot = env["ARTCRAFT_WRITE_ROOT"];
  if (writeRoot !== undefined) options.writeRoot = writeRoot;
  const shim = Shim.start(options);
  process.stdin.pipe(shim.input);
  shim.output.pipe(process.stdout);
}

// The module is also the executable: the studio's MCP configuration points
// an IDE at `node dist/shim.js`, and the shim then fronts the engine.
const entryPoint = process.argv[1];
if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  runProxyFromEnv(process.env);
}
