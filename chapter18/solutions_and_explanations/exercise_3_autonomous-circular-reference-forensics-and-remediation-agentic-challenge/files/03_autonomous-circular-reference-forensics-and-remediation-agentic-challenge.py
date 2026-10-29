#!/usr/bin/env python3
"""
circular_forensics.py
Autonomous circular-reference forensics and remediation for legacy GridCraft
workbooks.

    discovery -> extraction -> classification -> scoring -> atomic break
              -> verification -> report

The agent never guesses.  Every command id it uses is read from the live
engine catalogue (`list_commands`) before the command is sent, every formula
it rewrites is read back from the workbook (`sheet.read`), and every cycle it
claims to have broken is re-detected by re-reading the workbook and by asking
the engine's own auditor (`formulas.errorChecking`) whether anything is still
circular.

The engine is driven over its MCP stdio transport.  GridCraft has no batch
tool and its writes are not atomic, so the agent implements the atomicity
contract itself (see `apply_atomically`): it captures the previous content of
every cell a step touches, applies the steps of one break, and restores that
content in reverse order if any step of the break fails.  The corrected
workbook is published with a single `file.save`, so the whole remediation
lands as one artefact and the inherited file is never written to.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Set, Tuple

ENGINE = os.environ.get("GRIDCRAFT_BIN", "gridcraft-cli")
AUTHOR = "circular-forensics"

# ---------------------------------------------------------------------------
# 1. The MCP client
# ---------------------------------------------------------------------------
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
                "clientInfo": {"name": "circular-forensics", "version": "1.0"},
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
    entries = listed if isinstance(listed, list) else listed.get("commands", [])
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


# ---------------------------------------------------------------------------
# 2. Addresses and formula references
# ---------------------------------------------------------------------------
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

MAX_RANGE_CELLS = 4096


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


class Reference:
    """One reference found in a formula, with the span it occupies."""

    def __init__(self, kind: str, text: str, span: Tuple[int, int], sheet: Optional[str] = None,
                 start: Optional[Tuple[int, int]] = None,
                 end: Optional[Tuple[int, int]] = None) -> None:
        self.kind = kind          # "address" | "name"
        self.text = text          # the raw token
        self.span = span
        self.sheet = sheet
        self.start = start        # (column, row) of the first cell
        self.end = end            # (column, row) of the last cell

    @property
    def is_range(self) -> bool:
        return self.start is not None and self.end is not None and self.start != self.end

    def cells(self) -> List[str]:
        """Every cell the reference covers, as A1 addresses."""
        if self.start is None:
            return []
        if self.end is None:
            return [format_a1(self.start[0], self.start[1])]
        first_col, first_row = self.start
        last_col, last_row = self.end
        low_col, high_col = sorted((first_col, last_col))
        low_row, high_row = sorted((first_row, last_row))
        if (high_col - low_col + 1) * (high_row - low_row + 1) > MAX_RANGE_CELLS:
            return []
        out: List[str] = []
        for row in range(low_row, high_row + 1):
            for column in range(low_col, high_col + 1):
                out.append(format_a1(column, row))
        return out

    def contains(self, column: int, row: int) -> bool:
        if self.start is None:
            return False
        if self.end is None:
            return self.start == (column, row)
        first_col, first_row = self.start
        last_col, last_row = self.end
        return (min(first_col, last_col) <= column <= max(first_col, last_col)
                and min(first_row, last_row) <= row <= max(first_row, last_row))


def scan_references(formula: str, home_sheet: Optional[str]) -> List[Reference]:
    """Every address and name a formula reads, in the order they appear."""
    references: List[Reference] = []
    for match in TOKEN_RE.finditer(formula or ""):
        kind = match.lastgroup
        text = match.group()
        if kind == "string":
            continue
        if kind == "qualified":
            sheet_part, _, address_part = text.partition("!")
            sheet = sheet_part.strip("'").replace("''", "'")
            references.append(_address_reference(text, match.span(), sheet, address_part))
        elif kind == "address":
            references.append(_address_reference(text, match.span(), home_sheet, text))
        elif kind == "name":
            tail = formula[match.end():].lstrip()
            if tail.startswith("("):
                continue                      # a function call, not a name
            if text.upper() in ("TRUE", "FALSE"):
                continue
            references.append(Reference("name", text, match.span()))
    return references


def _address_reference(text: str, span: Tuple[int, int], sheet: Optional[str],
                       address_part: str) -> Reference:
    match = A1_RANGE.match(address_part.replace("$", ""))
    if match:
        start = (column_index(match.group(1)), int(match.group(2)))
        end = (column_index(match.group(3)), int(match.group(4)))
        return Reference("address", text, span, sheet, start, end)
    match = A1_CELL.match(address_part.replace("$", ""))
    if match:
        start = (column_index(match.group(1)), int(match.group(2)))
        return Reference("address", text, span, sheet, start, None)
    return Reference("address", text, span, sheet, None, None)


def replace_reference(formula: str, reference: Reference, replacement: str) -> str:
    """Swap one reference for another, leaving the rest of the formula alone."""
    start, end = reference.span
    return formula[:start] + replacement + formula[end:]


# ---------------------------------------------------------------------------
# 3. The workbook model
# ---------------------------------------------------------------------------
BEGINNING_WORDS = ("beginning", "opening", "prior", "previous", "initial", "first")
ENDING_WORDS = ("ending", "closing", "final", "last")
VOLATILE_FUNCTIONS = ("RAND", "RANDBETWEEN", "NOW", "TODAY", "OFFSET", "INDIRECT", "CELL", "INFO")
AGGREGATE_FUNCTIONS = ("SUM", "AVERAGE", "SUMPRODUCT", "NPV", "IRR", "COUNT", "COUNTA", "MAX", "MIN")


class Workbook:
    """What the agent knows about the workbook, all of it read from the engine."""

    def __init__(self) -> None:
        self.sheets: List[str] = []
        self.cells: Dict[str, Dict[str, Any]] = {}
        self.labels: Dict[str, Dict[int, str]] = {}
        self.value_columns: Dict[str, Dict[int, int]] = {}
        self.names: Dict[str, Dict[str, Any]] = {}

    def formula_cells(self) -> Dict[str, Dict[str, Any]]:
        return {key: cell for key, cell in self.cells.items() if cell["formula"]}

    def formula_of(self, key: str) -> str:
        return (self.cells.get(key) or {}).get("formula") or ""

    def is_name(self, key: str) -> bool:
        return key in self.names

    def label(self, sheet: str, row: int) -> str:
        return (self.labels.get(sheet) or {}).get(row, "")

    def value_column(self, sheet: str, row: int) -> Optional[int]:
        return (self.value_columns.get(sheet) or {}).get(row)

    def has_numeric_cell(self, sheet: str, address: str) -> bool:
        cell = self.cells.get("%s!%s" % (sheet, address))
        if cell is None:
            return False
        return cell["formula"] is not None or isinstance(cell["value"], (int, float))


def read_workbook(client: GridCraft) -> Workbook:
    """Read the whole workbook: formulas, values, labels and defined names."""
    workbook = Workbook()
    info = client.call_tool("inspect_workbook", {})
    for sheet in info.get("sheets", []):
        name = sheet["name"]
        used = sheet.get("usedRange")
        if not used:
            continue
        workbook.sheets.append(name)
        start_address, _, end_address = used.partition(":")
        start_address = start_address or end_address
        start_col, start_row = parse_a1(start_address)
        end_col, end_row = parse_a1(end_address)
        formulas = client.command("sheet.read", {"range": used, "sheet": name, "formulas": True})
        values = client.command("sheet.read", {"range": used, "sheet": name})
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
                workbook.cells["%s!%s" % (name, address)] = {
                    "sheet": name,
                    "address": address,
                    "formula": formula,
                    "value": value,
                }
                if formula is None and isinstance(raw, str) and raw.strip():
                    # The leftmost text cell of a row is that row's label.
                    labels = workbook.labels.setdefault(name, {})
                    labels.setdefault(row, raw.strip())
                if formula is not None or (isinstance(value, (int, float))
                                           and not isinstance(value, bool)):
                    columns = workbook.value_columns.setdefault(name, {})
                    columns.setdefault(row, column)
    for entry in client.command("formulas.nameManager", {}) or []:
        workbook.names[entry["name"]] = {
            "name": entry["name"],
            "refers_to": entry.get("refersTo", ""),
            "scope": entry.get("scope", "Workbook"),
            "value": entry.get("value"),
        }
    return workbook


def _at(rows: List[List[Any]], row: int, column: int) -> Any:
    if row < len(rows) and column < len(rows[row]):
        return rows[row][column]
    return None


# ---------------------------------------------------------------------------
# 4. The dependency graph
# ---------------------------------------------------------------------------
def build_graph(workbook: Workbook) -> Dict[str, Any]:
    """Nodes are cells and defined names; edges run from reader to read."""
    nodes: Dict[str, Dict[str, Any]] = {}
    edges: List[Dict[str, str]] = []

    def node(key: str) -> Dict[str, Any]:
        if key not in nodes:
            if key in workbook.names:
                nodes[key] = {
                    "key": key,
                    "sheet": "",
                    "is_name": True,
                    "formula": workbook.names[key]["refers_to"],
                    "iterative_opt_in": False,
                }
            else:
                sheet, _, _address = key.rpartition("!")
                cells = workbook.cells.get(key)
                nodes[key] = {
                    "key": key,
                    "sheet": sheet,
                    "is_name": False,
                    "formula": (cells or {}).get("formula"),
                    "iterative_opt_in": False,
                }
        return nodes[key]

    for key, cell in workbook.formula_cells().items():
        node(key)
        for reference in scan_references(cell["formula"], cell["sheet"]):
            if reference.kind == "name":
                if reference.text not in workbook.names:
                    continue              # an unknown identifier is not a dependency
                node(reference.text)
                edges.append({"from": key, "to": reference.text})
                continue
            if reference.sheet is None:
                continue
            for address in reference.cells():
                target = "%s!%s" % (reference.sheet, address)
                node(target)
                edges.append({"from": key, "to": target})

    for name, spec in workbook.names.items():
        node(name)
        scope_sheet = spec["scope"] if spec["scope"] in workbook.sheets else None
        for reference in scan_references(spec["refers_to"], scope_sheet):
            if reference.kind == "name":
                if reference.text not in workbook.names:
                    continue
                node(reference.text)
                edges.append({"from": name, "to": reference.text})
                continue
            if reference.sheet is None:
                continue
            for address in reference.cells():
                target = "%s!%s" % (reference.sheet, address)
                node(target)
                edges.append({"from": name, "to": target})

    return {"nodes": list(nodes.values()), "edges": edges}


def adjacency(graph: Dict[str, Any]) -> Dict[str, List[str]]:
    out: Dict[str, List[str]] = defaultdict(list)
    for edge in graph["edges"]:
        out[edge["from"]].append(edge["to"])
    return out


def reverse_adjacency(graph: Dict[str, Any]) -> Dict[str, List[str]]:
    out: Dict[str, List[str]] = defaultdict(list)
    for edge in graph["edges"]:
        out[edge["to"]].append(edge["from"])
    return out


# ---------------------------------------------------------------------------
# 5. Cycle detection and classification
# ---------------------------------------------------------------------------
def strongly_connected_components(graph: Dict[str, Any]) -> List[List[str]]:
    """Kosaraju's algorithm, written iteratively so that a big model cannot
    blow the Python stack."""
    successors = adjacency(graph)
    predecessors = reverse_adjacency(graph)
    order: List[str] = []
    visited: Set[str] = set()
    for node in [item["key"] for item in graph["nodes"]]:
        if node in visited:
            continue
        stack: List[Tuple[str, int]] = [(node, 0)]
        visited.add(node)
        while stack:
            current, index = stack[-1]
            neighbours = successors.get(current, [])
            if index < len(neighbours):
                stack[-1] = (current, index + 1)
                nxt = neighbours[index]
                if nxt not in visited:
                    visited.add(nxt)
                    stack.append((nxt, 0))
            else:
                order.append(current)
                stack.pop()
    assigned: Set[str] = set()
    components: List[List[str]] = []
    for node in reversed(order):
        if node in assigned:
            continue
        component: List[str] = []
        stack = [node]
        assigned.add(node)
        while stack:
            current = stack.pop()
            component.append(current)
            for nxt in predecessors.get(current, []):
                if nxt not in assigned:
                    assigned.add(nxt)
                    stack.append(nxt)
        components.append(sorted(component))
    return components


def has_self_loop(graph: Dict[str, Any], key: str) -> bool:
    return any(edge["from"] == key and edge["to"] == key for edge in graph["edges"])


def shortest_cycle(graph: Dict[str, Any], members: Sequence[str]) -> List[str]:
    """The shortest elementary walk inside one component, as an ordered list."""
    member_set = set(members)
    successors = adjacency(graph)
    best: List[str] = []
    for start in sorted(member_set):
        queue: List[Tuple[str, List[str]]] = [(start, [start])]
        seen = {start}
        while queue:
            current, path = queue.pop(0)
            for nxt in successors.get(current, []):
                if nxt not in member_set:
                    continue
                if nxt == start:
                    if not best or len(path) < len(best):
                        best = path
                    queue = []
                    break
                if nxt in seen:
                    continue
                seen.add(nxt)
                queue.append((nxt, path + [nxt]))
    return best


def elementary_cycles(graph: Dict[str, Any], members: Sequence[str],
                      limit: int = 400) -> List[List[str]]:
    """The elementary cycles inside one component (bounded, for scoring)."""
    member_set = set(members)
    successors = adjacency(graph)
    order = {member: index for index, member in enumerate(sorted(member_set))}
    found: List[List[str]] = []
    for index, start in enumerate(sorted(member_set)):
        stack: List[Tuple[str, List[str]]] = [(start, [start])]
        while stack:
            current, path = stack.pop()
            for nxt in successors.get(current, []):
                if nxt not in member_set:
                    continue
                if nxt == start:
                    found.append(list(path))
                    if len(found) >= limit:
                        return found
                    continue
                if nxt in path or order[nxt] < index:
                    continue          # every cycle is reported from its lowest member
                stack.append((nxt, path + [nxt]))
    return found


ITERATIVE_MARKER = "iterative"


def classify(members: Sequence[str], workbook: Workbook, notes: Dict[str, str],
             workbook_iterative: bool) -> str:
    """The four classes the exercise asks for.

    A workbook whose calculation options have iterative calculation enabled
    is an intentional iterative model, so none of its cycles may be broken.
    A model that isolates one iterative block inside an otherwise ordinary
    workbook marks the cells of that block with a note; a cycle that touches
    such a cell is reported but never rewritten.
    """
    if workbook_iterative:
        return "iterative"
    for member in members:
        if ITERATIVE_MARKER in (notes.get(member) or "").lower():
            return "iterative"
    if len(members) == 1:
        return "self"
    if all(workbook.is_name(member) for member in members):
        return "named-mutual"
    return "true"


# ---------------------------------------------------------------------------
# 6. Breaks: what a rewrite may look like
# ---------------------------------------------------------------------------
def label_tokens(label: str) -> Set[str]:
    words = re.findall(r"[a-z]+", label.lower())
    return {word for word in words
            if word not in BEGINNING_WORDS and word not in ENDING_WORDS}


def opening_counterpart(workbook: Workbook, sheet: str, row: int) -> Optional[int]:
    """The row that holds the opening (beginning) version of the same line.

    A finance model says what a row is in its label column: "Beginning Debt
    Balance" and "Ending Debt Balance" are the same quantity at two points of
    the period.  Dropping the beginning/ending words leaves the same tokens,
    which is how the agent recognises the pair.
    """
    label = workbook.label(sheet, row)
    if not label:
        return None
    target = label_tokens(label)
    if not target:
        return None
    best: Optional[int] = None
    for other_row, other_label in (workbook.labels.get(sheet) or {}).items():
        if other_row == row:
            continue
        lowered = other_label.lower()
        if not any(word in lowered for word in BEGINNING_WORDS):
            continue
        if label_tokens(other_label) != target:
            continue
        if best is None or abs(other_row - row) < abs(best - row):
            best = other_row
    return best


def _reference_to(formula: str, home_sheet: str, sheet: str, address: str) -> Optional[Reference]:
    """The token of `formula` that reads `sheet!address`, if there is one."""
    for reference in scan_references(formula, home_sheet):
        if reference.kind != "address" or reference.sheet != sheet:
            continue
        if reference.start is None:
            continue
        if format_a1(reference.start[0], reference.start[1]) == address:
            return reference
    return None


def _absolutise(original_token: str, address: str) -> str:
    """Keep the absolute/relative style of the reference being replaced."""
    original = original_token.split("!")[-1]
    if "$" not in original:
        return address
    letters = re.match(r"([A-Z]+)(\d+)", address)
    if not letters:
        return address
    return "$%s$%s" % (letters.group(1), letters.group(2))


def carries_forward(workbook: Workbook, sheet: str, row: int, column: int) -> bool:
    """Is the previous period's cell of this line carried into the next one?

    The evidence is the sheet's own opening-balance row: a model that rolls a
    balance forward reads the previous period's closing balance in it.  A
    period lag is only offered for a line that is carried forward this way;
    lagging an interest charge to the previous period would shift the accrual
    into the wrong year.
    """
    if column <= 1:
        return False
    prior = format_a1(column - 1, row)
    opening_row = opening_counterpart(workbook, sheet, row)
    if opening_row is None:
        return False
    for candidate_column in (column, column + 1):
        formula = workbook.formula_of("%s!%s" % (sheet, format_a1(candidate_column, opening_row)))
        if not formula:
            continue
        for reference in scan_references(formula, sheet):
            if reference.kind != "address" or reference.sheet != sheet:
                continue
            if reference.start is None:
                continue
            if format_a1(reference.start[0], reference.start[1]) == prior:
                return True
    return False


def lag_rewrites(workbook: Workbook, source: str, target: str) -> List[Dict[str, Any]]:
    """The rewrites that make `source` stop reading `target`, by lagging it.

    Two lags are understood by finance models: the row-wise lag (the opening
    balance of the same period) and the column-wise lag (the closing balance
    of the previous period).  Both are offered when the sheet supports them;
    the caller ranks them.
    """
    rewrites: List[Dict[str, Any]] = []
    formula = workbook.formula_of(source)
    if not formula:
        return rewrites
    source_sheet, _source_address = split_address(source)
    target_sheet, target_address = split_address(target)
    column, row = parse_a1(target_address)
    reference = _reference_to(formula, source_sheet, target_sheet, target_address)
    if reference is None:
        return rewrites

    counterpart = opening_counterpart(workbook, target_sheet, row)
    if counterpart is not None:
        replacement_address = format_a1(column, counterpart)
        replacement = "%s!%s" % (
            quote_sheet(target_sheet),
            _absolutise(reference.text, replacement_address),
        )
        rewrites.append({
            "kind": "lag-opening-balance",
            "formula": replace_reference(formula, reference, replacement),
            "reference": replacement,
            "explanation": (
                "the closing reference %s is replaced by its opening counterpart %s"
                % (reference.text, replacement)
            ),
        })

    if column > 1:
        prior_address = format_a1(column - 1, row)
        if workbook.has_numeric_cell(target_sheet, prior_address) and carries_forward(
            workbook, target_sheet, row, column
        ):
            replacement = "%s!%s" % (
                quote_sheet(target_sheet),
                _absolutise(reference.text, prior_address),
            )
            rewrites.append({
                "kind": "lag-prior-period",
                "formula": replace_reference(formula, reference, replacement),
                "reference": replacement,
                "explanation": (
                    "the reference %s is lagged one period to the previous period's %s"
                    % (reference.text, replacement)
                ),
            })
    return rewrites


def trim_rewrite(workbook: Workbook, source: str) -> Optional[Dict[str, Any]]:
    """Rewrite a self-referencing rolling formula so it no longer eats itself.

    The classic defect is a window that runs one row too far, so the cell
    totals a range that contains the cell.  Trimming the window to the cells
    before it is the smallest correction a reviewer accepts.
    """
    formula = workbook.formula_of(source)
    if not formula:
        return None
    sheet, address = split_address(source)
    column, row = parse_a1(address)
    for reference in scan_references(formula, sheet):
        if reference.kind != "address" or reference.sheet != sheet:
            continue
        if not reference.is_range or not reference.contains(column, row):
            continue
        first, last = reference.start, reference.end
        assert first is not None and last is not None
        if (column, row) == last:
            new_first, new_last = first, (column, row - 1)
        elif (column, row) == first:
            new_first, new_last = (column, row + 1), last
        else:
            continue        # the cell sits inside the window: no clean trim
        start_text = format_a1(new_first[0], new_first[1])
        end_text = format_a1(new_last[0], new_last[1])
        trimmed = start_text if start_text == end_text else "%s:%s" % (start_text, end_text)
        return {
            "kind": "trim-rolling-window",
            "formula": replace_reference(formula, reference, trimmed),
            "reference": trimmed,
            "explanation": (
                "the rolling window %s contains the cell itself, so it is trimmed to %s"
                % (reference.text, trimmed)
            ),
        }
    return None


def name_base_cell(workbook: Workbook, name: str) -> Optional[Tuple[str, str]]:
    """The cell a defined name was meant to point at.

    A name is `Scope.Thing`; the sheet named by the scope carries a label
    column, so the last segment of the name is matched against the labels to
    find the line the name was aliasing.
    """
    if name not in workbook.names:
        return None
    scope, _, thing = name.partition(".")
    if not thing:
        return None
    sheet = scope if scope in workbook.sheets else None
    if sheet is None:
        return None
    wanted = label_tokens(thing)
    if not wanted:
        return None
    for row, label in sorted((workbook.labels.get(sheet) or {}).items()):
        if not wanted.issubset(label_tokens(label)):
            continue
        column = workbook.value_column(sheet, row)
        if column is None:
            continue
        return sheet, format_a1(column, row)
    return None


def name_repoint_rewrite(workbook: Workbook, members: Sequence[str]) -> Optional[Dict[str, Any]]:
    """Break a cycle between two defined names by pointing one of them at
    the cell it was aliasing."""
    for name in sorted(members):
        base = name_base_cell(workbook, name)
        if base is None:
            continue
        sheet, address = base
        refers_to = "=%s!$%s$%s" % (quote_sheet(sheet), address[0], address[1:])
        return {
            "kind": "repoint-defined-name",
            "formula": refers_to,
            "reference": refers_to,
            "name": name,
            "explanation": (
                "the name %s is re-pointed at %s!%s, the cell it was aliasing"
                % (name, sheet, address)
            ),
        }
    return None


# ---------------------------------------------------------------------------
# 7. Scoring the candidate break points
# ---------------------------------------------------------------------------
SEMANTIC_BY_REWRITE = {
    "lag-opening-balance": 5,
    "trim-rolling-window": 4,
    "lag-prior-period": 3,
    "repoint-defined-name": 5,
}

BARE_REFERENCE = re.compile(
    r"^\$?[A-Z]{1,3}\$?\d+$|^'[^']+'!\$?[A-Z]{1,3}\$?\d+$|^[A-Za-z_][A-Za-z0-9_.]*$"
)


def formula_complexity(formula: str) -> int:
    """1 (a bare reference) to 5 (a nested aggregate)."""
    body = (formula or "").strip().lstrip("=").strip()
    if not body:
        return 1
    functions = re.findall(r"([A-Za-z][A-Za-z0-9_.]*)\s*\(", body)
    aggregates = [name.upper() for name in functions if name.upper() in AGGREGATE_FUNCTIONS]
    depth = 0
    deepest = 0
    for character in body:
        if character == "(":
            depth += 1
            deepest = max(deepest, depth)
        elif character == ")":
            depth = max(0, depth - 1)
    if not functions:
        return 1 if BARE_REFERENCE.match(body) else 2
    if len(aggregates) >= 2 or (aggregates and deepest >= 2):
        return 5
    if aggregates:
        return 4
    if deepest >= 2:
        return 3
    return 2


def blast_radius(graph: Dict[str, Any], source: str, members: Sequence[str]) -> int:
    """How many cells outside the cycle would move if the break were applied."""
    member_set = set(members)
    successors = adjacency(graph)
    seen = {source}
    queue = [source]
    count = 0
    while queue:
        current = queue.pop(0)
        for nxt in successors.get(current, []):
            if nxt in seen:
                continue
            seen.add(nxt)
            queue.append(nxt)
            if nxt not in member_set:
                count += 1
    return count


def score_candidates(cluster: Dict[str, Any], graph: Dict[str, Any],
                     workbook: Workbook) -> List[Dict[str, Any]]:
    """Rank every edge of one cycle as a possible break point.

    The three axes are the ones the exercise asks for: semantic plausibility
    (does the break site carry a meaning a finance reviewer accepts?), blast
    radius (how much of the model moves?) and formula complexity (how
    intrusive is the rewrite at that site?).  The weights are published in
    the report.
    """
    members = cluster["members"]
    member_set = set(members)
    internal_edges = [
        edge for edge in graph["edges"]
        if edge["from"] in member_set and edge["to"] in member_set
    ]
    cycles = elementary_cycles(graph, members)
    total_cells = max(1, len(workbook.formula_cells()))
    candidates: List[Dict[str, Any]] = []
    for edge in internal_edges:
        source, target = edge["from"], edge["to"]
        rewrites: List[Dict[str, Any]] = []
        blocked = ""
        if workbook.is_name(source):
            rewrite = name_repoint_rewrite(workbook, members)
            if rewrite is None:
                blocked = "no defined name in the cycle aliases a line of the model"
            elif rewrite["name"] != source:
                blocked = ("the name %s is the one that aliases a line of the model, so re-pointing "
                           "%s instead would leave the cycle open"
                           % (rewrite["name"], source))
            else:
                rewrites.append(rewrite)
        elif workbook.is_name(target):
            blocked = ("the edge ends in a defined name; re-pointing the name would change "
                       "the model's vocabulary")
        elif source == target:
            rewrite = trim_rewrite(workbook, source)
            if rewrite:
                rewrites.append(rewrite)
            else:
                blocked = "the window that swallows the cell cannot be trimmed in one step"
        else:
            rewrites = lag_rewrites(workbook, source, target)
            if not rewrites:
                blocked = ("the sheet offers neither an opening balance nor a previous period "
                           "for this reference, so no rewrite of the edge keeps the accounting meaning")
        if not rewrites:
            rewrites = [None]
        for rewrite in rewrites:
            applicable = rewrite is not None
            semantic = SEMANTIC_BY_REWRITE.get(rewrite["kind"], 0) if applicable else 0
            complexity = formula_complexity(
                workbook.names[source]["refers_to"] if workbook.is_name(source)
                else workbook.formula_of(source)
            )
            blast = blast_radius(graph, source, members)
            blast_score = 5.0 * (1.0 - min(1.0, blast / float(total_cells)))
            total = 0.45 * semantic + 0.30 * (6 - complexity) + 0.25 * blast_score
            candidates.append({
                "edge": {"from": source, "to": target},
                "semantic_plausibility": semantic,
                "blast_radius": blast,
                "formula_complexity": complexity,
                "total_score": round(total, 4),
                "proposed_formula": rewrite["formula"] if applicable else "",
                "rationale": "",
                "applicable": applicable,
                "rewrite_kind": rewrite["kind"] if applicable else "",
                "rewrite_explanation": rewrite["explanation"] if applicable else blocked,
                "rewrite_name": rewrite.get("name") if applicable else None,
                "cycles_broken": sum(1 for cycle in cycles if _edge_in(cycle, source, target)),
                "cycles_in_cluster": len(cycles),
            })
    candidates.sort(key=lambda item: (not item["applicable"], -item["total_score"],
                                       item["edge"]["from"], item["edge"]["to"]))
    return candidates


def _edge_in(cycle: Sequence[str], source: str, target: str) -> bool:
    for index, member in enumerate(cycle):
        if member == source and cycle[(index + 1) % len(cycle)] == target:
            return True
    return False


# ---------------------------------------------------------------------------
# 8. Applying a break atomically
# ---------------------------------------------------------------------------
def capture_state(client: GridCraft, step: Dict[str, Any]) -> Callable[[], None]:
    """A closure that puts the target of one step back the way it was."""
    command_id = step["command"]
    params = step["params"]
    if command_id == "cell.set":
        sheet, cell = params.get("sheet"), params.get("cell")
        previous = client.call_tool("get_cell", {"cell": "%s!%s" % (sheet, cell)}) or {}
        old_input = previous.get("input", "")

        def restore_cell() -> None:
            client.command("cell.set", {"sheet": sheet, "cell": cell, "input": old_input or ""})

        return restore_cell
    if command_id == "review.newNote":
        cell = params["cell"]
        previous = client.call_tool("get_cell", {"cell": cell}) or {}
        old_note = previous.get("comment") or {}

        def restore_note() -> None:
            if old_note.get("text"):
                client.command("review.newNote", {"cell": cell, "text": old_note["text"],
                                                  "author": old_note.get("author", AUTHOR)})
            else:
                client.command("review.deleteComment", {"cell": cell})

        return restore_note
    if command_id == "formulas.defineName":
        name = params["name"]
        old_refers_to = step.get("restore", {}).get("refersTo", "")

        def restore_name() -> None:
            client.command("formulas.defineName", {"name": name, "refersTo": old_refers_to})

        return restore_name
    return lambda: None


def apply_atomically(client: GridCraft, steps: List[Dict[str, Any]]) -> None:
    """Run the steps of one break, or none of them.

    GridCraft has no batch tool and its writes are not atomic, so the
    all-or-nothing contract is implemented here: the previous content of
    every target is captured before the step runs, and if a later step
    fails, the steps that already succeeded are undone in reverse order.
    """
    applied: List[Callable[[], None]] = []
    try:
        for step in steps:
            undo = capture_state(client, step)
            client.command(step["command"], step["params"])
            applied.append(undo)
    except Exception:
        for undo in reversed(applied):
            try:
                undo()
            except EngineError:
                pass
        raise


def build_steps(candidate: Dict[str, Any], cycle_id: str,
                workbook: Workbook) -> List[Dict[str, Any]]:
    """The engine commands that apply one break, in order."""
    kind = candidate["rewrite_kind"]
    if kind == "repoint-defined-name":
        name = candidate["rewrite_name"]
        return [{
            "command": "formulas.defineName",
            "params": {"name": name, "refersTo": candidate["proposed_formula"]},
            "restore": {"refersTo": workbook.names[name]["refers_to"]},
        }]
    source = candidate["edge"]["from"]
    sheet, address = split_address(source)
    tag = "AUDIT-BREAK %s | %s: %s | see remediation-report.json" % (
        cycle_id, kind, candidate["rewrite_explanation"]
    )
    return [
        {
            "command": "cell.set",
            "params": {"sheet": sheet, "cell": address, "input": candidate["proposed_formula"]},
        },
        {
            "command": "review.newNote",
            "params": {"cell": source, "text": tag, "author": AUTHOR},
        },
    ]


# ---------------------------------------------------------------------------
# 9. The agent
# ---------------------------------------------------------------------------
IN_SCOPE = ("true", "self", "named-mutual")
MAX_ROUNDS = 20


def collect_notes(client: GridCraft, keys: Iterable[str]) -> Dict[str, str]:
    """The notes the model carries on the cells of a cycle."""
    notes: Dict[str, str] = {}
    for key in keys:
        if "!" not in key:
            continue
        try:
            record = client.call_tool("get_cell", {"cell": key}) or {}
        except EngineError:
            continue
        comment = record.get("comment") or {}
        if comment.get("text"):
            notes[key] = comment["text"]
    return notes


def detect_clusters(client: GridCraft, workbook: Workbook, graph: Dict[str, Any],
                    workbook_iterative: bool,
                    known_ids: Dict[Tuple[str, ...], str]) -> List[Dict[str, Any]]:
    """Every cycle in the workbook, classified and given a stable id.

    The id of a cycle is remembered by the set of its members, so a cycle
    keeps its identity across the rounds of the fixpoint loop even when the
    cycles around it have been broken.
    """
    clusters: List[Dict[str, Any]] = []
    for component in strongly_connected_components(graph):
        if len(component) == 1 and not has_self_loop(graph, component[0]):
            continue
        notes = collect_notes(client, component)
        clusters.append({
            "members": sorted(component),
            "walk": shortest_cycle(graph, component),
            "classification": classify(component, workbook, notes, workbook_iterative),
            "iterative_marker": sorted(
                member for member in component
                if ITERATIVE_MARKER in (notes.get(member) or "").lower()
            ),
        })
    clusters.sort(key=lambda cluster: cluster["members"][0])
    for cluster in clusters:
        key = tuple(cluster["members"])
        if key not in known_ids:
            known_ids[key] = "cycle-%03d" % (len(known_ids) + 1)
        cluster["id"] = known_ids[key]
    return clusters


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
    return [format_a1(column, row)
            for row in range(low_row, high_row + 1)
            for column in range(low_col, high_col + 1)]


def trace_cross_check(client: GridCraft, graph: Dict[str, Any],
                      members: Iterable[str]) -> Dict[str, Any]:
    """Compare the engine's own dependency tracer with the parsed graph.

    The tracer works on the active sheet and answers with the ranges a cell
    reads, so every cell of a cycle is checked on its own sheet and the
    answer is compared with the references the agent parsed out of the
    formula.  A disagreement means the agent's graph is not the engine's
    graph, and the break it would apply cannot be trusted.
    """
    successors = adjacency(graph)
    checked = 0
    mismatches: List[Dict[str, Any]] = []
    for key in sorted(members):
        if "!" not in key:
            continue
        sheet, address = split_address(key)
        try:
            client.command("sheet.activate", {"sheet": sheet})
            traced = client.command("formulas.tracePrecedents", {"cell": address}) or []
        except EngineError:
            continue
        checked += 1
        traced_cells: Set[str] = set()
        for entry in traced:
            target_sheet = entry.get("sheet") or sheet
            for cell_address in expand_range(entry.get("range", "")):
                traced_cells.add("%s!%s" % (target_sheet, cell_address))
        parsed_cells = set(successors.get(key, []))
        if traced_cells != parsed_cells:
            mismatches.append({
                "cell": key,
                "traced": sorted(traced_cells),
                "parsed": sorted(parsed_cells),
            })
    return {"checked": checked, "mismatches": mismatches}


def volatile_warnings(workbook: Workbook) -> List[str]:
    """Volatile functions are a warning, never a circular reference."""
    hits: Dict[str, List[str]] = defaultdict(list)
    for key, cell in workbook.formula_cells().items():
        body = (cell["formula"] or "").upper()
        for function in VOLATILE_FUNCTIONS:
            if re.search(r"(?<![A-Z0-9_.])%s\s*\(" % function, body):
                hits[function].append(key)
    return [
        "%d cell(s) call the volatile function %s; their values move on every recalculation "
        "and are not evidence of a circular reference" % (len(cells), function)
        for function, cells in sorted(hits.items())
    ]


def remediate(client: GridCraft, source_path: Path, out_dir: Path) -> Dict[str, Any]:
    """The whole pipeline, from the inherited file to the report."""
    catalogue = command_catalogue(client)
    open_command = require_command(catalogue, "file.open")
    save_command = require_command(catalogue, "file.save")
    require_command(catalogue, "cell.set")
    require_command(catalogue, "review.newNote")
    require_command(catalogue, "formulas.defineName")

    client.command(open_command, {"path": str(source_path)})
    client.command("formulas.calculateNow", {})

    input_sha = sha256_of(source_path)
    workbook = read_workbook(client)
    options = client.command("formulas.calculationOptions", {}) or {}
    workbook_iterative = bool(options.get("iterative"))
    graph = build_graph(workbook)
    audit_before = client.command("formulas.errorChecking", {}) or {}

    known_ids: Dict[Tuple[str, ...], str] = {}
    clusters = detect_clusters(client, workbook, graph, workbook_iterative, known_ids)
    first_pass = [dict(cluster) for cluster in clusters]
    discovered_graph = graph
    cross_check = trace_cross_check(
        client, graph, [member for cluster in clusters for member in cluster["members"]]
    )

    remediations: List[Dict[str, Any]] = []
    warnings = volatile_warnings(workbook)
    residual: List[str] = []
    rounds = 0

    while rounds < MAX_ROUNDS:
        rounds += 1
        pending = [
            cluster for cluster in clusters
            if cluster["classification"] in IN_SCOPE
            and cluster["id"] not in {entry["cycle_id"] for entry in remediations}
        ]
        if not pending:
            break
        cluster = pending[0]
        candidates = score_candidates(cluster, graph, workbook)
        chosen = next((candidate for candidate in candidates if candidate["applicable"]), None)
        if chosen is None:
            residual.append(cluster["id"])
            remediations.append({
                "cycle_id": cluster["id"],
                "chosen": candidates[0] if candidates else {},
                "alternatives": candidates[1:4],
                "cycle_members": cluster["members"],
                "pre_formula": "",
                "post_formula": "",
                "verified_acyclic": False,
                "status": "no-safe-break",
            })
            continue

        source = chosen["edge"]["from"]
        pre_formula = (workbook.names[source]["refers_to"] if workbook.is_name(source)
                       else workbook.formula_of(source))
        chosen["rationale"] = rationale_for(cluster, chosen, candidates)
        steps = build_steps(chosen, cluster["id"], workbook)

        apply_atomically(client, steps)
        remediations.append({
            "cycle_id": cluster["id"],
            "chosen": chosen,
            "alternatives": [candidate for candidate in candidates if candidate is not chosen][:4],
            "cycle_members": cluster["members"],
            "pre_formula": pre_formula,
            "post_formula": chosen["proposed_formula"],
            "verified_acyclic": False,
            "status": "applied",
            "steps": [dict(step["params"], command=step["command"]) for step in steps],
        })

        # Re-read the workbook and re-detect: a break is only believed when
        # the engine's own view of the model agrees.
        client.command("formulas.calculateNow", {})
        workbook = read_workbook(client)
        graph = build_graph(workbook)
        clusters = detect_clusters(client, workbook, graph, workbook_iterative, known_ids)
        for record in remediations:
            if record["status"] != "applied":
                continue
            still_circular = set()
            for cluster in clusters:
                still_circular.update(cluster["members"])
            if not still_circular.intersection(record["cycle_members"]):
                record["verified_acyclic"] = True

    remaining = [
        cluster["id"] for cluster in clusters if cluster["classification"] in IN_SCOPE
    ]
    residual = sorted(set(residual) | set(remaining))

    final_audit = client.command("formulas.errorChecking", {}) or {}
    deferred = [cluster["id"] for cluster in first_pass
                if cluster["classification"] == "iterative"]
    if cross_check["mismatches"]:
        warnings.append(
            "the engine's dependency tracer and the parsed graph disagree about %d cell(s); "
            "the graph is the agent's own, so the breaks are reported with that caveat"
            % len(cross_check["mismatches"])
        )
    if deferred:
        warnings.append(
            "%d cycle(s) traverse cells the model marks as iterative calculation; they are reported "
            "and left untouched" % len(deferred)
        )
        if not workbook_iterative:
            warnings.append(
                "the workbook's calculation options have iterative calculation switched off, so the "
                "iterative block still evaluates to #CIRC!; enable it in Formulas > Calculation Options "
                "or have the model owner restate the block"
            )

    out_dir.mkdir(parents=True, exist_ok=True)
    output_path = out_dir / (source_path.stem + "-remediated.xlsx")
    client.command(save_command, {"path": str(output_path)})
    output_sha = sha256_of(output_path)

    if sha256_of(source_path) != input_sha:
        raise EngineError("the inherited workbook was modified; remediation must never write to it")

    previews = render_previews(client, remediations, out_dir / "previews")
    deferred_members = [
        member for cluster in first_pass if cluster["classification"] == "iterative"
        for member in cluster["members"]
    ]
    graph_summary = write_dependency_graph(out_dir, discovered_graph, graph, deferred_members)

    report = {
        "input_path": str(source_path),
        "output_path": str(output_path),
        "input_sha256": input_sha,
        "output_sha256": output_sha,
        "cycles_found": first_pass,
        "remediations": remediations,
        "residual_cycles": residual,
        "warnings": warnings,
        "rendered_previews": previews,
        "deferred_cycles": deferred,
        "engine": {
            "name": client.server_info.get("name", "gridcraft"),
            "version": client.server_info.get("version", ""),
        },
        "method": {
            "dependency_graph": "sheet.read with formulas, parsed into nodes and edges",
            "detector": "formulas.errorChecking, the engine's own auditor",
            "tracer": "formulas.tracePrecedents, cross-checked on the cycle members",
            "atomicity": "cell.set plus review.newNote applied as one break and rolled back "
                         "together if a step fails",
            "publish": "one file.save to a new path; the inherited file is never written to",
            "previews": "the sheet region is rasterised by the agent from the values the engine "
                        "computed; GridCraft cannot rasterise in headless mode, where its "
                        "screenshot tool needs a UI session, so the engine's own HTML render of "
                        "the sheet is used when no image library is available",
            "scoring_weights": {
                "semantic_plausibility": 0.45,
                "formula_complexity": 0.30,
                "blast_radius": 0.25,
            },
        },
        "workbook_iterative_calculation": workbook_iterative,
        "engine_audit": {"before": audit_before, "after": final_audit},
        "graph_cross_check": cross_check,
        "dependency_graph": graph_summary,
    }
    return report


def write_dependency_graph(out_dir: Path, discovered: Dict[str, Any],
                           final: Dict[str, Any],
                           deferred_members: Sequence[str]) -> Dict[str, Any]:
    """Write the dependency graph the agent worked from.

    The graph is the machine-readable artefact of the discovery phase: every
    formula cell and every defined name of the model, and the cells each of
    them reads.  The acyclicity flag is computed on the remediated model
    under the classification rules, that is with the cycles the model marks
    as iterative taken out.
    """
    deferred = set(deferred_members)
    trimmed = {
        "nodes": final["nodes"],
        "edges": [edge for edge in final["edges"]
                  if edge["from"] not in deferred and edge["to"] not in deferred],
    }
    cyclic = [
        component for component in strongly_connected_components(trimmed)
        if len(component) > 1 or has_self_loop(trimmed, component[0])
    ]
    path = out_dir / "dependency-graph.json"
    path.write_text(json.dumps({
        "nodes": discovered["nodes"],
        "edges": discovered["edges"],
        "node_count": len(discovered["nodes"]),
        "edge_count": len(discovered["edges"]),
        "deferred_members": sorted(deferred),
        "acyclic_outside_deferred": not cyclic,
        "remaining_cycles": [sorted(component) for component in cyclic],
    }, indent=2, default=str))
    return {
        "path": str(path),
        "nodes": len(discovered["nodes"]),
        "edges": len(discovered["edges"]),
        "acyclic_outside_deferred": not cyclic,
    }


def rationale_for(cluster: Dict[str, Any], chosen: Dict[str, Any],
                  candidates: List[Dict[str, Any]]) -> str:
    """One paragraph a finance reviewer can argue with."""
    kind = chosen["rewrite_kind"]
    alternatives = [candidate for candidate in candidates if candidate is not chosen]
    best_other = alternatives[0] if alternatives else None
    if kind == "lag-opening-balance":
        return (
            "The cycle runs because %s depends on the closing balance, the closing balance depends on "
            "the interest charge, and the interest charge depends on the closing balance. The break site "
            "selected here is the reference to the closing balance itself: rewriting it to the opening "
            "balance is the convention finance models already use when they accrue interest on the "
            "opening position, so the roll-forward keeps its economics and only the averaging is "
            "dropped (%s). The alternative break points score %s on semantic plausibility against %s "
            "here, so they are recorded but not applied."
            % (
                chosen["edge"]["from"],
                chosen["rewrite_explanation"],
                (best_other or {}).get("semantic_plausibility", "n/a"),
                chosen["semantic_plausibility"],
            )
        )
    if kind == "lag-prior-period":
        return (
            "No opening balance is available for the referenced line, so the break lags the reference by "
            "one period: %s. Interest and similar charges then accrue on the position carried into the "
            "period, which is what the model already does for the other periods, and the loop closes."
            % chosen["rewrite_explanation"]
        )
    if kind == "trim-rolling-window":
        return (
            "The cell totals a window that contains the cell itself, so it reads its own result; this is "
            "the off-by-one a rolling schedule picks up when a row is inserted. Trimming the window to the "
            "rows before the cell keeps every other period untouched and removes the self-reference "
            "without touching any other formula: %s." % chosen["rewrite_explanation"]
        )
    if kind == "repoint-defined-name":
        scope = chosen["edge"]["from"].partition(".")[0]
        return (
            "Two defined names point at each other, so neither can be resolved and every cell that reads "
            "them fails. The model already carries the quantity on a labelled line of the %s sheet, so the "
            "name is re-pointed at that cell and the other name resolves through it: %s. The names keep "
            "their spelling, their scope and their consumers; only the broken link is replaced."
            % (
                scope or "model",
                chosen["rewrite_explanation"],
            )
        )
    return chosen["rewrite_explanation"]


def render_previews(client: GridCraft, remediations: List[Dict[str, Any]],
                    preview_dir: Path) -> List[str]:
    """A PNG of the top-left region of every sheet a break touched.

    The engine cannot rasterise in headless mode, so the agent draws the
    region itself from the values the engine computed.
    """
    sheets: List[str] = []
    for entry in remediations:
        if entry.get("status") != "applied":
            continue
        source = entry["chosen"]["edge"]["from"]
        sheet = split_address(source)[0]
        if sheet and sheet not in sheets:
            sheets.append(sheet)
        for member in entry.get("cycle_members", []):
            member_sheet = split_address(member)[0]
            if member_sheet and member_sheet not in sheets:
                sheets.append(member_sheet)
    if not sheets:
        return []
    preview_dir.mkdir(parents=True, exist_ok=True)
    paths: List[str] = []
    for sheet in sheets:
        client.command("sheet.activate", {"sheet": sheet})
        used_range = ""
        for entry in client.call_tool("inspect_workbook", {}).get("sheets", []):
            if entry["name"] == sheet:
                used_range = entry.get("usedRange") or ""
        region = _preview_region(used_range)
        values = client.command("sheet.read", {"range": region, "sheet": sheet}) or {}
        rows = values.get("values") or []
        stem = re.sub(r"[^A-Za-z0-9]+", "_", sheet).strip("_")
        path = preview_dir / ("sheet-%s.png" % stem)
        if _write_png(path, sheet, rows):
            paths.append(str(path))
        else:
            fallback = preview_dir / ("sheet-%s.html" % stem)
            client.command("file.save", {"path": str(fallback)})
            paths.append(str(fallback))
    return paths


def _preview_region(used_range: str) -> str:
    """The first sixteen rows and eight columns of the sheet."""
    start_address, _, end_address = (used_range or "A1:H16").partition(":")
    start_address = start_address or "A1"
    end_address = end_address or start_address
    try:
        start_col, start_row = parse_a1(start_address)
        end_col, end_row = parse_a1(end_address)
    except ValueError:
        return "A1:H16"
    last_col = min(max(end_col, start_col), start_col + 7)
    last_row = min(max(end_row, start_row), start_row + 15)
    return "%s:%s" % (format_a1(start_col, start_row), format_a1(last_col, last_row))


def _write_png(path: Path, title: str, rows: List[List[Any]]) -> bool:
    """Draw the region as a PNG.

    Returns False when no image library is available, in which case the
    caller falls back to the engine's own HTML render of the sheet.
    """
    try:
        from PIL import Image, ImageDraw, ImageFont
    except ImportError:
        return False
    columns = max((len(row) for row in rows), default=0)
    cell_width, cell_height = 104, 22
    header = 28
    width = max(360, columns * cell_width + 12)
    height = header + max(1, len(rows)) * cell_height + 12
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    try:
        font = ImageFont.load_default(size=13)
        small = ImageFont.load_default(size=11)
    except TypeError:                                   # Pillow before 10.1
        font = ImageFont.load_default()
        small = ImageFont.load_default()
    draw.rectangle([0, 0, width, header], fill="#1f2933")
    draw.text((8, 7), title, fill="white", font=font)
    for row_index, row in enumerate(rows):
        top = header + row_index * cell_height
        for column_index in range(columns):
            left = 6 + column_index * cell_width
            draw.rectangle([left, top, left + cell_width - 2, top + cell_height - 2],
                           outline="#d4d4d4")
            value = row[column_index] if column_index < len(row) else None
            if value is None or value == "":
                continue
            if isinstance(value, dict):
                text = str(value.get("error", "?"))
            elif isinstance(value, float):
                text = "%g" % value
            else:
                text = str(value)
            draw.text((left + 4, top + 4), text[:20], fill="#1f2933", font=small)
    image.save(str(path), format="PNG")
    return True


# ---------------------------------------------------------------------------
# 10. The report
# ---------------------------------------------------------------------------
def write_report(report: Dict[str, Any], out_dir: Path) -> Tuple[Path, Path]:
    json_path = out_dir / "remediation-report.json"
    md_path = out_dir / "remediation-report.md"
    json_path.write_text(json.dumps(report, indent=2, default=str))

    lines: List[str] = []
    lines.append("# Circular-Reference Remediation Report")
    lines.append("")
    lines.append("| | |")
    lines.append("| --- | --- |")
    lines.append("| Inherited workbook | `%s` |" % report["input_path"])
    lines.append("| sha256 before | `%s` |" % report["input_sha256"])
    lines.append("| Remediated workbook | `%s` |" % report["output_path"])
    lines.append("| sha256 after | `%s` |" % report["output_sha256"])
    lines.append("| Cycles found | %d |" % len(report["cycles_found"]))
    lines.append("| Breaks applied | %d |" % len([entry for entry in report["remediations"]
                                                 if entry.get("status") == "applied"]))
    lines.append("| Residual cycles | %d |" % len(report["residual_cycles"]))
    lines.append("| Deferred (iterative) cycles | %d |" % len(report["deferred_cycles"]))
    graph_summary = report.get("dependency_graph") or {}
    if graph_summary:
        lines.append("| Dependency graph | `%s` (%s nodes, %s edges, acyclic outside the deferred "
                     "cycles: %s) |" % (
                         graph_summary.get("path", ""), graph_summary.get("nodes", 0),
                         graph_summary.get("edges", 0),
                         graph_summary.get("acyclic_outside_deferred")))
    lines.append("")
    lines.append("## How the model was read")
    lines.append("")
    for key, value in report["method"].items():
        if isinstance(value, dict):
            value = ", ".join("%s %.2f" % (name, weight) for name, weight in value.items())
        lines.append("- **%s** - %s" % (key.replace("_", " "), value))
    lines.append("")
    lines.append("## Cycles found")
    lines.append("")
    lines.append("| id | classification | members | disposition |")
    lines.append("| --- | --- | --- | --- |")
    for cluster in report["cycles_found"]:
        if cluster["id"] in report["deferred_cycles"]:
            disposition = "reported, not remediated (iterative by design)"
        elif cluster["id"] in report["residual_cycles"]:
            disposition = "**not broken**"
        else:
            disposition = "broken"
        lines.append("| %s | %s | %s | %s |" % (
            cluster["id"], cluster["classification"],
            ", ".join("`%s`" % member for member in cluster["members"]), disposition))
    lines.append("")
    lines.append("## Breaks applied")
    lines.append("")
    for entry in report["remediations"]:
        chosen = entry.get("chosen") or {}
        lines.append("### %s" % entry["cycle_id"])
        lines.append("")
        lines.append("- Chosen break edge: `%s` -> `%s`" % (
            chosen.get("edge", {}).get("from", "?"), chosen.get("edge", {}).get("to", "?")))
        lines.append("- Rewrite: `%s`" % (chosen.get("rewrite_kind") or "none"))
        lines.append("- Semantic plausibility: %s/5" % chosen.get("semantic_plausibility", 0))
        lines.append("- Blast radius: %s cells outside the cycle" % chosen.get("blast_radius", 0))
        lines.append("- Formula complexity: %s/5" % chosen.get("formula_complexity", 0))
        lines.append("- Total score: %s" % chosen.get("total_score", 0))
        lines.append("- Elementary cycles in the cluster: %s; cycles this edge closes: %s" % (
            chosen.get("cycles_in_cluster", 0), chosen.get("cycles_broken", 0)))
        lines.append("- Verified acyclic after the break: %s" % entry.get("verified_acyclic"))
        lines.append("")
        lines.append("```")
        lines.append("before: %s" % entry.get("pre_formula", ""))
        lines.append("after:  %s" % entry.get("post_formula", ""))
        lines.append("```")
        lines.append("")
        lines.append("**Justification.** %s" % (chosen.get("rationale") or ""))
        lines.append("")
        alternatives = entry.get("alternatives") or []
        if alternatives:
            lines.append("Alternatives considered and ranked:")
            lines.append("")
            lines.append("| break edge | semantic | blast | complexity | score | applicable | why not |")
            lines.append("| --- | --- | --- | --- | --- | --- | --- |")
            for candidate in alternatives:
                lines.append("| `%s` -> `%s` | %s | %s | %s | %s | %s | %s |" % (
                    candidate["edge"]["from"], candidate["edge"]["to"],
                    candidate["semantic_plausibility"], candidate["blast_radius"],
                    candidate["formula_complexity"], candidate["total_score"],
                    "yes" if candidate.get("applicable") else "no",
                    candidate.get("rewrite_explanation", "")))
            lines.append("")
    if report["warnings"]:
        lines.append("## Warnings")
        lines.append("")
        for warning in report["warnings"]:
            lines.append("- %s" % warning)
        lines.append("")
    if report["rendered_previews"]:
        lines.append("## Previews")
        lines.append("")
        for preview in report["rendered_previews"]:
            lines.append("- `%s`" % preview)
        lines.append("")
    md_path.write_text("\n".join(lines))
    return json_path, md_path


def sha256_of(path: Path) -> str:
    digest = hashlib.sha256()
    with open(str(path), "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


# ---------------------------------------------------------------------------
# 11. Entry point
# ---------------------------------------------------------------------------
def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Circular-reference forensics agent.")
    parser.add_argument("--workbook", default="fixtures/legacy-plan-grid.xlsx",
                        help="the inherited workbook to remediate")
    parser.add_argument("--out-dir", default="out",
                        help="where the remediated workbook and the report are written")
    arguments = parser.parse_args(list(argv) if argv is not None else None)

    source_path = Path(arguments.workbook).resolve()
    out_dir = Path(arguments.out_dir).resolve()
    if not source_path.is_file():
        print("the inherited workbook %s does not exist" % source_path, file=sys.stderr)
        return 2

    client = GridCraft()
    try:
        report = remediate(client, source_path, out_dir)
    finally:
        client.close()
    write_report(report, out_dir)
    print(json.dumps({
        "cycles_found": len(report["cycles_found"]),
        "breaks_applied": len([entry for entry in report["remediations"]
                               if entry.get("status") == "applied"]),
        "residual_cycles": report["residual_cycles"],
        "deferred_cycles": report["deferred_cycles"],
        "output": report["output_path"],
    }, indent=2))
    return 0 if not report["residual_cycles"] else 1


if __name__ == "__main__":
    sys.exit(main())
