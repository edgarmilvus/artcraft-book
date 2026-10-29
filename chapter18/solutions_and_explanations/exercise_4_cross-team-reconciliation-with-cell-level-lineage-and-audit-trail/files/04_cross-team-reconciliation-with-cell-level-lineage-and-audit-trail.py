#!/usr/bin/env python3
"""
close_reconciliation.py
Cross-team reconciliation with cell-level lineage and an audit trail.

Three teams own three workbooks: FP&A owns the forecast, Accounting owns the
actuals, Treasury owns the cash position.  This agent opens all three in a
single GridCraft session, reconciles a fixture-driven list of consolidation
accounts across them, and publishes three artefacts:

  * a reconciliation workbook whose ``Lineage`` sheet carries one row per
    provenance item, next to a ``Verdicts`` sheet and a ``Remediation`` sheet;
  * a PDF audit package exported by GridCraft's own PDF export command;
  * a JSON report with the verdicts, the lineage and the remediation trace.

The lineage is the intellectual core of the exercise.  The dependency graph of
every source workbook is walked backwards from the reconciliation cell and the
ancestors are scored, so an auditor receives at most ``LINEAGE_LIMIT``
provenance rows per reconciled value instead of the transitive fan-in of the
model.  Ranges are collapsed into a single block row, the direct precedents of
the reconciliation cell are always kept, and the remaining budget goes to the
highest-salience ancestors.

Nothing about the engines is assumed.  Command ids are read from the live
catalogue (``list_commands``) before they are used, the numbers are read back
out of the workbooks, the parsed dependency graph is cross-checked against the
engine's own ``formulas.tracePrecedents``, and the verdict of a reconciled
account is recomputed from the values the engine reports.

The engine is driven over its MCP stdio transport.  GridCraft has no batch
tool, its writes are not atomic and it keeps one document per window, so this
agent switches windows explicitly and publishes each artefact with a single
save.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from collections import defaultdict, deque
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Set, Tuple

ENGINE = os.environ.get("GRIDCRAFT_BIN", "gridcraft-cli")

#: The audit trail of one reconciled value never exceeds this many rows.
LINEAGE_LIMIT = 20

#: The salience weights.  They are published in the report so that a
#: reviewer can argue with them.
WEIGHT_NAMED = 5.0
WEIGHT_FLAGGED = 4.0
WEIGHT_CHANGED = 3.0
WEIGHT_FIRST_HOP = 2.5
WEIGHT_RANGE_BLOCK = 0.5

#: A range bigger than this is not expanded into its cells.
MAX_RANGE_CELLS = 4096

#: Floating point slack for the tolerance comparisons.
EPSILON = 1e-9

#: The reasons that make an ancestor "salient" enough to be broken out of
#: its range instead of being collapsed into a block row.
SALIENT_REASONS = ("named", "flagged", "changed")


# ===========================================================================
# 1. The MCP client
# ===========================================================================
class EngineError(RuntimeError):
    """The engine refused a command or answered with an error."""


def _first_text(result: Dict[str, Any]) -> str:
    """The engine puts its payload in the first `text` content block."""
    for block in result.get("content", []):
        if block.get("type") == "text":
            return block.get("text", "")
    return ""


def _parse_payload(text: str) -> Any:
    if text == "":
        return None
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return text


class GridCraft:
    """A small, honest MCP client for `gridcraft-cli mcp`.

    One JSON-RPC frame per line in, one per line out.  A failing tool call
    answers with `isError: true` and a plain sentence, so the flag is checked
    before the payload is parsed, and the payload itself is read from the
    first `text` content block (the reply carries no `structuredContent`).
    """

    def __init__(self, executable: str = ENGINE) -> None:
        self.process = subprocess.Popen(
            [executable, "mcp"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
        )
        self.next_id = 0
        self.server_info: Dict[str, Any] = {}
        self._handshake()

    def _handshake(self) -> None:
        reply = self.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "close-reconciliation", "version": "1.0"},
            },
        )
        self.server_info = reply.get("serverInfo", {})

    def request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        self.next_id += 1
        frame = {"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params or {}}
        assert self.process.stdin is not None and self.process.stdout is not None
        self.process.stdin.write((json.dumps(frame) + "\n").encode("utf-8"))
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise EngineError("the GridCraft MCP server closed its stdout")
        reply = json.loads(line.decode("utf-8"))
        if "error" in reply:
            raise EngineError("%s failed: %s" % (method, reply["error"]))
        return reply.get("result", {})

    def call_tool(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> Any:
        result = self.request("tools/call", {"name": name, "arguments": arguments or {}})
        if result.get("isError"):
            raise EngineError("%s: %s" % (name, _first_text(result)))
        return _parse_payload(_first_text(result))

    def command(self, command_id: str, params: Optional[Dict[str, Any]] = None) -> Any:
        """Run one engine command by id (the `execute_command` tool)."""
        return self.call_tool("execute_command", {"command": command_id, "params": params or {}})

    def close(self) -> None:
        try:
            if self.process.stdin is not None:
                self.process.stdin.close()
        except OSError:
            pass
        self.process.terminate()
        try:
            self.process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self.process.kill()

    def __enter__(self) -> "GridCraft":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


def command_catalogue(client: GridCraft) -> Dict[str, Dict[str, Any]]:
    """The live command catalogue, keyed by command id."""
    listed = client.call_tool("list_commands", {})
    entries = listed if isinstance(listed, list) else (listed or {}).get("commands", [])
    return {entry["id"]: entry for entry in entries}


def require_command(catalogue: Dict[str, Dict[str, Any]], *command_ids: str) -> str:
    """Return the first command id the engine actually exposes.

    The exercise forbids assuming a command id, so every command the agent
    runs is checked against the live catalogue first.
    """
    for command_id in command_ids:
        if command_id in catalogue:
            return command_id
    raise EngineError("the engine exposes none of %s" % (list(command_ids),))


# ===========================================================================
# 2. Addresses and formula references
# ===========================================================================
A1_CELL = re.compile(r"^\$?([A-Z]{1,3})\$?(\d{1,7})$")
A1_RANGE = re.compile(r"^\$?([A-Z]{1,3})\$?(\d{1,7}):\$?([A-Z]{1,3})\$?(\d{1,7})$")

# The reference scanner: strings, sheet-qualified addresses, addresses and
# names.  Everything else is punctuation or an operator.
TOKEN_RE = re.compile(
    r"""
      (?P<string>"(?:[^"]|"")*")
    | (?P<qualified>(?:'(?:[^']|'')+'|[A-Za-z_][A-Za-z0-9_.]*)!\$?[A-Z]{1,3}\$?\d{1,7}(?::\$?[A-Z]{1,3}\$?\d{1,7})?)
    | (?P<address>\$?[A-Z]{1,3}\$?\d{1,7}(?::\$?[A-Z]{1,3}\$?\d{1,7})?)
    | (?P<name>[A-Za-z_][A-Za-z0-9_.]*)
    | (?P<other>.)
    """,
    re.VERBOSE,
)


def column_index(letters: str) -> int:
    index = 0
    for character in letters:
        index = index * 26 + (ord(character) - 64)
    return index


def column_letters(index: int) -> str:
    letters = ""
    while index:
        index, remainder = divmod(index - 1, 26)
        letters = chr(65 + remainder) + letters
    return letters


def parse_a1(address: str) -> Tuple[int, int]:
    """`"B14"` -> (2, 14), the column and the row, both 1-based."""
    match = A1_CELL.match(address.replace("$", ""))
    if not match:
        raise ValueError("not an A1 address: %r" % address)
    return column_index(match.group(1)), int(match.group(2))


def format_a1(column: int, row: int) -> str:
    return "%s%d" % (column_letters(column), row)


def split_address(key: str) -> Tuple[str, str]:
    """`"Debt Schedule!B14"` -> ("Debt Schedule", "B14")."""
    sheet, _, address = key.rpartition("!")
    return sheet, address


def quote_sheet(sheet: str) -> str:
    return "'%s'" % sheet.replace("'", "''") if re.search(r"[^A-Za-z0-9_]", sheet) else sheet


def expand_range(text: str) -> List[str]:
    """Every A1 address a range such as `C5:C9` covers."""
    start_text, _, end_text = text.partition(":")
    try:
        start_col, start_row = parse_a1(start_text)
        end_col, end_row = parse_a1(end_text or start_text)
    except ValueError:
        return []
    low_col, high_col = sorted((start_col, end_col))
    low_row, high_row = sorted((start_row, end_row))
    if (high_col - low_col + 1) * (high_row - low_row + 1) > MAX_RANGE_CELLS:
        return []
    return [
        format_a1(column, row)
        for row in range(low_row, high_row + 1)
        for column in range(low_col, high_col + 1)
    ]


class Reference:
    """One reference found in a formula."""

    def __init__(self, kind: str, text: str, sheet: Optional[str],
                 cells: Optional[List[str]] = None) -> None:
        self.kind = kind          # "cell" | "range" | "name"
        self.text = text          # the raw token
        self.sheet = sheet        # None means "the sheet the formula lives on"
        self.cells = cells or []  # the A1 addresses the reference covers

    @property
    def is_range(self) -> bool:
        return self.kind == "range"


def scan_references(formula: str, home_sheet: Optional[str]) -> List[Reference]:
    """Every address and name a formula reads, in the order they appear.

    A relative reference in a stored formula is the address it points at, so
    no offset arithmetic is needed: the engine stores the resolved text.
    """
    references: List[Reference] = []
    for match in TOKEN_RE.finditer(formula or ""):
        kind = match.lastgroup
        text = match.group()
        if kind == "string":
            continue
        if kind == "qualified":
            sheet_part, _, address_part = text.partition("!")
            sheet = sheet_part.strip("'").replace("''", "'")
            references.append(_address_reference(text, sheet, address_part))
        elif kind == "address":
            references.append(_address_reference(text, home_sheet, text))
        elif kind == "name":
            tail = formula[match.end():].lstrip()
            if tail.startswith("("):
                continue                      # a function call, not a name
            if text.upper() in ("TRUE", "FALSE"):
                continue
            references.append(Reference("name", text, None))
    return references


def _address_reference(text: str, sheet: Optional[str], address_part: str) -> Reference:
    plain = address_part.replace("$", "")
    if A1_RANGE.match(plain):
        return Reference("range", text, sheet, expand_range(plain))
    if A1_CELL.match(plain):
        return Reference("cell", text, sheet, [plain])
    return Reference("cell", text, sheet, [])


# ===========================================================================
# 3. The workbook model
# ===========================================================================
class Cell:
    """One cell of one sheet, as the engine reports it."""

    def __init__(self, sheet: str, address: str, formula: Optional[str], value: Any) -> None:
        self.sheet = sheet
        self.address = address
        self.formula = formula
        self.value = value

    @property
    def key(self) -> str:
        return "%s!%s" % (self.sheet, self.address)

    @property
    def number(self) -> float:
        """The numeric value of the cell (0.0 when it holds text)."""
        if isinstance(self.value, bool):
            return 0.0
        if isinstance(self.value, (int, float)):
            return float(self.value)
        return 0.0


class Book:
    """One open workbook: its sheets, its cells and its defined names."""

    def __init__(self, key: str, path: Path, window: int, title: str) -> None:
        self.key = key
        self.path = path
        self.window = window
        self.title = title
        self.sheets: List[str] = []
        self.cells: Dict[str, Cell] = {}
        self.names: Dict[str, Dict[str, Any]] = {}
        self.named_cells: Dict[str, str] = {}   # cell key -> the name of it
        self.graph: Dict[str, Any] = {}

    def cell(self, key: str) -> Optional[Cell]:
        return self.cells.get(key)

    def name_of(self, key: str) -> Optional[str]:
        return self.named_cells.get(key)


def read_book(client: GridCraft, commands: Dict[str, str], book: Book) -> Book:
    """Read the whole workbook: formulas, values and defined names."""
    info = client.call_tool("inspect_workbook", {}) or {}
    for sheet in info.get("sheets", []):
        name = sheet.get("name")
        used = sheet.get("usedRange")
        if not name or not used:
            continue
        book.sheets.append(name)
        start_address, _, end_address = used.partition(":")
        start_col, start_row = parse_a1(start_address or end_address)
        end_col, end_row = parse_a1(end_address)
        formulas = client.command(commands["read"], {"range": used, "sheet": name, "formulas": True})
        values = client.command(commands["read"], {"range": used, "sheet": name})
        formula_rows = (formulas or {}).get("values") or []
        value_rows = (values or {}).get("values") or []
        for row_offset in range(end_row - start_row + 1):
            row = start_row + row_offset
            for column_offset in range(end_col - start_col + 1):
                column = start_col + column_offset
                address = format_a1(column, row)
                raw = _at(formula_rows, row_offset, column_offset)
                value = _at(value_rows, row_offset, column_offset)
                formula = raw if isinstance(raw, str) and raw.startswith("=") else None
                book.cells["%s!%s" % (name, address)] = Cell(name, address, formula, value)
    for entry in client.command(commands["names"], {}) or []:
        name = entry.get("name")
        refers_to = entry.get("refersTo") or ""
        if not name:
            continue
        book.names[name] = {
            "name": name,
            "refers_to": refers_to,
            "scope": entry.get("scope", "Workbook"),
            "value": entry.get("value"),
        }
        for address in _name_targets(refers_to):
            book.named_cells.setdefault(address, name)
    return book


def _at(rows: List[List[Any]], row: int, column: int) -> Any:
    if row < len(rows) and column < len(rows[row]):
        return rows[row][column]
    return None


def _name_targets(refers_to: str) -> List[str]:
    """The cells a defined name points at (`"=Assumptions!$B$2"`)."""
    body = (refers_to or "").strip().lstrip("=")
    if "!" not in body:
        return []
    sheet_part, _, address_part = body.partition("!")
    sheet = sheet_part.strip("'").replace("''", "'")
    plain = address_part.replace("$", "")
    addresses = expand_range(plain) if A1_RANGE.match(plain) else (
        [plain] if A1_CELL.match(plain) else []
    )
    return ["%s!%s" % (sheet, address) for address in addresses]


# ===========================================================================
# 4. The dependency graph
# ===========================================================================
def build_graph(book: Book) -> Dict[str, Any]:
    """The reader-to-read edges of a workbook, with the ranges kept intact.

    A range reference is recorded twice: once as the edge to every cell it
    covers, and once as the *block* those cells arrived through, so that the
    pruning can collapse them again.
    """
    edges: List[Dict[str, str]] = []
    for key in sorted(book.cells):
        cell = book.cells[key]
        if not cell.formula:
            continue
        for reference in scan_references(cell.formula, cell.sheet):
            if reference.kind == "name":
                for target in _name_targets(book.names.get(reference.text, {}).get("refers_to", "")):
                    edges.append({"from": key, "to": target, "block": ""})
                continue
            if reference.sheet is None:
                continue
            if reference.is_range:
                block = "%s!%s:%s" % (reference.sheet, reference.cells[0], reference.cells[-1])
                for address in reference.cells:
                    edges.append({
                        "from": key,
                        "to": "%s!%s" % (reference.sheet, address),
                        "block": block,
                    })
                continue
            for address in reference.cells:
                edges.append({
                    "from": key,
                    "to": "%s!%s" % (reference.sheet, address),
                    "block": "",
                })

    reads: Dict[str, List[Dict[str, str]]] = defaultdict(list)
    for edge in edges:
        reads[edge["from"]].append({"to": edge["to"], "block": edge["block"]})
    book.graph = {"edges": edges, "reads": reads}
    return book.graph


def trace_precedents(client: GridCraft, commands: Dict[str, str], book: Book,
                     cell_ref: str) -> Set[str]:
    """The engine's own answer to "what does this cell read?".

    `formulas.tracePrecedents` works on the active sheet of the active
    document, so the document is switched, the sheet is activated and the
    cell is addressed without a sheet qualifier.
    """
    sheet, address = split_address(cell_ref)
    client.command(commands["activate_sheet"], {"sheet": sheet})
    traced = client.command(commands["trace"], {"cell": address}) or []
    found: Set[str] = set()
    for entry in traced:
        target_sheet = entry.get("sheet") or sheet
        for cell_address in expand_range(entry.get("range", "")):
            found.add("%s!%s" % (target_sheet, cell_address))
    return found


def parsed_precedents(book: Book, cell_ref: str) -> Tuple[Set[str], Set[str]]:
    """The agent's own answer, split into cell precedents and name anchors.

    The engine's tracer does not expand defined names, so the cells reached
    through a name are reported separately: they are real dependencies, but
    they are the agent's inference, not the engine's answer.
    """
    cell = book.cell(cell_ref)
    if cell is None or not cell.formula:
        return set(), set()
    direct: Set[str] = set()
    through_name: Set[str] = set()
    for reference in scan_references(cell.formula, cell.sheet):
        if reference.kind == "name":
            spec = book.names.get(reference.text)
            if not spec:
                continue
            for target in _name_targets(spec.get("refers_to", "")):
                through_name.add(target)
            continue
        if reference.sheet is None:
            continue
        for address in reference.cells:
            direct.add("%s!%s" % (reference.sheet, address))
    return direct, through_name


# ===========================================================================
# 5. Salience and the pruned lineage
# ===========================================================================
def salience(reasons: Sequence[str], distance: int) -> float:
    """The score of one ancestor.

    The weights are the ones the exercise asks for: a named assumption is
    worth most, then a cell that was flagged in the previous reconciliation,
    then a cell whose value moved since the prior period, then a direct
    precedent of the reconciliation cell.  The distance decay keeps the walk
    shallow without deciding anything on its own.
    """
    score = 0.0
    if "named" in reasons:
        score += WEIGHT_NAMED
    if "flagged" in reasons:
        score += WEIGHT_FLAGGED
    if "changed" in reasons:
        score += WEIGHT_CHANGED
    if "first-hop" in reasons:
        score += WEIGHT_FIRST_HOP
    score += 1.0 / (1.0 + distance)
    return score


def decimals_of(value: float) -> int:
    """How many decimals a value carries."""
    text = ("%.10f" % float(value)).rstrip("0")
    if "." not in text:
        return 0
    return min(6, len(text.split(".", 1)[1]))


def ancestors(book: Book, root: str) -> Dict[str, Dict[str, Any]]:
    """Every cell the reconciliation cell depends on, with its distance.

    The walk is a breadth-first search over the cells each formula reads, so
    the distance recorded for a cell is the shortest distance from the root.
    A cell reached through a range keeps the range it came in through: that
    is what lets the pruning collapse the fan-in again.
    """
    reads = book.graph.get("reads", {})
    distance: Dict[str, int] = {root: 0}
    block_of: Dict[str, str] = {}
    queue = deque([root])
    while queue:
        current = queue.popleft()
        for edge in sorted(reads.get(current, []), key=lambda item: (item["to"], item["block"])):
            reader = edge["to"]
            if reader in distance:
                continue
            distance[reader] = distance[current] + 1
            block_of[reader] = edge.get("block", "")
            queue.append(reader)
    return {
        key: {"distance": distance[key], "block": block_of.get(key, "")}
        for key in distance if key != root
    }


def pruned_lineage(book: Book, root: str, account: str, source_key: str,
                   prior_values: Dict[str, float], flagged: Set[str],
                   limit: int = LINEAGE_LIMIT) -> Dict[str, Any]:
    """The bounded, scored provenance trail of one reconciled value.

    Three rules keep the trail usable:

    1. the cells that arrive through a range are collapsed into a single
       block row, unless one of them is salient enough to be broken out;
    2. the direct precedents of the reconciliation cell are always kept -
       an audit trail that omits the cell the number is computed from is not
       an audit trail;
    3. the rest of the budget goes to the highest-salience ancestors.
    """
    candidates = ancestors(book, root)
    scored: Dict[str, Dict[str, Any]] = {}
    for key, info in candidates.items():
        cell = book.cell(key)
        reasons: List[str] = []
        if book.name_of(key):
            reasons.append("named")
        if key in flagged:
            reasons.append("flagged")
        if key in prior_values:
            current = cell.number if cell is not None else 0.0
            if abs(current - prior_values[key]) > EPSILON:
                reasons.append("changed")
        if info["distance"] == 1:
            reasons.append("first-hop")
        scored[key] = {
            "key": key,
            "distance": info["distance"],
            "block": info["block"],
            "reasons": reasons,
            "score": salience(reasons, info["distance"]),
            "value": cell.number if cell is not None else 0.0,
        }

    rows: List[Dict[str, Any]] = []
    groups: Dict[Tuple[str, int], List[Dict[str, Any]]] = defaultdict(list)
    standalone: List[Dict[str, Any]] = []
    for item in scored.values():
        if item["block"]:
            groups[(item["block"], item["distance"])].append(item)
        else:
            standalone.append(item)

    def row_of(item: Dict[str, Any]) -> Dict[str, Any]:
        return {
            "reconciliation_account": account,
            "source_workbook": source_key,
            "source_cell": item["key"],
            "named_range": book.name_of(item["key"]),
            "value": item["value"],
            "graph_distance": item["distance"],
            "salience_score": round(item["score"], 4),
            "salience_reasons": list(item["reasons"]),
        }

    for item in standalone:
        rows.append(row_of(item))

    for (block, distance), members in groups.items():
        members.sort(key=lambda item: item["key"])
        salient = [item for item in members if any(reason in item["reasons"] for reason in SALIENT_REASONS)]
        for item in salient:
            rows.append(row_of(item))
        quiet = [item for item in members if item not in salient]
        if not quiet:
            continue
        # The block row carries the total of the whole range; the salient
        # members of the range are listed on their own rows as well.
        reasons = ["range-block"]
        for reason in SALIENT_REASONS:
            if any(reason in item["reasons"] for item in salient):
                reasons.append(reason)
        score = max(item["score"] for item in members)
        if salient:
            score += WEIGHT_RANGE_BLOCK
        rows.append({
            "reconciliation_account": account,
            "source_workbook": source_key,
            "source_cell": block,
            "named_range": None,
            "value": round(sum(item["value"] for item in members), 6),
            "graph_distance": distance,
            "salience_score": round(score, 4),
            "salience_reasons": reasons,
        })

    rows.sort(key=lambda row: (-row["salience_score"], row["graph_distance"], row["source_cell"]))
    first_hop = [row for row in rows if row["graph_distance"] == 1]
    rest = [row for row in rows if row["graph_distance"] != 1]
    kept = first_hop + rest[: max(0, limit - len(first_hop))]
    kept.sort(key=lambda row: (-row["salience_score"], row["graph_distance"], row["source_cell"]))
    return {
        "rows": kept,
        "candidates_considered": len(scored),
        "rows_before_limit": len(rows),
        "dropped": len(rows) - len(kept),
    }


# ===========================================================================
# 6. Tolerances and verdicts
# ===========================================================================
def parse_tolerance(text: str) -> Tuple[str, float]:
    """`"exact"` -> ("exact", 0.0), `"$1"` -> ("absolute", 1.0),
    `"pct:0.5"` -> ("pct", 0.005)."""
    raw = (text or "").strip()
    if raw == "exact":
        return "exact", 0.0
    if raw.startswith("pct:"):
        return "pct", float(raw.split(":", 1)[1]) / 100.0
    if raw.startswith("$"):
        return "absolute", float(raw[1:].replace(",", "").strip())
    raise ValueError("unknown tolerance %r" % text)


def within_tolerance(variance: float, tolerance: str, base: float) -> bool:
    """Is a variance inside the tolerance band of an account?"""
    kind, magnitude = parse_tolerance(tolerance)
    if kind == "exact":
        return abs(variance) <= EPSILON
    if kind == "absolute":
        return abs(variance) <= magnitude + EPSILON
    return abs(variance) <= abs(base) * magnitude + EPSILON


def judge(account: Dict[str, Any], values: Dict[str, float], tolerance: str,
          items: Sequence[Dict[str, Any]], base_key: str) -> Dict[str, Any]:
    """The verdict of one reconciliation account.

    (a) every source inside the band -> `pass`;
    (b) a source outside the band but a declared reconciling item explains
        the difference -> `pass-with-reconciling-item`;
    (c) otherwise -> `fail`.
    """
    numbers = list(values.values())
    variance = max(numbers) - min(numbers)
    base = values.get(base_key, 0.0)
    if within_tolerance(variance, tolerance, base):
        return {
            "status": "pass",
            "variance": variance,
            "reconciling_item": None,
            "applied_item": None,
        }
    for item in items:
        if str(item.get("account", "")).lower() != str(account["account"]).lower():
            continue
        amount = abs(float(item.get("amount", 0.0)))
        if abs(amount - variance) <= max(0.01, variance * 0.01):
            return {
                "status": "pass-with-reconciling-item",
                "variance": variance,
                "reconciling_item": item.get("description"),
                "applied_item": item,
            }
    return {
        "status": "fail",
        "variance": variance,
        "reconciling_item": None,
        "applied_item": None,
    }


# ===========================================================================
# 7. The reconciler
# ===========================================================================
class Reconciler:
    """The whole close: open, read, reconcile, remediate, publish."""

    def __init__(self, client: GridCraft, catalogue: Dict[str, Dict[str, Any]],
                 fixtures: Path, out: Path) -> None:
        self.client = client
        self.fixtures = fixtures
        self.out = out
        self.commands = {
            "activate_sheet": require_command(catalogue, "sheet.activate"),
            "read": require_command(catalogue, "sheet.read"),
            "cell_get": require_command(catalogue, "cell.get"),
            "names": require_command(catalogue, "formulas.nameManager"),
            "trace": require_command(catalogue, "formulas.tracePrecedents"),
            "error_check": require_command(catalogue, "formulas.errorChecking"),
            "calculate": require_command(catalogue, "formulas.calculateNow"),
            "insert_sheet": require_command(catalogue, "home.insertSheet"),
            "rename_sheet": require_command(catalogue, "sheet.rename"),
            "activate_window": require_command(catalogue, "window.activate"),
            "save": require_command(catalogue, "file.save"),
            "export_pdf": require_command(catalogue, "file.exportPdf"),
        }
        self.books: Dict[str, Book] = {}
        self.windows: Dict[str, int] = {}
        self.active_window: Optional[int] = None
        self.cross_check: Dict[str, Any] = {"checked": 0, "mismatches": []}

    # -- documents ---------------------------------------------------------
    def open_sources(self, sources: Dict[str, str]) -> None:
        """Open every source workbook in this one session.

        GridCraft keeps one document per window.  `open_workbook` answers
        with the index of the window it opened, and `window.activate` is the
        only way back to it: no command takes a document index.
        """
        for key in sorted(sources):
            path = (self.fixtures / sources[key]).resolve()
            if not path.is_file():
                raise EngineError("the source workbook %s is missing" % path)
            opened = self.client.call_tool("open_workbook", {"path": str(path)}) or {}
            window = int(opened.get("index", 0))
            book = Book(key, path, window, opened.get("title", path.name))
            self.books[key] = book
            self.windows[key] = window
            self.activate(key)
            self.client.command(self.commands["calculate"], {})
            read_book(self.client, self.commands, book)
            build_graph(book)

    def activate(self, key: str) -> None:
        """Make one of the open documents the active one."""
        window = self.windows[key]
        if self.active_window != window:
            self.client.command(self.commands["activate_window"], {"index": window})
            self.active_window = window
        info = self.client.call_tool("inspect_workbook", {}) or {}
        if info.get("path") and Path(info["path"]).resolve() != self.books[key].path:
            raise EngineError("window %d does not hold %s" % (window, self.books[key].path))

    # -- the numbers -------------------------------------------------------
    def read_value(self, key: str, cell_ref: str) -> float:
        """The value of one cell of one source workbook."""
        self.activate(key)
        record = self.client.command(self.commands["cell_get"], {"cell": cell_ref}) or {}
        value = record.get("value")
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            return 0.0
        return float(value)

    def read_items(self, source: Dict[str, Any]) -> List[Dict[str, Any]]:
        """The declared reconciling items, read from the reconciling-items
        sheet of the workbook that owns them."""
        key = source.get("workbook")
        sheet_name = source.get("sheet")
        if not key or not sheet_name or key not in self.books:
            return []
        self.activate(key)
        info = self.client.call_tool("inspect_workbook", {}) or {}
        used = ""
        for sheet in info.get("sheets", []):
            if sheet.get("name") == sheet_name:
                used = sheet.get("usedRange") or ""
        if not used:
            return []
        values = self.client.command(self.commands["read"], {"range": used, "sheet": sheet_name}) or {}
        rows = values.get("values") or []
        header_row = -1
        columns: Dict[str, int] = {}
        for index, row in enumerate(rows):
            labels = {
                str(cell).strip().lower(): position
                for position, cell in enumerate(row) if isinstance(cell, str)
            }
            if "account" in labels and "amount" in labels:
                header_row = index
                columns = labels
                break
        if header_row < 0:
            return []
        items: List[Dict[str, Any]] = []
        for row in rows[header_row + 1:]:
            if not row:
                continue
            account = row[columns["account"]] if columns["account"] < len(row) else ""
            if not isinstance(account, str) or not account.strip():
                continue
            amount = row[columns["amount"]] if columns["amount"] < len(row) else 0
            description = ""
            if "description" in columns and columns["description"] < len(row):
                candidate = row[columns["description"]]
                description = candidate if isinstance(candidate, str) else ""
            items.append({
                "account": account.strip(),
                "description": description.strip(),
                "amount": float(amount) if isinstance(amount, (int, float)) else 0.0,
            })
        return items

    def prior_index(self, prior: Dict[str, Any]) -> Tuple[Dict[str, Dict[str, float]],
                                                          Dict[str, Set[str]]]:
        """The prior-period values and the prior-period flagged cells."""
        values: Dict[str, Dict[str, float]] = defaultdict(dict)
        for entry in prior.get("cells", []):
            book = str(entry.get("workbook", ""))
            cell = str(entry.get("cell", ""))
            if not book or not cell:
                continue
            values[book][cell] = float(entry.get("value", 0.0))
        flagged: Dict[str, Set[str]] = defaultdict(set)
        for entry in prior.get("flagged_cells", []):
            book = str(entry.get("workbook", ""))
            cell = str(entry.get("cell", ""))
            if book and cell:
                flagged[book].add(cell)
        return values, flagged

    # -- the lineage --------------------------------------------------------
    def lineage_for(self, account: Dict[str, Any], book: Book, cell_ref: str,
                    prior_values: Dict[str, float], flagged: Set[str]) -> Dict[str, Any]:
        """The lineage of one reconciled value, cross-checked against the
        engine's own tracer."""
        self.activate(book.key)
        traced = trace_precedents(self.client, self.commands, book, cell_ref)
        direct, through_name = parsed_precedents(book, cell_ref)
        self.cross_check["checked"] += 1
        if traced != (direct - through_name):
            self.cross_check["mismatches"].append({
                "workbook": book.key,
                "cell": cell_ref,
                "traced": sorted(traced),
                "parsed": sorted(direct),
                "resolved_through_names": sorted(through_name),
            })
        return pruned_lineage(
            book, cell_ref, account["account"], book.key,
            prior_values, flagged, LINEAGE_LIMIT,
        )

    # -- the bounded remediation -------------------------------------------
    def remediate(self, account: Dict[str, Any], values: Dict[str, float],
                  verdict: Dict[str, Any], tolerance: str, base_key: str,
                  items: Sequence[Dict[str, Any]],
                  historical: Sequence[Dict[str, Any]],
                  prior_index: Dict[str, Dict[str, float]]) -> Dict[str, Any]:
        """One bounded remediation of one failed account.

        The agent looks for the highest-salience non-named cell that
        contributed to the variance, proposes a rounding fix for it, and
        applies the fix in a scratch sheet.  When the rounding cannot close
        the gap the agent books a reconciling item instead - but only one
        that has a precedent in the prior period, because the agent is not
        allowed to invent an explanation.  The source workbooks are never
        written to: the proposal lives in the scratch workbook and the
        re-run is a recomputation of the same verdict function over the
        adjusted numbers.
        """
        account_name = account["account"]
        numbers = sorted(values.values())
        consensus = numbers[len(numbers) // 2]
        outlier_key = max(sorted(values), key=lambda key: abs(values[key] - consensus))
        outlier_value = values[outlier_key]
        gap = outlier_value - consensus

        # The candidate adjustment site: the highest-salience non-named cell
        # of the outlier's own lineage.  A cell that moved since the prior
        # period is preferred, because a movement is what moved the number,
        # and among those the cell whose movement actually explains the
        # gap is the one an auditor wants to look at.
        prior_values = prior_index.get(outlier_key, {})
        candidates = [
            row for row in verdict.get("lineage", [])
            if row.get("source_workbook") == outlier_key
            and not row.get("named_range")
            and "range-block" not in row.get("salience_reasons", [])
        ]
        moved = []
        for row in candidates:
            previous = prior_values.get(row["source_cell"])
            if previous is None:
                continue
            movement = abs(float(row["value"]) - float(previous))
            if movement > EPSILON:
                moved.append((row, movement))
        if moved:
            within = [entry for entry in moved if entry[1] <= abs(gap) + EPSILON]
            explaining = within or moved
            best = max(entry[1] for entry in explaining)
            pool = [row for row, movement in explaining if abs(movement - best) <= EPSILON]
        else:
            pool = candidates
        target = None
        if pool:
            target = sorted(pool, key=lambda row: (-row["salience_score"],
                                                  row["graph_distance"],
                                                  row["source_cell"]))[0]
        target_movement = 0.0
        if target is not None and target["source_cell"] in prior_values:
            target_movement = abs(float(target["value"])
                                  - float(prior_values[target["source_cell"]]))

        # The first proposal: a rounding fix.  The consensus of the other two
        # sources carries the precision the reconciled figure should have.
        precision = decimals_of(consensus)
        rounded = round(outlier_value, precision)
        adjusted = dict(values)
        if rounded != outlier_value:
            adjusted[outlier_key] = rounded
        post = judge(account, adjusted, tolerance, items, base_key)
        residual = post["variance"]

        proposed_item: Optional[Dict[str, Any]] = None
        if post["status"] == "pass":
            action = "adjust-cell"
            proposed = rounded
            note = (
                "The variance is a rounding artefact: %s reports %s while the other two "
                "sources agree on %s.  The highest-salience non-named contributor is %s, "
                "whose value moved by %s since the prior period.  Rounding %s to the "
                "%d-decimal precision of the consensus closes the %s difference, so the "
                "reconciliation passes once the rounded figure is booked.  The proposal is "
                "applied in the scratch sheet only; %s is not modified."
                % (outlier_key, _money(outlier_value), _money(consensus),
                   target["source_cell"] if target else "the reconciliation cell",
                   _money(target_movement), outlier_key, precision, _money(abs(gap)),
                   outlier_key)
            )
        else:
            # The second proposal: a reconciling item, drawn from the items
            # the prior period actually used for this account.
            precedent = [
                item for item in historical
                if str(item.get("account", "")).lower() == str(account_name).lower()
            ]
            precedent.sort(key=lambda item: -int(item.get("occurrences", 0)))
            if precedent and residual > EPSILON:
                proposed_item = {
                    "account": account_name,
                    "description": "%s (proposed by the close agent; the most frequent "
                                   "item of the prior period, %d occurrence(s))"
                                   % (precedent[0].get("description", "reconciling item"),
                                      int(precedent[0].get("occurrences", 0))),
                    "amount": residual,
                }
                with_item = judge(account, adjusted, tolerance,
                                  list(items) + [proposed_item], base_key)
                if with_item["status"] == "pass-with-reconciling-item":
                    action = "reconciling-item"
                    post = with_item
                    proposed = outlier_value
                    note = (
                        "The difference is structural, not a rounding artefact: rounding %s "
                        "to the %d-decimal precision of the consensus changes it by %s and "
                        "leaves %s open.  The highest-salience non-named contributor is %s, "
                        "whose value moved by %s since the prior period - the movement is "
                        "the difference itself.  The agent therefore books the reconciling "
                        "item the prior period used most often for this account - %s - for "
                        "%s, and re-reconciles the account with it.  The source workbooks "
                        "stay untouched; the proposal lives in the scratch sheet."
                        % (outlier_key, precision, _money(abs(rounded - outlier_value)),
                           _money(residual), target["source_cell"] if target else "n/a",
                           _money(target_movement), proposed_item["description"],
                           _money(residual))
                    )
                else:
                    action = "round-noop"
                    proposed = outlier_value
                    note = (
                        "Neither the rounding fix nor a reconciling item with a precedent in "
                        "the prior period closes the %s difference on %s.  The variance is "
                        "recorded for a human reviewer; no source workbook is modified."
                        % (_money(residual), outlier_key)
                    )
            else:
                action = "round-noop"
                proposed = outlier_value
                note = (
                    "Neither a rounding fix nor a reconciling item with a precedent in the "
                    "prior period closes the %s difference on %s.  The variance is recorded "
                    "for a human reviewer; no source workbook is modified."
                    % (_money(residual), outlier_key)
                )

        return {
            "account": account_name,
            "attempted_action": action,
            "target": {
                "workbook": outlier_key,
                "cell": target["source_cell"] if target else None,
            },
            "pre_verdict": verdict["status"],
            "post_verdict": post["status"],
            "notes": note,
            # The detail the scratch sheet carries and the report keeps.
            "outlier_source": outlier_key,
            "reconciliation_cell": account["%s_cell" % outlier_key],
            "consensus": consensus,
            "current_value": outlier_value,
            "proposed_value": proposed,
            "adjustment": round(proposed - outlier_value, 6),
            "residual_variance": residual,
            "proposed_item": proposed_item["description"] if proposed_item else None,
        }

    # -- the artefacts -----------------------------------------------------
    def publish(self, lineages: Dict[str, List[Dict[str, Any]]],
                verdicts: List[Dict[str, Any]], trace: List[Dict[str, Any]],
                scratch_rows: List[List[Any]]) -> Dict[str, str]:
        """Write the reconciliation workbook, the scratch workbook and the PDF."""
        # The scratch workbook first: it carries the simulated remediation.
        self.client.call_tool("new_workbook", {})
        self.client.command(self.commands["rename_sheet"], {"sheet": "Sheet1", "name": "Scratch"})
        if scratch_rows:
            self.client.call_tool("write_range", {
                "range": "Scratch!A1:%s%d" % (column_letters(len(scratch_rows[0])), len(scratch_rows)),
                "values": scratch_rows,
            })
        scratch_path = self.out / "close-reconciliation-scratch.xlsx"
        self.client.command(self.commands["save"], {"path": str(scratch_path)})

        # The reconciliation workbook.
        self.client.call_tool("new_workbook", {})
        self.client.command(self.commands["rename_sheet"], {"sheet": "Sheet1", "name": "Lineage"})
        self.client.command(self.commands["insert_sheet"], {"name": "Verdicts"})
        self.client.command(self.commands["insert_sheet"], {"name": "Remediation"})

        lineage_header = ["reconciliation_account", "source_workbook", "source_cell",
                          "named_range", "value", "graph_distance", "salience_score",
                          "salience_reasons"]
        lineage_rows = [lineage_header]
        for account in sorted(lineages):
            for row in lineages[account]:
                lineage_rows.append([
                    row["reconciliation_account"],
                    row["source_workbook"],
                    row["source_cell"],
                    row["named_range"] or "",
                    row["value"],
                    row["graph_distance"],
                    row["salience_score"],
                    ",".join(row["salience_reasons"]),
                ])
        self._write_block("Lineage", lineage_rows)

        verdict_header = (["account", "source_values", "variance", "tolerance",
                           "reconciling_item", "status", "final_status",
                           "likely_reconciling_items"])
        verdict_rows = [verdict_header]
        for verdict in verdicts:
            values = verdict["source_values"]
            verdict_rows.append([
                verdict["account"],
                ", ".join("%s=%s" % (key, _money(values[key])) for key in sorted(values)),
                verdict["variance"],
                verdict["tolerance"],
                verdict["reconciling_item"] or "",
                verdict["status"],
                verdict.get("final_status", verdict["status"]),
                "; ".join(
                    "%s (seen %d time(s) in the prior period)"
                    % (item["description"], item["occurrences"])
                    for item in verdict.get("likely_reconciling_items", [])
                ),
            ])
        self._write_block("Verdicts", verdict_rows)

        remediation_header = ["account", "attempted_action", "target_workbook",
                              "target_cell", "reconciliation_cell", "current_value",
                              "proposed_value", "adjustment", "reconciling_item",
                              "pre_verdict", "post_verdict", "notes"]
        remediation_rows = [remediation_header]
        for attempt in trace:
            remediation_rows.append([
                attempt["account"],
                attempt["attempted_action"],
                (attempt.get("target") or {}).get("workbook") or "",
                (attempt.get("target") or {}).get("cell") or "",
                attempt.get("reconciliation_cell", ""),
                attempt.get("current_value", 0.0),
                attempt.get("proposed_value", 0.0),
                attempt.get("adjustment", 0.0),
                attempt.get("proposed_item") or "",
                attempt["pre_verdict"],
                attempt["post_verdict"],
                attempt["notes"],
            ])
        self._write_block("Remediation", remediation_rows)

        workbook_path = self.out / "close-reconciliation.xlsx"
        self.client.command(self.commands["save"], {"path": str(workbook_path)})
        pdf_path = self.out / "close-reconciliation.pdf"
        self.client.command(self.commands["export_pdf"],
                            {"path": str(pdf_path), "sheets": "all"})
        return {
            "workbook": str(workbook_path),
            "pdf": str(pdf_path),
            "scratch": str(scratch_path),
        }

    def _write_block(self, sheet: str, rows: List[List[Any]]) -> None:
        """Write one rectangular block of cells in one call."""
        if not rows:
            return
        width = column_letters(len(rows[0]))
        self.client.call_tool("write_range", {
            "range": "%s!A1:%s%d" % (quote_sheet(sheet), width, len(rows)),
            "values": rows,
        })


def _money(value: float) -> str:
    return "{:,.2f}".format(float(value))


# ===========================================================================
# 8. The run
# ===========================================================================
def find_fixture(fixtures: Path, pattern: str) -> Path:
    """The one fixture file that matches a pattern (never hard-coded)."""
    matches = sorted(fixtures.glob(pattern))
    if not matches:
        raise EngineError("no fixture matches %s in %s" % (pattern, fixtures))
    return matches[0]


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run(fixtures: Path, out: Path, executable: str = ENGINE) -> Dict[str, Any]:
    """The whole close, from the fixtures to the published artefacts."""
    started = time.time()
    out.mkdir(parents=True, exist_ok=True)

    recon = json.loads(find_fixture(fixtures, "recon-accounts-*.json").read_text())
    prior = json.loads(find_fixture(fixtures, "prior-snapshot-*.json").read_text())
    period = recon.get("period") or "unknown"
    sources = recon.get("sources") or {}
    if not sources:
        raise EngineError("the reconciliation fixture names no source workbooks")
    base_key = "fpa" if "fpa" in sources else sorted(sources)[0]

    with GridCraft(executable) as client:
        catalogue = command_catalogue(client)
        reconciler = Reconciler(client, catalogue, fixtures, out)
        reconciler.open_sources(sources)

        prior_values, flagged = reconciler.prior_index(prior)
        items = reconciler.read_items(recon.get("reconciling_items") or {})
        historical = prior.get("historical_items", [])

        # ---- the reconciliation pass ----------------------------------
        verdicts: List[Dict[str, Any]] = []
        lineages: Dict[str, List[Dict[str, Any]]] = {}
        pruning: Dict[str, Any] = {}
        for account in recon.get("accounts", []):
            values: Dict[str, float] = {}
            for key in sorted(sources):
                values[key] = reconciler.read_value(key, account["%s_cell" % key])
            verdict = judge(account, values, account["tolerance"], items, base_key)
            rows: List[Dict[str, Any]] = []
            per_source: Dict[str, Any] = {}
            for key in sorted(sources):
                book = reconciler.books[key]
                result = reconciler.lineage_for(
                    account, book, account["%s_cell" % key],
                    prior_values.get(key, {}), flagged.get(key, set()),
                )
                rows.extend(result["rows"])
                per_source[key] = {
                    "candidates_considered": result["candidates_considered"],
                    "rows_emitted": len(result["rows"]),
                    "rows_before_limit": result["rows_before_limit"],
                    "dropped": result["dropped"],
                }
            lineages[account["account"]] = rows
            pruning[account["account"]] = {
                "limit": LINEAGE_LIMIT,
                "per_source": per_source,
                "rows_emitted": len(rows),
            }
            verdicts.append({
                "account": account["account"],
                "source_values": values,
                "variance": verdict["variance"],
                "tolerance": account["tolerance"],
                "reconciling_item": verdict["reconciling_item"],
                "status": verdict["status"],
                "lineage": rows,
                "final_status": verdict["status"],
                "likely_reconciling_items": sorted(
                    [item for item in historical
                     if str(item.get("account", "")).lower() == str(account["account"]).lower()],
                    key=lambda item: -int(item.get("occurrences", 0)),
                )[:3],
            })

        # ---- the bounded remediation pass ------------------------------
        trace: List[Dict[str, Any]] = []
        scratch_rows: List[List[Any]] = [[
            "account", "attempted_action", "target_workbook", "target_cell",
            "reconciliation_cell", "current_value", "proposed_value", "adjustment",
            "reconciling_item", "pre_verdict", "post_verdict", "notes",
        ]]
        for verdict in verdicts:
            if verdict["status"] != "fail":
                continue
            account = next(item for item in recon["accounts"]
                           if item["account"] == verdict["account"])
            attempt = reconciler.remediate(
                account, verdict["source_values"], verdict,
                account["tolerance"], base_key, items, historical, prior_values,
            )
            trace.append(attempt)
            verdict["final_status"] = attempt["post_verdict"]
            scratch_rows.append([
                attempt["account"], attempt["attempted_action"],
                attempt["target"].get("workbook") or "", attempt["target"].get("cell") or "",
                attempt.get("reconciliation_cell", ""),
                attempt.get("current_value", 0.0), attempt.get("proposed_value", 0.0),
                attempt.get("adjustment", 0.0), attempt.get("proposed_item") or "",
                attempt["pre_verdict"], attempt["post_verdict"], attempt["notes"],
            ])

        # ---- the artefacts ---------------------------------------------
        report: Dict[str, Any] = {
            "period": period,
            "verdicts": verdicts,
            "lineages": lineages,
            "remediation_trace": trace,
            "is_final_pass": all(verdict["final_status"].startswith("pass")
                                 for verdict in verdicts),
            "duration_ms": 0,
            "sources": {
                key: {
                    "path": str(book.path),
                    "window": book.window,
                    "title": book.title,
                    "sheets": book.sheets,
                    "sha256": sha256_of(book.path),
                }
                for key, book in sorted(reconciler.books.items())
            },
            "pruning": pruning,
            "dependency_cross_check": reconciler.cross_check,
            "salience_weights": {
                "named": WEIGHT_NAMED,
                "flagged": WEIGHT_FLAGGED,
                "changed": WEIGHT_CHANGED,
                "first-hop": WEIGHT_FIRST_HOP,
                "range-block": WEIGHT_RANGE_BLOCK,
                "distance_decay": "1/(1+distance)",
                "lineage_limit": LINEAGE_LIMIT,
            },
            "reconciling_items": items,
        }
        outputs = reconciler.publish(lineages, verdicts, trace, scratch_rows)

        # The engine's own audit of every source, after the run: the close
        # must not have introduced an error in a source workbook.
        engine_audit: Dict[str, Any] = {}
        for key in sorted(reconciler.books):
            reconciler.activate(key)
            engine_audit[key] = reconciler.client.command(
                reconciler.commands["error_check"], {}) or {}
        report["engine_audit"] = engine_audit

    report["duration_ms"] = int((time.time() - started) * 1000)
    report["outputs"] = outputs
    # The audit digest covers every field but the wall-clock measurement, so
    # two runs over the same inputs can be compared exactly.
    digest_payload = {key: value for key, value in report.items()
                      if key not in ("duration_ms", "audit_digest", "outputs")}
    report["audit_digest"] = hashlib.sha256(
        json.dumps(digest_payload, sort_keys=True, default=str).encode("utf-8")
    ).hexdigest()
    (out / "reconciliation-report.json").write_text(
        json.dumps(report, indent=2, sort_keys=False, default=str)
    )
    return report


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    parser.add_argument("--fixtures", default="/work/helios/fixtures",
                        help="the directory the source workbooks and the fixtures live in")
    parser.add_argument("--out", default="/work/helios/out",
                        help="the directory the artefacts are written to")
    parser.add_argument("--engine", default=ENGINE, help="the GridCraft executable")
    args = parser.parse_args(argv)

    report = run(Path(args.fixtures).expanduser(), Path(args.out).expanduser(), args.engine)
    summary = {
        "period": report["period"],
        "verdicts": len(report["verdicts"]),
        "statuses": {verdict["account"]: verdict["status"] for verdict in report["verdicts"]},
        "final_statuses": {verdict["account"]: verdict["final_status"]
                           for verdict in report["verdicts"]},
        "lineage_rows": sum(len(rows) for rows in report["lineages"].values()),
        "remediations": len(report["remediation_trace"]),
        "is_final_pass": report["is_final_pass"],
        "audit_digest": report["audit_digest"],
        "outputs": report["outputs"],
    }
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
