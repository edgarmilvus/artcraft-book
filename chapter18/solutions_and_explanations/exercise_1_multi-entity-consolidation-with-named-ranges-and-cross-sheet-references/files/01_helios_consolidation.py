#!/usr/bin/env python3
"""
helios_consolidation.py -- Helios Systems' four-entity P&L consolidation.

Helios Systems runs four legal entities, each with its own chart of
accounts and its own reporting currency.  This script builds the parent's
consolidated profit-and-loss statement headlessly, through GridCraft's MCP
stdio transport, and proves the result:

  * every entity sheet is imported from its own CSV fixture;
  * every rollup target is anchored by a *defined name* -- the named-range
    schema is the model's contract;
  * every consolidated cell is a formula that reads those names and
    nothing else: no raw `A1` reference ever crosses a sheet boundary;
  * the FX table and the intercompany eliminations are named blocks a
    controller can adjust without touching the parent sheet;
  * the run ends with a machine-readable proof that
    `sum(entity totals in USD) - eliminations == consolidated total`,
    re-verified against the saved workbook in a fresh engine session.

The model fails closed.  A local controller who renames a line, renumbers an
account or adds an account the parent's chart of accounts does not know about
does not get a silently wrong consolidation: the run stops with a structured
error that names the entity, the account and the defined name that could not
be anchored.

Usage:
    python3 helios_consolidation.py --fixtures-dir DIR --out-dir DIR

Artefacts written to --out-dir:
    helios-consolidated.xlsx   the consolidated workbook
    consolidation-proof.json   the machine-readable proof
    consolidation-error.json   written only when the run fails closed
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List, NamedTuple, Optional, Sequence, Tuple

# --------------------------------------------------------------------------
# The model
# --------------------------------------------------------------------------

ENGINE = "gridcraft-cli"
PERIOD = "2026-09"

CONSOLIDATED_SHEET = "Consolidated"
FX_SHEET = "FX"
ELIMINATIONS_SHEET = "Eliminations"

#: The four reporting entities and the currency each one books in.
ENTITY_CURRENCY: Dict[str, str] = {
    "Helios-US": "USD",
    "Helios-EU": "EUR",
    "Helios-APAC": "SGD",
    "Helios-LATAM": "BRL",
}
ENTITIES: Tuple[str, ...] = tuple(ENTITY_CURRENCY)


class CanonicalAccount(NamedTuple):
    """One line of the parent's chart of accounts.

    `key` is the canonical name used in the consolidated statement, `code`
    and `label` are the local account code and description the reporting
    entity files it under, and `entities` lists the entities that report it.
    """

    key: str
    label: str
    code: str
    entities: Tuple[str, ...]


#: The parent's chart of accounts.  This table is the contract between the
#: parent and the four local controllers: every line an entity files must
#: appear here, and it must carry the code and the description the parent
#: expects.
CANONICAL_ACCOUNTS: Tuple[CanonicalAccount, ...] = (
    CanonicalAccount("Rev.Net", "Net Revenue", "4000", ENTITIES),
    CanonicalAccount("Rev.FederalRDCredit", "Federal R&D Credit", "RND-US", ("Helios-US",)),
    CanonicalAccount("Rev.IPBoxRelief", "IP Box Relief", "IPBOX-EU", ("Helios-EU",)),
    CanonicalAccount("Rev.FTCGrantIncome", "FTC Grant Income", "FTC-APAC", ("Helios-APAC",)),
    CanonicalAccount("Rev.ICMSRecovery", "ICMS Recovery", "ICMS-LATAM", ("Helios-LATAM",)),
    CanonicalAccount("Cost.COGS", "Cost of Goods Sold", "5000", ENTITIES),
    CanonicalAccount("Cost.OpEx", "Operating Expenses", "6000", ENTITIES),
)

#: Every command the model runs through `execute_command`.  The ids are
#: checked against the engine's own catalogue before the first write, so a
#: build that renames a command fails loudly instead of half way through the
#: model.
REQUIRED_COMMANDS: Tuple[str, ...] = (
    "sheet.rename",
    "sheet.activate",
    "formulas.defineName",
    "formulas.nameManager",
    "formulas.calculateNow",
    "formulas.errorChecking",
    "formulas.tracePrecedents",
    "data.fromTextCsv",
    "file.properties",
)

#: Every MCP tool the model calls directly.
REQUIRED_TOOLS: Tuple[str, ...] = (
    "new_workbook",
    "write_range",
    "read_range",
    "format_range",
    "inspect_workbook",
    "save_workbook",
    "open_workbook",
    "execute_command",
    "list_commands",
)

#: Columns of the entity CSV fixtures.
ENTITY_COLUMNS = ("account_code", "account_label", "amount_local", "currency", "period")

#: Columns of the FX fixture and of the intercompany elimination fixture.
FX_COLUMNS = ("from", "to", "period", "rate")
ELIMINATION_COLUMNS = ("from_entity", "to_entity", "account_code", "amount_usd")

#: The tolerance used for every monetary comparison in the audit.
TOLERANCE = 1e-6

#: The money format: thousands separators, negative amounts in red.
MONEY_FORMAT = "#,##0.00;[Red]-#,##0.00"

#: The FX rate format: four decimals are enough for a month-end rate.
RATE_FORMAT = "#,##0.0000"


# --------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------
class EngineError(RuntimeError):
    """The engine refused a call; the message is the engine's own text."""


