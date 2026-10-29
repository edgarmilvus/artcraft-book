-- Schema contract — the cross-suite provenance ledger.
--
-- The ledger is append-only: rows are inserted, never updated and never
-- deleted. A hop that has to be retracted is retracted by appending the
-- next hop, and the replay verifier reads the file as a log.
--
-- Two tables, because one MCP call has two moments:
--
--   provenance_intent  written BEFORE the request leaves for the engine, so
--                      a crash in the middle of a call leaves evidence;
--   provenance         written AFTER the engine's JSON comes back, carrying
--                      the SHA-256 of the canonicalised result and the
--                      HMAC of the previous row.
--
-- The same DDL is embedded in the shim, so the schema the code writes is
-- the schema this file describes.

PRAGMA foreign_keys = ON;

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

INSERT OR IGNORE INTO ledger_sequence (id, next_seq) VALUES (1, 1);

CREATE INDEX IF NOT EXISTS idx_provenance_root
  ON provenance(asset_root_id, event_id);
CREATE INDEX IF NOT EXISTS idx_provenance_page
  ON provenance(asset_root_id, page, seq);
CREATE INDEX IF NOT EXISTS idx_provenance_intent
  ON provenance(intent_event_id);

-- The query contract, in SQL. The first form answers the auditor's
-- question — "which hops produced this asset?" — and the second narrows it
-- to one page. Both are index seeks on (asset_root_id, event_id); the
-- index already carries the order, so no sort is needed.
--
--   SELECT event_id, parent_event_id, app, tool_call, result_digest,
--          timestamp, ide
--     FROM provenance
--    WHERE asset_root_id = :asset_root_id
--    ORDER BY event_id ASC;
--
--   SELECT event_id, parent_event_id, app, tool_call, result_digest,
--          timestamp, ide
--     FROM provenance
--    WHERE asset_root_id = :asset_root_id
--      AND (page IS NULL OR page = :page_hint)
--    ORDER BY event_id ASC;