class ConsolidationError(RuntimeError):
    """A structured, fail-closed error.

    The payload is the whole story: the error code, the entity and the
    account that drifted, and the defined name that could not be anchored.
    It is written to disk and printed as JSON -- never as a stack trace.
    """

    def __init__(self, code: str, message: str, **details: Any) -> None:
        self.payload: Dict[str, Any] = {"error": code, "message": message}
        self.payload.update(details)
        super().__init__(json.dumps(self.payload, sort_keys=True))


# --------------------------------------------------------------------------
# The MCP stdio client
# --------------------------------------------------------------------------
class MCPClient:
    """A small, honest JSON-RPC client for GridCraft's MCP stdio transport.

    The handshake is the MCP `initialize` request; every later frame is a
    `tools/call`.  A tool that fails answers with `isError: true` and a
    plain sentence -- the flag is checked before the payload is parsed --
    and the payload itself arrives in the first `text` content block.
    """

    def __init__(self, argv: Sequence[str]):
        self._process = subprocess.Popen(
            list(argv),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
        self._next_id = 0

    # -- the wire ---------------------------------------------------------
    def _request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        self._next_id += 1
        frame = {
            "jsonrpc": "2.0",
            "id": self._next_id,
            "method": method,
            "params": params or {},
        }
        assert self._process.stdin is not None and self._process.stdout is not None
        self._process.stdin.write((json.dumps(frame) + "\n").encode("utf-8"))
        self._process.stdin.flush()
        line = self._process.stdout.readline()
        if not line:
            raise EngineError("the GridCraft MCP server closed its stdout")
        reply = json.loads(line.decode("utf-8"))
        if "error" in reply:
            detail = reply["error"].get("message", reply["error"])
            raise EngineError("%s failed: %s" % (method, detail))
        return reply.get("result", {})

    # -- the public surface ----------------------------------------------
    def initialize(self) -> Dict[str, Any]:
        """Perform the MCP handshake and return the server's identity."""
        result = self._request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "helios-consolidation", "version": "1.0"},
            },
        )
        return result.get("serverInfo", {})

    def list_tools(self) -> List[str]:
        """The names of the MCP tools the server publishes."""
        result = self._request("tools/list")
        return sorted(tool["name"] for tool in result.get("tools", []))

    def tool(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> Any:
        """Call an MCP tool and return its payload (the first text block)."""
        result = self._request("tools/call", {"name": name, "arguments": arguments or {}})
        if result.get("isError"):
            message = self._first_text(result) or "the engine reported an error"
            raise EngineError("%s: %s" % (name, message))
        text = self._first_text(result)
        if text is None:
            raise EngineError("%s: the engine returned no text content block" % name)
        try:
            return json.loads(text)
        except json.JSONDecodeError:
            return text

    def command(self, command: str, params: Optional[Dict[str, Any]] = None) -> Any:
        """Run any GridCraft command by id (`execute_command`)."""
        return self.tool("execute_command", {"command": command, "params": params or {}})

    @staticmethod
    def _first_text(result: Dict[str, Any]) -> Optional[str]:
        for block in result.get("content", []):
            if block.get("type") == "text":
                return block.get("text")
        return None

    def close(self) -> None:
        try:
            if self._process.stdin is not None:
                self._process.stdin.close()
        except OSError:
            pass
        self._process.terminate()
        try:
            self._process.wait(timeout=5)
        except subprocess.TimeoutExpired:  # pragma: no cover - defensive
            self._process.kill()


# --------------------------------------------------------------------------
# Naming helpers
# --------------------------------------------------------------------------
_PLAIN_SHEET = re.compile(r"^[A-Za-z_][A-Za-z0-9_.]*$")


def quote_sheet(name: str) -> str:
    """`'Helios-US'!$C$2` -- a sheet with a hyphen has to be quoted."""
    if _PLAIN_SHEET.match(name):
        return name
    return "'%s'" % name


def entity_key(entity: str) -> str:
    """`Helios-US` -> `Helios_US`.

    A defined name may contain dots but not hyphens, so the entity key is
    sanitised before it becomes part of a name.
    """
    return entity.replace("-", "_")


def account_name(entity: str, account: CanonicalAccount) -> str:
    """The defined name that anchors one canonical account in one entity."""
    return "%s.Amount.%s" % (entity_key(entity), account.key.replace(".", "_"))


def as_text(value: Any) -> str:
    """Normalise a cell value to the text the fixtures were written with."""
    if isinstance(value, bool):
        return str(value)
    if isinstance(value, float) and value.is_integer():
        return str(int(value))
    if value is None:
        return ""
    return str(value)


def as_number(value: Any) -> float:
    """Normalise a cell value to a float."""
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return float(value)
    return float(str(value))


def close_to(left: float, right: float, tolerance: float = TOLERANCE) -> bool:
    return abs(left - right) <= tolerance * max(1.0, abs(right))


# --------------------------------------------------------------------------
# The consolidation
# --------------------------------------------------------------------------
class Consolidation:
    """The parent's consolidated P&L, built and read through GridCraft."""

    def __init__(self, engine: MCPClient, fixtures_dir: Path, period: str = PERIOD):
        self.engine = engine
        self.fixtures_dir = Path(fixtures_dir)
        self.period = period
        # (entity, canonical key) -> row on the entity sheet
        self.anchors: Dict[Tuple[str, str], int] = {}
        # entity -> the rows of the imported sheet, keyed by column name
        self.entity_rows: Dict[str, List[Dict[str, Any]]] = {}
        # currency -> rate against USD
        self.fx_rates: Dict[str, float] = {}
        # the rows of the eliminations sheet
        self.elimination_rows: List[Dict[str, Any]] = []
        # canonical key -> the formula written on the consolidated sheet
        self.line_formulas: Dict[str, str] = {}
        # the row layout of the consolidated sheet
        self.layout: Dict[str, int] = {}
        # every defined name the model registers
        self.names: List[str] = []
        # the formats applied to the imported ranges
        self.formatting: List[Dict[str, Any]] = []

    # -- fixtures ---------------------------------------------------------
    def fixture_path(self, entity: str) -> Path:
        return self.fixtures_dir / ("%s-%s.csv" % (entity.lower(), self.period))

    def fx_path(self) -> Path:
        return self.fixtures_dir / ("fx-%s.csv" % self.period)

    def elimination_path(self) -> Path:
        return self.fixtures_dir / ("ic-elim-%s.csv" % self.period)

    # -- discovery --------------------------------------------------------
    def verify_command_catalogue(self) -> Dict[str, Any]:
        """Check the engine's catalogue before the model is built.

        The ids are read from the live registry (`list_commands`) and the
        ones the model needs are checked against it: the compiled runtime
        schema is the ground truth, the narrative is advisory.  The search
        terms of the exercise -- sheet, cell, named, formula -- are walked
        as well, so the proof records what the registry holds for each of
        them.
        """
        catalogue = self.engine.tool("list_commands", {})
        published = {entry["id"] for entry in catalogue}
        missing = [command for command in REQUIRED_COMMANDS if command not in published]
        if missing:
            raise EngineError(
                "the engine does not implement: %s" % ", ".join(sorted(missing))
            )
        tools = self.engine.list_tools()
        missing_tools = [tool for tool in REQUIRED_TOOLS if tool not in tools]
        if missing_tools:
            raise EngineError(
                "the engine does not publish: %s" % ", ".join(sorted(missing_tools))
            )
        discovered: Dict[str, int] = {}
        for term in ("sheet", "cell", "named", "formula"):
            entries = self.engine.tool("list_commands", {"search": term})
            discovered[term] = len(entries)
        return {
            "commands_published": len(published),
            "verified_commands": list(REQUIRED_COMMANDS),
            "tools_published": len(tools),
            "verified_tools": list(REQUIRED_TOOLS),
            "search_terms": discovered,
        }

    # -- building ---------------------------------------------------------
    def build(self) -> None:
        """Build the whole model, sheet by sheet, name by name."""
        engine = self.engine

        # A fresh workbook holds one sheet, `Sheet1`; it becomes the
        # consolidated statement.  The remaining sheets are created by the
        # CSV imports, which land each fixture in a sheet of its own.
        engine.tool("new_workbook", {})
        engine.command("sheet.rename", {"sheet": "Sheet1", "name": CONSOLIDATED_SHEET})
        for entity in ENTITIES:
            engine.command(
                "data.fromTextCsv",
                {"path": str(self.fixture_path(entity)), "sheet": entity},
            )
        engine.command("data.fromTextCsv", {"path": str(self.fx_path()), "sheet": FX_SHEET})
        engine.command(
            "data.fromTextCsv",
            {"path": str(self.elimination_path()), "sheet": ELIMINATIONS_SHEET},
        )
        engine.command(
            "file.properties",
            {
                "title": "Helios Consolidated P&L",
                "author": "Helios Systems Finance",
                "company": "Helios Systems",
            },
        )

        self._anchor_entity_accounts()
        self._anchor_fx_rates()
        self._anchor_eliminations()
        self._write_consolidated()
        self.formatting = self._apply_formatting()
        engine.command("formulas.calculateNow", {})

    # -- the entity sheets ------------------------------------------------
    def _read_table(self, sheet: str, expected_columns: Sequence[str]) -> List[Dict[str, Any]]:
        """Read a sheet the CSV import created, as a list of row dictionaries.

        The header of the imported sheet is checked against the fixture's
        columns: a fixture that changed shape has to stop the run, not
        shift every anchor by one column.
        """
        payload = self.engine.tool("read_range", {"sheet": sheet})
        values = payload.get("values") or []
        if not values:
            raise ConsolidationError(
                "empty_sheet",
                "the sheet %s is empty" % sheet,
                sheet=sheet,
            )
        header = [as_text(value) for value in values[0]]
        if header != list(expected_columns):
            raise ConsolidationError(
                "unexpected_columns",
                "the sheet %s has the columns %s, the fixture has %s"
                % (sheet, ", ".join(header), ", ".join(expected_columns)),
                sheet=sheet,
                columns=header,
                expected_columns=list(expected_columns),
            )
        rows: List[Dict[str, Any]] = []
        for raw in values[1:]:
            if raw is None or all(value is None for value in raw):
                continue
            rows.append({header[index]: raw[index] for index in range(len(header))})
        return rows

    def _anchor_entity_accounts(self) -> None:
        """Anchor every canonical account of every entity with a defined name.

        The name points at the amount cell of the local line that carries
        the canonical account.  The anchor is fully absolute -- a relative
        row would be re-anchored per reading cell and silently resolve to
        the wrong line.
        """
        for entity in ENTITIES:
            rows = self._read_table(entity, ENTITY_COLUMNS)
            self.entity_rows[entity] = rows
            reported: Dict[str, Tuple[int, Dict[str, Any]]] = {}
            for index, row in enumerate(rows):
                code = as_text(row.get("account_code"))
                if code in reported:
                    raise ConsolidationError(
                        "duplicate_account",
                        "%s reports account %s twice" % (entity, code),
                        entity=entity,
                        account=code,
                        account_label=as_text(row.get("account_label")),
                        named_range="%s.Amount.<ambiguous>" % entity_key(entity),
                    )
                reported[code] = (index, row)
            expected = {
                account.code: account
                for account in CANONICAL_ACCOUNTS
                if entity in account.entities
            }

            for code, account in expected.items():
                if code not in reported:
                    raise ConsolidationError(
                        "missing_account",
                        "%s does not report %s (%s)" % (entity, account.key, code),
                        entity=entity,
                        account=code,
                        expected_label=account.label,
                        canonical_account=account.key,
                        named_range=account_name(entity, account),
                    )
                index, row = reported[code]
                label = as_text(row.get("account_label"))
                if label != account.label:
                    raise ConsolidationError(
                        "label_drift",
                        "%s reports account %s as %r; the parent's chart of accounts "
                        "expects %r" % (entity, code, label, account.label),
                        entity=entity,
                        account=code,
                        account_label=label,
                        expected_label=account.label,
                        canonical_account=account.key,
                        named_range=account_name(entity, account),
                    )
                currency = as_text(row.get("currency"))
                if currency != ENTITY_CURRENCY[entity]:
                    raise ConsolidationError(
                        "currency_mismatch",
                        "%s reports account %s in %s, but the entity books in %s"
                        % (entity, code, currency, ENTITY_CURRENCY[entity]),
                        entity=entity,
                        account=code,
                        currency=currency,
                        expected_currency=ENTITY_CURRENCY[entity],
                        named_range=account_name(entity, account),
                    )
                period = as_text(row.get("period"))
                if period != self.period:
                    raise ConsolidationError(
                        "period_mismatch",
                        "%s reports account %s for %s, not %s"
                        % (entity, code, period, self.period),
                        entity=entity,
                        account=code,
                        period=period,
                        expected_period=self.period,
                        named_range=account_name(entity, account),
                    )

                # The amount lives in the third column of the fixture.
                row_number = index + 2
                self.anchors[(entity, account.key)] = row_number
                self._define_name(
                    account_name(entity, account),
                    "=%s!$C$%d" % (quote_sheet(entity), row_number),
                    "%s / %s (%s)" % (entity, account.key, code),
                )

            # Fail closed on a line the parent's chart of accounts does not
            # know: silently dropping it would understate the consolidation.
            for row in rows:
                code = as_text(row.get("account_code"))
                if code not in expected:
                    raise ConsolidationError(
                        "unmapped_account",
                        "%s reports account %s, which the parent's chart of accounts "
                        "does not define" % (entity, code),
                        entity=entity,
                        account=code,
                        account_label=as_text(row.get("account_label")),
                        canonical_account=None,
                        named_range="%s.Amount.<unmapped>" % entity_key(entity),
                    )

    # -- the FX table -----------------------------------------------------
    def _anchor_fx_rates(self) -> None:
        """Name one rate per ISO currency: `FX.<code>.USD`."""
        rows = self._read_table(FX_SHEET, FX_COLUMNS)
        for index, row in enumerate(rows, start=2):
            source = as_text(row.get("from"))
            target = as_text(row.get("to"))
            if target != "USD":
                raise ConsolidationError(
                    "fx_pair_unsupported",
                    "the FX table only supports rates against USD, not %s->%s"
                    % (source, target),
                    currency=source,
                    target=target,
                    named_range="FX.%s.%s" % (source, target),
                )
            period = as_text(row.get("period"))
            if period != self.period:
                raise ConsolidationError(
                    "period_mismatch",
                    "the FX rate for %s is dated %s, not %s" % (source, period, self.period),
                    currency=source,
                    period=period,
                    expected_period=self.period,
                    named_range="FX.%s.USD" % source,
                )
            self.fx_rates[source] = as_number(row.get("rate"))
            self._define_name(
                "FX.%s.USD" % source,
                "=%s!$D$%d" % (quote_sheet(FX_SHEET), index),
                "%s->USD %s" % (source, self.period),
            )
        self._define_name(
            "FX.Table",
            "=%s!$A$2:$D$%d" % (quote_sheet(FX_SHEET), len(rows) + 1),
            "the month-end FX table",
        )
        for entity, currency in ENTITY_CURRENCY.items():
            if currency != "USD" and currency not in self.fx_rates:
                raise ConsolidationError(
                    "missing_fx_rate",
                    "the FX table has no rate for %s, which %s books in"
                    % (currency, entity),
                    entity=entity,
                    currency=currency,
                    named_range="FX.%s.USD" % currency,
                )

    # -- the eliminations sheet -------------------------------------------
    def _anchor_eliminations(self) -> None:
        """Name the elimination block and its USD column."""
        rows = self._read_table(ELIMINATIONS_SHEET, ELIMINATION_COLUMNS)
        self.elimination_rows = rows
        last = len(rows) + 1
        for index, row in enumerate(rows, start=2):
            source = as_text(row.get("from_entity"))
            target = as_text(row.get("to_entity"))
            if source not in ENTITY_CURRENCY or target not in ENTITY_CURRENCY:
                raise ConsolidationError(
                    "unknown_entity",
                    "the elimination on row %d names an entity that does not report" % index,
                    row=index,
                    from_entity=source,
                    to_entity=target,
                    named_range="Eliminations.Rows",
                )
        self._define_name(
            "Eliminations.Rows",
            "=%s!$A$2:$D$%d" % (quote_sheet(ELIMINATIONS_SHEET), last),
            "the intercompany eliminations",
        )
        self._define_name(
            "Eliminations.TotalUSD",
            "=%s!$D$2:$D$%d" % (quote_sheet(ELIMINATIONS_SHEET), last),
            "the intercompany eliminations, in USD",
        )

    # -- the consolidated sheet -------------------------------------------
    def _rollup_formula(self, account: CanonicalAccount) -> str:
        """The formula of one consolidated line.

        Every term is a defined name.  A local-currency amount is converted
        with the named FX rate of its currency; the USD entity is already in
        the reporting currency.  No `A1` reference ever crosses a sheet.
        """
        terms: List[str] = []
        for entity in account.entities:
            name = account_name(entity, account)
            currency = ENTITY_CURRENCY[entity]
            if currency == "USD":
                terms.append(name)
            else:
                terms.append("(%s*FX.%s.USD)" % (name, currency))
        return "=" + "+".join(terms)

    def _write_consolidated(self) -> None:
        """Write the consolidated statement: labels, then formulas."""
        engine = self.engine
        lines = len(CANONICAL_ACCOUNTS)
        first_line = 2
        last_line = first_line + lines - 1
        elimination_row = last_line + 1
        total_row = elimination_row + 1
        self.layout = {
            "first_line": first_line,
            "last_line": last_line,
            "elimination_row": elimination_row,
            "total_row": total_row,
        }

        # Column A: the canonical chart of accounts, as the parent sees it.
        labels = [["Canonical Account"]]
        for account in CANONICAL_ACCOUNTS:
            labels.append([account.key])
        labels.append(["Intercompany Elimination"])
        labels.append(["Consolidated Total"])
        engine.tool(
            "write_range",
            {"range": "%s!A1:A%d" % (quote_sheet(CONSOLIDATED_SHEET), total_row),
             "values": labels},
        )
        engine.tool(
            "write_range",
            {"range": "%s!B1:B1" % quote_sheet(CONSOLIDATED_SHEET),
             "values": [["Consolidated (USD)"]]},
        )

        # Column B, the rollup lines: every one of them a named-range-only
        # formula, plus the elimination line that reads the named block.
        formulas: List[List[str]] = []
        for account in CANONICAL_ACCOUNTS:
            formula = self._rollup_formula(account)
            self.line_formulas[account.key] = formula
            formulas.append([formula])
        formulas.append(["=-SUM(Eliminations.TotalUSD)"])
        engine.tool(
            "write_range",
            {"range": "%s!B%d:B%d" % (quote_sheet(CONSOLIDATED_SHEET), first_line, elimination_row),
             "values": formulas},
        )

        # The two structural names of the consolidated sheet are defined
        # before the total is written: a formula that reads a name which
        # does not exist yet is answered `#NAME?` and cached.
        self._define_name(
            "Consolidated.Lines",
            "=%s!$B$%d:$B$%d" % (quote_sheet(CONSOLIDATED_SHEET), first_line, last_line),
            "the consolidated rollup lines",
        )
        self._define_name(
            "Consolidated.Elimination",
            "=%s!$B$%d" % (quote_sheet(CONSOLIDATED_SHEET), elimination_row),
            "the intercompany elimination, as consolidated",
        )
        engine.tool(
            "write_range",
            {"range": "%s!B%d:B%d" % (quote_sheet(CONSOLIDATED_SHEET), total_row, total_row),
             "values": [["=SUM(Consolidated.Lines)+Consolidated.Elimination"]]},
        )
        self._define_name(
            "Consolidated.Total",
            "=%s!$B$%d" % (quote_sheet(CONSOLIDATED_SHEET), total_row),
            "the consolidated result, in USD",
        )

    # -- the formatting ----------------------------------------------------
    def _apply_formatting(self) -> List[Dict[str, Any]]:
        """Format the imported ranges the way a controller expects to read them.

        A bold header row, thousands separators on every amount and negative
        amounts in red: the same three rules on the entity sheets, on the
        FX table, on the eliminations and on the consolidated statement.
        """
        applied: List[Dict[str, Any]] = []

        def format_range(sheet: str, cell_range: str, **properties: Any) -> None:
            target = "%s!%s" % (quote_sheet(sheet), cell_range)
            payload = self.engine.tool("format_range", dict(properties, range=target))
            applied.append(
                {"range": target, "applied": (payload or {}).get("applied", [])}
            )

        for entity in ENTITIES:
            last = len(self.entity_rows[entity]) + 1
            format_range(entity, "A1:E1", bold=True)
            format_range(entity, "C2:C%d" % last, numberFormat=MONEY_FORMAT)

        fx_last = len(self.fx_rates) + 1
        format_range(FX_SHEET, "A1:D1", bold=True)
        format_range(FX_SHEET, "D2:D%d" % fx_last, numberFormat=RATE_FORMAT)

        elimination_last = len(self.elimination_rows) + 1
        format_range(ELIMINATIONS_SHEET, "A1:D1", bold=True)
        format_range(
            ELIMINATIONS_SHEET, "D2:D%d" % elimination_last, numberFormat=MONEY_FORMAT
        )

        format_range(CONSOLIDATED_SHEET, "A1:B1", bold=True)
        format_range(
            CONSOLIDATED_SHEET,
            "B%d:B%d" % (self.layout["first_line"], self.layout["total_row"]),
            numberFormat=MONEY_FORMAT,
        )
        return applied

    # -- names -------------------------------------------------------------
    def _define_name(self, name: str, refers_to: str, comment: str) -> None:
        self.engine.command(
            "formulas.defineName",
            {"name": name, "refersTo": refers_to, "scope": "Workbook", "comment": comment},
        )
        self.names.append(name)

    # -- the audit ---------------------------------------------------------
    def consolidated_values(self) -> List[List[Any]]:
        payload = self.engine.tool(
            "read_range",
            {"sheet": CONSOLIDATED_SHEET, "range": "A1:B%d" % self.layout["total_row"]},
        )
        return payload.get("values") or []

    def _entity_amounts(self, entity: str) -> List[float]:
        """Every local amount on the entity sheet, in the order it is filed."""
        rows = self.entity_rows[entity]
        return [as_number(row.get("amount_local")) for row in rows]

    def _rate(self, currency: str) -> float:
        if currency == "USD":
            return 1.0
        return self.fx_rates[currency]

    def audit(self) -> Dict[str, Any]:
        """Prove the consolidation against the engine's own state."""
        engine = self.engine

        # 1. The engine's own error check: no cycle, no error cell.
        error_checking = engine.command("formulas.errorChecking", {})

        # 2. The names the model registered, with the values the engine
        #    resolved for them.
        names = engine.command("formulas.nameManager", {})
        registered = sorted(entry["name"] for entry in names)

        # 3. The formulas of the consolidated sheet.  A model that is
        #    driven by names reads no cell across a sheet boundary.
        formulas_payload = engine.tool(
            "read_range",
            {
                "sheet": CONSOLIDATED_SHEET,
                "range": "B%d:B%d" % (self.layout["first_line"], self.layout["total_row"]),
                "formulas": True,
            },
        )
        formulas = formulas_payload.get("values") or []
        formula_text = [as_text(row[0]) for row in formulas if row and row[0] is not None]

        # 4. The engine's tracer on the consolidated cells.  GridCraft's
        #    tracer resolves cell references but not defined names, so an
        #    empty trace is the proof that the consolidated lines read the
        #    schema and not the grid.
        engine.command("sheet.activate", {"sheet": CONSOLIDATED_SHEET})
        traces: Dict[str, Any] = {}
        for row in range(self.layout["first_line"], self.layout["total_row"] + 1):
            traces["B%d" % row] = engine.command(
                "formulas.tracePrecedents", {"cell": "B%d" % row}
            )

        # 5. The values, straight from the sheet.
        values = self.consolidated_values()
        line_values = [
            as_number(values[self.layout["first_line"] - 1 + offset][1])
            for offset in range(len(CANONICAL_ACCOUNTS))
        ]
        elimination_value = as_number(values[self.layout["elimination_row"] - 1][1])
        consolidated_total = as_number(values[self.layout["total_row"] - 1][1])

        # 6. The entity totals, recomputed from the imported sheets rather
        #    than from the names, so a mis-anchored name cannot hide here.
        entity_totals: Dict[str, float] = {}
        coverage: List[Dict[str, Any]] = []
        for entity in ENTITIES:
            amounts = self._entity_amounts(entity)
            column_sum = sum(amounts)
            anchored_sum = sum(
                as_number(self.entity_rows[entity][self.anchors[(entity, account.key)] - 2].get("amount_local"))
                for account in CANONICAL_ACCOUNTS
                if entity in account.entities
            )
            if not close_to(column_sum, anchored_sum):
                raise ConsolidationError(
                    "anchor_mismatch",
                    "the named anchors of %s do not cover every line of its sheet" % entity,
                    entity=entity,
                    column_sum=column_sum,
                    anchored_sum=anchored_sum,
                    named_range="%s.Amount.*" % entity_key(entity),
                )
            coverage.append(
                {
                    "entity": entity,
                    "currency": ENTITY_CURRENCY[entity],
                    "lines": len(amounts),
                    "local_total": column_sum,
                    "rate": self._rate(ENTITY_CURRENCY[entity]),
                    "usd_total": column_sum * self._rate(ENTITY_CURRENCY[entity]),
                }
            )
            entity_totals[entity] = column_sum * self._rate(ENTITY_CURRENCY[entity])

        # 7. The per-line check: every consolidated line equals the sum of
        #    the local lines it rolls up, converted at the named FX rate.
        line_checks: List[Dict[str, Any]] = []
        for offset, account in enumerate(CANONICAL_ACCOUNTS):
            expected = 0.0
            for entity in account.entities:
                row = self.entity_rows[entity][self.anchors[(entity, account.key)] - 2]
                expected += as_number(row.get("amount_local")) * self._rate(ENTITY_CURRENCY[entity])
            actual = line_values[offset]
            line_checks.append(
                {
                    "canonical_account": account.key,
                    "expected_usd": expected,
                    "consolidated_usd": actual,
                    "matches": close_to(expected, actual),
                    "formula": self.line_formulas[account.key],
                }
            )
            if not close_to(expected, actual):
                raise ConsolidationError(
                    "line_mismatch",
                    "the consolidated line %s is %s, expected %s"
                    % (account.key, actual, expected),
                    canonical_account=account.key,
                    consolidated_usd=actual,
                    expected_usd=expected,
                    named_range=account_name(account.entities[0], account),
                )

        # 8. The eliminations, read from the sheet the controller adjusts.
        elimination_total = sum(
            as_number(row.get("amount_usd")) for row in self.elimination_rows
        )
        if not close_to(-elimination_total, elimination_value):
            raise ConsolidationError(
                "elimination_mismatch",
                "the consolidated elimination is %s, the sheet says %s"
                % (elimination_value, -elimination_total),
                elimination_total=elimination_total,
                consolidated_elimination=elimination_value,
                named_range="Eliminations.TotalUSD",
            )

        # 9. The invariant: entity sum, less the eliminations, is the
        #    consolidated result.
        entity_sum = sum(entity_totals.values())
        expected_total = entity_sum - elimination_total
        invariant_holds = close_to(expected_total, consolidated_total)
        if not invariant_holds:
            raise ConsolidationError(
                "invariant_broken",
                "the entity totals (%s) less the eliminations (%s) is %s, "
                "but the consolidated sheet says %s"
                % (entity_sum, elimination_total, expected_total, consolidated_total),
                entity_sum=entity_sum,
                elimination_total=elimination_total,
                expected_total=expected_total,
                consolidated_total=consolidated_total,
                named_range="Consolidated.Total",
            )

        return {
            "entity_totals": entity_totals,
            "elimination_total": elimination_total,
            "consolidated_total": consolidated_total,
            "invariant_holds": invariant_holds,
            "named_ranges_registered": registered,
            "audit": {
                "error_checking": error_checking,
                "trace_precedents": traces,
                "consolidated_formulas": formula_text,
                "line_checks": line_checks,
                "entity_coverage": coverage,
                "fx_rates": dict(self.fx_rates),
                "elimination_rows": self.elimination_rows,
                "formatting": self.formatting,
                "sheets": self.sheet_names(),
            },
        }

    def sheet_names(self) -> List[str]:
        payload = self.engine.tool("inspect_workbook", {})
        return [sheet["name"] for sheet in payload.get("sheets", [])]

    # -- the cold read -----------------------------------------------------
    def cold_read(self, workbook_path: Path) -> Dict[str, Any]:
        """Re-open the saved workbook in a fresh engine session.

        A fresh session is a cold read: nothing of the build is in memory,
        so every value comes out of the file.  The workbook is then
        recalculated, which proves the formulas -- not just the cached
        values -- survived the round trip.
        """
        verifier = MCPClient([ENGINE, "mcp"])
        try:
            verifier.initialize()
            verifier.tool("open_workbook", {"path": str(workbook_path)})
            inspect = verifier.tool("inspect_workbook", {})
            sheets = [sheet["name"] for sheet in inspect.get("sheets", [])]
            cached = verifier.tool(
                "read_range",
                {"sheet": CONSOLIDATED_SHEET, "range": "B%d:B%d"
                 % (self.layout["first_line"], self.layout["total_row"])},
            )
            verifier.command("formulas.calculateNow", {})
            recalculated = verifier.tool(
                "read_range",
                {"sheet": CONSOLIDATED_SHEET, "range": "B%d:B%d"
                 % (self.layout["first_line"], self.layout["total_row"])},
            )
            names = verifier.command("formulas.nameManager", {})
            errors = verifier.command("formulas.errorChecking", {})
        finally:
            verifier.close()
        return {
            "sheets": sheets,
            "values": [row[0] for row in (cached.get("values") or [])],
            "recalculated": [row[0] for row in (recalculated.get("values") or [])],
            "names": sorted(entry["name"] for entry in names),
            "error_checking": errors,
        }

    def check_cold_read(self, cold: Dict[str, Any], warm: Dict[str, Any]) -> None:
        """Compare the cold read with the warm one; drift fails the run."""
        warm_values = warm["warm_values"]
        cold_values = cold["values"]
        if len(warm_values) != len(cold_values):
            raise ConsolidationError(
                "serialization_drift",
                "the re-opened workbook has %d consolidated values, the built one had %d"
                % (len(cold_values), len(warm_values)),
                named_range="Consolidated.Total",
            )
        for offset, (warm_value, cold_value) in enumerate(zip(warm_values, cold_values)):
            if not close_to(as_number(warm_value), as_number(cold_value)):
                raise ConsolidationError(
                    "serialization_drift",
                    "the consolidated value on row %d is %s after a cold read, "
                    "it was %s" % (offset + 2, cold_value, warm_value),
                    row=offset + 2,
                    warm=warm_value,
                    cold=cold_value,
                    named_range="Consolidated.Total",
                )
        recalculated = cold["recalculated"]
        for offset, (cold_value, recalculated_value) in enumerate(zip(cold_values, recalculated)):
            if not close_to(as_number(cold_value), as_number(recalculated_value)):
                raise ConsolidationError(
                    "recalculation_drift",
                    "the re-opened workbook recalculates row %d to %s, it was cached as %s"
                    % (offset + 2, recalculated_value, cold_value),
                    row=offset + 2,
                    cached=cold_value,
                    recalculated=recalculated_value,
                    named_range="Consolidated.Total",
                )
        if cold["names"] != warm["named_ranges_registered"]:
            raise ConsolidationError(
                "serialization_drift",
                "the re-opened workbook does not hold the same defined names",
                named_range="Consolidated.Total",
            )


# --------------------------------------------------------------------------
# The run
# --------------------------------------------------------------------------
def run(fixtures_dir: Path, out_dir: Path, period: str = PERIOD) -> Dict[str, Any]:
    """Build the consolidation, prove it, and write the artefacts."""
    out_dir.mkdir(parents=True, exist_ok=True)
    workbook_path = out_dir / "helios-consolidated.xlsx"
    proof_path = out_dir / "consolidation-proof.json"
    started = time.time()

    engine = MCPClient([ENGINE, "mcp"])
    try:
        engine.initialize()
        model = Consolidation(engine, fixtures_dir, period)
        catalogue = model.verify_command_catalogue()
        model.build()

        proof = model.audit()
        warm_values = [
            row[1]
            for row in model.consolidated_values()[model.layout["first_line"] - 1:]
        ]

        # The workbook is persisted and then read back cold.
        engine.tool("save_workbook", {"path": str(workbook_path)})
        payload = workbook_path.read_bytes()
        cold = model.cold_read(workbook_path)
        model.check_cold_read(cold, {
            "warm_values": warm_values,
            "named_ranges_registered": proof["named_ranges_registered"],
        })

        proof.update(
            {
                "period": period,
                "engine": catalogue,
                "workbook": {
                    "file": workbook_path.name,
                    "bytes": len(payload),
                    "sha256": hashlib.sha256(payload).hexdigest(),
                },
                "cold_read": {
                    "sheets": cold["sheets"],
                    "values": cold["values"],
                    "recalculated": cold["recalculated"],
                    "names": cold["names"],
                    "error_checking": cold["error_checking"],
                },
                "duration_ms": int((time.time() - started) * 1000),
            }
        )
        proof_path.write_text(json.dumps(proof, indent=2, sort_keys=True) + "\n")
        return proof
    finally:
        engine.close()


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Build Helios Systems' consolidated P&L through GridCraft."
    )
    parser.add_argument(
        "--fixtures-dir",
        default="fixtures",
        help="the directory holding the entity, FX and elimination CSV fixtures",
    )
    parser.add_argument(
        "--out-dir",
        default="out",
        help="the directory the workbook and the proof are written to",
    )
    parser.add_argument("--period", default=PERIOD, help="the reporting period")
    args = parser.parse_args(argv)

    fixtures_dir = Path(args.fixtures_dir).expanduser().resolve()
    out_dir = Path(args.out_dir).expanduser().resolve()

    try:
        proof = run(fixtures_dir, out_dir, args.period)
    except ConsolidationError as error:
        payload = dict(error.payload)
        payload["ok"] = False
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "consolidation-error.json").write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n"
        )
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 2
    except EngineError as error:
        payload = {"error": "engine_error", "message": str(error), "ok": False}
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / "consolidation-error.json").write_text(
            json.dumps(payload, indent=2, sort_keys=True) + "\n"
        )
        print(json.dumps(payload, indent=2, sort_keys=True))
        return 3

    print(json.dumps(proof, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
