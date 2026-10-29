#!/usr/bin/env python3
"""
helios_scenario.py -- Helios Systems' five-year operating model, driven by a
single scenario toggle with cascading assumption cells.

The model replaces the five parallel scenario sheets the FP&A team used to
maintain.  One sheet holds the raw assumption columns (Bear/Base/Bull/Doom), a
second sheet holds ad-hoc controller overrides, and four calculation sheets
read *only* the resolved `Effective.*` names -- never a raw scenario column.
A switch cell (`Scenario.Active`, a defined name) selects the scenario, so a
toggle never requires a formula edit.

The script builds the model and then puts it through its paces:

  1. it builds the workbook over GridCraft's MCP stdio transport;
  2. it derives the dependency map from the engine's own state, cross-checks it
     against the engine's Formula Auditing commands, and refuses to continue if
     the graph is not a DAG;
  3. it proves the toggle is idempotent (same index twice -> bit-identical
     outputs and a byte-identical workbook);
  4. it exposes the workbook over a loopback JSON control channel and runs a
     two-process race: a scheduler toggles the scenario every 50 ms while a
     reader hammers a named output, proving that a reader never observes a
     half-updated tree;
  5. it proves the model fails closed: an illegal scenario index is rejected
     with a structured error, the previous scenario stays in effect, and no
     write is persisted.

Run it with `--out-dir` to choose where the artefacts land.  The file is also
the scheduler and the reader: `--role scheduler` / `--role reader` re-enter it
as separate processes that speak the control protocol.
"""
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import re
import secrets
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

# --------------------------------------------------------------------------
# The model
# --------------------------------------------------------------------------

ENGINE = "gridcraft-cli"

#: The four legal scenarios, in index order.  Anything else is illegal.
SCENARIOS: Tuple[Tuple[str, int], ...] = (
    ("Bear", 1),
    ("Base", 2),
    ("Bull", 3),
    ("Doom", 4),
)
SCENARIO_BY_INDEX: Dict[int, str] = {index: name for name, index in SCENARIOS}

#: The assumption table: one key per driver cell, one value per scenario.
#: The figures are model index points (last year = 100), which keeps the
#: scenario columns comparable without dragging units into the formulas.
DEFAULT_TABLE: Dict[str, Any] = {
    "assumptions": {
        "headcount.sales.q1": {"Bear": 78.0, "Base": 100.0, "Bull": 121.0, "Doom": 63.0},
        "arr": {"Bear": 88.0, "Base": 100.0, "Bull": 118.0, "Doom": 71.0},
        "churn": {"Bear": 0.12, "Base": 0.08, "Bull": 0.05, "Doom": 0.18},
        "gm": {"Bear": 0.58, "Base": 0.64, "Bull": 0.70, "Doom": 0.50},
        "cac": {"Bear": 112.0, "Base": 100.0, "Bull": 91.0, "Doom": 134.0},
        "price.eur": {"Bear": 94.0, "Base": 100.0, "Bull": 107.0, "Doom": 88.0},
    },
    # The controller's standing sensitivity tweak: it must win over the
    # scenario column without anyone editing a formula.
    "overrides": {"gm": 0.66},
}

#: The sheets, in the order the model reads them.
SHEETS: Tuple[str, ...] = (
    "Assumptions",
    "Overrides",
    "Revenue",
    "Cost",
    "EBITDA",
    "BalanceSheet",
)

#: The top line of each calculation sheet.
OUTPUT_NAMES: Tuple[str, ...] = (
    "Revenue.TopLine",
    "Cost.TopLine",
    "EBITDA.TopLine",
    "BalanceSheet.TopLine",
)

#: The named output the race harness watches.
WATCHED_OUTPUT = "Effective.arr"

#: Every command the model uses.  The ids are checked against the engine's
#: own catalogue before the first write, so a build that renames a command
#: fails loudly instead of half way through the model.
REQUIRED_COMMANDS: Tuple[str, ...] = (
    "cell.set",
    "range.setValues",
    "home.insertSheet",
    "sheet.rename",
    "sheet.activate",
    "formulas.defineName",
    "formulas.nameManager",
    "formulas.calculateNow",
    "formulas.errorChecking",
    "formulas.tracePrecedents",
    "formulas.traceDependents",
    "formulas.evaluateFormula",
    "data.scenarioAdd",
    "data.scenarioShow",
    "data.scenarioManager",
    "file.save",
)

# --------------------------------------------------------------------------
# The control channel's wire protocol
# --------------------------------------------------------------------------

AUTH_METHOD = "auth"
TOGGLE_METHOD = "scenario.set"
EXECUTE_METHOD = "engine.execute"
READ_COMMAND = "output.read"

#: The frames the control channel accepts, echoed into the report so that the
#: published contract and the running server can be compared.
CONTROL_PROTOCOL: Dict[str, Any] = {
    "auth_frame": {"id": "auth", "method": AUTH_METHOD, "params": {"token": "<64 hex chars>"}},
    "frames": [
        {"id": 1, "method": TOGGLE_METHOD, "params": {"index": 1}},
        {
            "id": 2,
            "method": EXECUTE_METHOD,
            "params": {"command": READ_COMMAND, "params": {"name": WATCHED_OUTPUT}},
        },
    ],
    "encoding": "utf-8, one JSON object per line, newline delimited",
}


# --------------------------------------------------------------------------
# Errors
# --------------------------------------------------------------------------
class EngineError(RuntimeError):
    """The engine refused a call; the message is the engine's own text."""


class ModelCycleError(RuntimeError):
    """The model graph is not acyclic.  Carries the cycle for the report."""

    def __init__(self, cycle: Sequence[str], reported_by: str):
        self.cycle: List[str] = list(cycle)
        self.reported_by = reported_by
        super().__init__(
            json.dumps(
                {"error": "dependency_cycle", "cycle": self.cycle, "reported_by": reported_by},
                sort_keys=True,
            )
        )


class ControlChannelError(RuntimeError):
    """A structured error that the control channel reports to its client."""

    def __init__(self, payload: Dict[str, Any]):
        self.payload = payload
        super().__init__(payload.get("message", "control channel error"))


# --------------------------------------------------------------------------
# The MCP stdio client
# --------------------------------------------------------------------------
class MCPClient:
    """A small, honest JSON-RPC client for GridCraft's MCP stdio transport.

    The handshake is the MCP `initialize` request; every later frame is a
    `tools/call`.  A tool that fails answers with `isError: true` and a plain
    sentence -- the flag is checked before the payload is parsed -- and the
    payload itself arrives in the first `text` content block.
    """

    def __init__(self, argv: Sequence[str], log_path: Optional[Path] = None):
        stderr = subprocess.DEVNULL
        self._log = open(log_path, "wb") if log_path is not None else None
        if self._log is not None:
            stderr = self._log
        self._process = subprocess.Popen(
            list(argv),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr,
            bufsize=0,
        )
        self._next_id = 0
        self._lock = threading.Lock()

    # -- the wire ---------------------------------------------------------
    def _request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        with self._lock:
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
        result = self._request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "helios-scenario", "version": "1.0"},
            },
        )
        return result.get("serverInfo", {})

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
        if self._log is not None:
            self._log.close()
            self._log = None


# --------------------------------------------------------------------------
# Command discovery
# --------------------------------------------------------------------------
def verify_command_catalogue(engine: MCPClient) -> Dict[str, Any]:
    """Check the engine's command catalogue before the model is built.

    The audit commands the dependency map is built from are discovered here
    rather than assumed: `list_commands` with the search term "audit" returns
    the Formula Auditing group, and every command id the model uses is
    checked against the full catalogue.
    """
    catalogue = engine.tool("list_commands", {})
    known = {entry["id"] for entry in catalogue}
    missing = [command for command in REQUIRED_COMMANDS if command not in known]
    if missing:
        raise EngineError("the engine does not implement: %s" % ", ".join(sorted(missing)))
    audit = engine.tool("list_commands", {"search": "audit"})
    audit_ids = [entry["id"] for entry in audit]
    for command in ("formulas.errorChecking", "formulas.tracePrecedents"):
        if command not in audit_ids:
            raise EngineError("the engine does not expose the audit command %s" % command)
    return {
        "total_commands": len(known),
        "audit_commands": audit_ids,
        "verified_commands": list(REQUIRED_COMMANDS),
    }


# --------------------------------------------------------------------------
# Formula parsing (the dependency map is derived from the engine's formulas)
# --------------------------------------------------------------------------
_STRING_RE = re.compile(r'"[^"]*"')
_FUNCTION_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_.]*\s*\(")
_CELL_RE = re.compile(
    r"(?:(?:'[^']+'|[A-Za-z_][A-Za-z0-9_]*)!)?"
    r"\$?[A-Z]{1,3}\$?[0-9]+(?::\$?[A-Z]{1,3}\$?[0-9]+)?"
)
_NAME_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_.]*")
_LITERALS = {"TRUE", "FALSE"}


def normalise_cell(token: str, home_sheet: str) -> str:
    """`$B$4` / `Revenue!$B$4` -> `Revenue!B4`."""
    if "!" in token:
        sheet, cell = token.split("!", 1)
        sheet = sheet.strip("'")
    else:
        sheet, cell = home_sheet, token
    return "%s!%s" % (sheet, cell.replace("$", "").upper())


def parse_references(formula: str, home_sheet: str) -> List[str]:
    """The references a formula reads: cell addresses and defined names.

    GridCraft's own tracer resolves cell references but not defined names, so
    the map is built from the engine's formula text and then cross-checked
    against the tracer (see `cross_check_traces`).
    """
    text = _STRING_RE.sub('""', formula.lstrip("="))
    functions = {match.group(0)[:-1].strip().upper() for match in _FUNCTION_RE.finditer(text)}

    cells: List[str] = []
    for match in _CELL_RE.finditer(text):
        start = match.start()
        if start and (text[start - 1].isalnum() or text[start - 1] in "._$"):
            continue  # the tail of a dotted name, not a cell address
        cells.append(normalise_cell(match.group(0), home_sheet))

    remainder = _CELL_RE.sub(" ", text)
    names: List[str] = []
    for match in _NAME_RE.finditer(remainder):
        token = match.group(0)
        if token.upper() in functions or token.upper() in _LITERALS:
            continue
        if match.start() and remainder[match.start() - 1] in "._":
            continue
        names.append(token)

    ordered: List[str] = []
    for token in cells + names:
        if token not in ordered:
            ordered.append(token)
    return ordered


def split_refers_to(refers_to: str) -> Tuple[str, str]:
    """`=Assumptions!$B$1` -> `("Assumptions", "B1")`."""
    body = refers_to.lstrip("=")
    if "!" in body:
        sheet, cell = body.split("!", 1)
    else:
        sheet, cell = "", body
    return sheet.strip("'"), cell.replace("$", "").upper()


# --------------------------------------------------------------------------
# The workbook
# --------------------------------------------------------------------------
class HeliosModel:
    """The Helios operating model, built and read through GridCraft."""

    def __init__(self, engine: MCPClient, table: Dict[str, Any]):
        self.engine = engine
        self.assumptions: Dict[str, Dict[str, float]] = table["assumptions"]
        self.overrides: Dict[str, float] = table.get("overrides", {})
        self.assumption_rows: Dict[str, int] = {}
        self.override_rows: Dict[str, int] = {}
        self.name_cells: Dict[str, str] = {}

    # -- building ---------------------------------------------------------
    def build(self) -> None:
        engine = self.engine
        engine.tool("new_workbook", {})

        # The sheets, in the order the model reads them.
        engine.command("sheet.rename", {"sheet": "Sheet1", "name": SHEETS[0]})
        for index, name in enumerate(SHEETS[1:], start=1):
            engine.command("home.insertSheet", {"name": name, "before": index})

        self._build_assumptions()
        self._build_overrides()
        self._build_calculation_sheets()
        self._build_scenarios()
        engine.command("formulas.calculateNow", {})

    def _build_assumptions(self) -> None:
        """The switch cell, the raw scenario columns and the switch formulas."""
        engine = self.engine
        engine.command(
            "range.setValues",
            {"range": "Assumptions!A1:B1", "values": [["Scenario.Active", 2]]},
        )
        engine.command(
            "formulas.defineName",
            {"name": "Scenario.Active", "refersTo": "=Assumptions!$B$1"},
        )
        engine.command(
            "range.setValues",
            {"range": "Assumptions!A2:E2", "values": [["Scenario index"] + [index for _, index in SCENARIOS]]},
        )

        header = ["assumption"] + [name for name, _ in SCENARIOS]
        rows: List[List[Any]] = [header]
        for key, values in self.assumptions.items():
            row = 4 + len(self.assumption_rows)
            self.assumption_rows[key] = row
            rows.append([key] + [values[name] for name, _ in SCENARIOS])
        last = 3 + len(self.assumption_rows)
        engine.command("range.setValues", {"range": "Assumptions!A3:E%d" % last, "values": rows})

        # The switch formulas read the index and pick the scenario's column.
        # They are written after the names exist, otherwise the engine would
        # answer #NAME? and cache it.
        engine.command(
            "range.setValues",
            {"range": "Assumptions!F3:F3", "values": [["Scenario.Value"]]},
        )
        switch: List[List[Any]] = []
        for row in self.assumption_rows.values():
            switch.append(
                [
                    "=CHOOSE(Scenario.Active,B{0},C{0},D{0},E{0})".format(row)
                ]
            )
        engine.command(
            "range.setValues",
            {"range": "Assumptions!F4:F%d" % last, "values": switch},
        )
        for key, row in self.assumption_rows.items():
            self._define_name("Scenario.Value.%s" % key, "Assumptions", "F%d" % row)

    def _build_overrides(self) -> None:
        """The override layer: `Effective.*` = override, else the scenario."""
        engine = self.engine
        engine.command(
            "range.setValues",
            {
                "range": "Overrides!A1:C1",
                "values": [["assumption", "override_value", "effective_value"]],
            },
        )
        rows: List[List[Any]] = []
        for key in self.assumptions:
            row = 2 + len(self.override_rows)
            self.override_rows[key] = row
            rows.append([key, self.overrides.get(key), None])
        last = 1 + len(self.override_rows)
        engine.command("range.setValues", {"range": "Overrides!A2:C%d" % last, "values": rows})

        for key, row in self.override_rows.items():
            self._define_name("Overrides.Value.%s" % key, "Overrides", "B%d" % row)

        effective: List[List[Any]] = []
        for key in self.assumptions:
            effective.append(
                [
                    '=IF(Overrides.Value.{0}="",Scenario.Value.{0},Overrides.Value.{0})'.format(key)
                ]
            )
        engine.command(
            "range.setValues", {"range": "Overrides!C2:C%d" % last, "values": effective},
        )
        for key, row in self.override_rows.items():
            self._define_name("Effective.%s" % key, "Overrides", "C%d" % row)

    def _build_calculation_sheets(self) -> None:
        """The four calculation sheets.  They read `Effective.*` and nothing else."""
        engine = self.engine
        blocks = [
            (
                "Revenue",
                "Helios revenue (model points)",
                "=Effective.arr*(1-Effective.churn)*Effective.price.eur",
            ),
            (
                "Cost",
                "Helios cost of revenue (model points)",
                "=Effective.headcount.sales.q1*Effective.cac*(1-Effective.gm)",
            ),
            ("EBITDA", "Helios EBITDA (model points)", "=Revenue.TopLine-Cost.TopLine"),
            ("BalanceSheet", "Helios balance sheet (model points)", "=EBITDA.TopLine"),
        ]
        for sheet, label, formula in blocks:
            engine.command(
                "range.setValues",
                {"range": "%s!A1:B2" % sheet, "values": [[label, None], [sheet + ".TopLine", formula]]},
            )
            self._define_name(sheet + ".TopLine", sheet, "B2")

    def _build_scenarios(self) -> None:
        """Register the four scenarios with the engine's What-If scenario manager.

        The scenarios change the switch cell only, so applying one is a single
        atomic write of the index -- the model itself is never rewritten.
        """
        engine = self.engine
        engine.command("sheet.activate", {"sheet": "Assumptions"})
        for name, index in SCENARIOS:
            engine.command(
                "data.scenarioAdd",
                {
                    "name": name,
                    "changing": "B1",
                    "values": [index],
                    "comment": "Scenario.Active index %d" % index,
                    "replace": True,
                },
            )

    def _define_name(self, name: str, sheet: str, cell: str) -> None:
        """Define a workbook-scoped name that points at one cell.

        The reference is fully absolute on purpose.  A name whose row is
        relative (`Assumptions!$F4`) is re-anchored to the row of the cell
        that reads it, so the same name would resolve to a different cell in
        every formula that mentions it; `$F$4` always resolves to the one
        cell it was defined for.
        """
        column = "".join(character for character in cell if character.isalpha())
        row = "".join(character for character in cell if character.isdigit())
        self.engine.command(
            "formulas.defineName",
            {"name": name, "refersTo": "=%s!$%s$%s" % (sheet, column, row)},
        )
        self.name_cells[name] = "%s!%s" % (sheet, cell)

    # -- reading ----------------------------------------------------------
    def name_table(self) -> Dict[str, Dict[str, Any]]:
        """The engine's own name manager: name -> {refersTo, value, scope}."""
        raw = self.engine.command("formulas.nameManager", {})
        return {entry["name"]: entry for entry in raw}

    def outputs(self) -> Dict[str, Any]:
        """The current value of every named output."""
        table = self.name_table()
        return {name: table[name]["value"] for name in OUTPUT_NAMES if name in table}

    def output_value(self, name: str) -> Any:
        return self.name_table()[name]["value"]

    def active_index(self) -> Any:
        return self.output_value("Scenario.Active")

    # -- switching --------------------------------------------------------
    def apply_scenario(self, index: int) -> Dict[str, Any]:
        """Apply a scenario through the engine's scenario manager.

        `data.scenarioShow` writes the scenario's stored value into the switch
        cell; the dependent tree is recalculated by the engine.  The index is
        validated first, so an illegal index never reaches the workbook.
        """
        if index not in SCENARIO_BY_INDEX:
            raise ValueError("illegal scenario index: %r" % (index,))
        self.engine.command("data.scenarioShow", {"name": SCENARIO_BY_INDEX[index]})
        self.engine.command("formulas.calculateNow", {})
        return {"index": index, "scenario": SCENARIO_BY_INDEX[index]}

    def force_index(self, index: int) -> None:
        """Write the switch cell directly, bypassing the scenario manager.

        Used to show that the *model* fails closed and not just the control
        channel: an illegal index turns every dependent into an error value.
        """
        self.engine.command(
            "cell.set", {"cell": "Assumptions!B1", "input": index}
        )
        self.engine.command("formulas.calculateNow", {})


# --------------------------------------------------------------------------
# The dependency map
# --------------------------------------------------------------------------
def build_dependency_map(model: HeliosModel, audit: Dict[str, str]) -> Dict[str, Any]:
    """The model's dependency map: named ranges as nodes, formula reads as edges.

    The map is derived from the engine's own formulas (`get_cell` returns the
    formula text GridCraft holds) and is then cross-checked against the
    engine's Formula Auditing commands: `formulas.errorChecking` for cycles and
    `formulas.tracePrecedents` for the cell-level reads.
    """
    engine = model.engine
    table = model.name_table()
    nodes = sorted(table)
    by_cell: Dict[str, str] = {}
    for name in nodes:
        sheet, cell = split_refers_to(table[name]["refersTo"])
        by_cell["%s!%s" % (sheet, cell)] = name

    formulas: Dict[str, str] = {}
    edges: List[Dict[str, str]] = []
    external: List[Dict[str, str]] = []
    for name in nodes:
        sheet, cell = split_refers_to(table[name]["refersTo"])
        record = engine.tool("get_cell", {"cell": "%s!%s" % (sheet, cell) if sheet else cell})
        formula = record.get("formula")
        if not formula:
            continue
        formulas[name] = formula
        for reference in parse_references(formula, sheet):
            if "!" in reference:
                # a cell address: it is a node of the map when a name points at it
                if reference in by_cell:
                    edge = {"from": by_cell[reference], "to": name}
                    if edge not in edges:
                        edges.append(edge)
                else:
                    leaf = {"cell": reference, "used_by": name}
                    if leaf not in external:
                        external.append(leaf)
            elif reference in table:
                # a defined name: the node it points at
                edge = {"from": reference, "to": name}
                if edge not in edges:
                    edges.append(edge)
            else:
                leaf = {"cell": reference, "used_by": name}
                if leaf not in external:
                    external.append(leaf)

    edges.sort(key=lambda edge: (edge["from"], edge["to"]))
    graph = {"nodes": nodes, "edges": edges, "external_precedents": external}

    # The engine's own verdict on the workbook: no cycles, no error cells.
    audit_report = engine.command(audit["errorChecking"], {})
    if audit_report.get("circular"):
        raise ModelCycleError(audit_report["circular"], audit["errorChecking"])
    if audit_report.get("errors"):
        raise EngineError("the model has error cells: %s" % json.dumps(audit_report["errors"]))

    graph.update(assert_acyclic(graph))
    graph["engine_audit"] = {
        "command": audit["errorChecking"],
        "circular": audit_report.get("circular", []),
        "errors": audit_report.get("errors", []),
    }
    graph["formulas"] = formulas
    graph["trace_cross_check"] = cross_check_traces(model, formulas, audit["tracePrecedents"])
    graph["computed_under_scenario"] = model.active_index()
    return graph


def assert_acyclic(graph: Dict[str, Any]) -> Dict[str, Any]:
    """Assert the dependency map is a DAG and measure its depth.

    A cycle is reported as a structured error naming the members, so the
    caller can serialise it instead of printing a stack trace.
    """
    adjacency: Dict[str, List[str]] = {node: [] for node in graph["nodes"]}
    for edge in graph["edges"]:
        adjacency.setdefault(edge["from"], []).append(edge["to"])

    WHITE, GREY, BLACK = 0, 1, 2
    colour = {node: WHITE for node in adjacency}
    stack: List[str] = []
    cycles: List[List[str]] = []

    def visit(node: str) -> None:
        colour[node] = GREY
        stack.append(node)
        for nxt in adjacency.get(node, ()):
            if nxt not in colour:
                continue  # a precedent that is not a node of the map
            if colour[nxt] == GREY:
                cycles.append(stack[stack.index(nxt):] + [nxt])
            elif colour[nxt] == WHITE:
                visit(nxt)
        stack.pop()
        colour[node] = BLACK

    for node in sorted(adjacency):
        if colour[node] == WHITE:
            visit(node)
    if cycles:
        raise ModelCycleError(cycles[0], "dependency map")

    depth_memo: Dict[str, int] = {}

    def depth(node: str) -> int:
        if node in depth_memo:
            return depth_memo[node]
        depth_memo[node] = 0
        best = 0
        for nxt in adjacency.get(node, ()):
            if nxt in adjacency:
                best = max(best, 1 + depth(nxt))
        depth_memo[node] = best
        return best

    return {
        "acyclic": True,
        "depth_max": max((depth(node) for node in adjacency), default=0),
    }


def cross_check_traces(
    model: HeliosModel, formulas: Dict[str, str], trace_command: str
) -> Dict[str, Any]:
    """Check the parsed references against the engine's tracer.

    The engine's tracer only sees cell references (defined names are opaque
    to it), so every address it reports must also be in the parsed set.
    """
    engine = model.engine
    by_sheet: Dict[str, List[str]] = {}
    for name, formula in sorted(formulas.items()):
        sheet, cell = split_refers_to(model.name_table()[name]["refersTo"])
        by_sheet.setdefault(sheet, []).append((name, cell, formula))

    checked = 0
    mismatches: List[Dict[str, Any]] = []
    for sheet in sorted(by_sheet):
        engine.command("sheet.activate", {"sheet": sheet})
        for name, cell, formula in by_sheet[sheet]:
            traced = engine.command(trace_command, {"cell": cell})
            engine_cells = set()
            for item in traced:
                engine_cells.add(
                    normalise_cell("%s!%s" % (item.get("sheet", sheet), item.get("range", "")), sheet)
                )
            parsed_cells = {
                reference for reference in parse_references(formula, sheet) if "!" in reference
            }
            checked += 1
            missing = sorted(engine_cells - parsed_cells)
            if missing:
                mismatches.append({"name": name, "cell": cell, "unparsed": missing})
    return {"checked": checked, "mismatches": mismatches}


# --------------------------------------------------------------------------
# The loopback control channel
# --------------------------------------------------------------------------
class ControlServer:
    """The loopback control channel in front of the workbook.

    Wire format: one JSON object per line, UTF-8, in both directions.

      * the first frame a client sends must be the auth frame
        ``{"id": "auth", "method": "auth", "params": {"token": "<64 hex>"}}``
      * every later frame is a request/response pair
        ``{"id": 1, "method": "scenario.set", "params": {"index": 1}}``
        ``{"id": 2, "method": "engine.execute", "params": {"command": "output.read", "params": {"name": "Effective.arr"}}}``

    The server owns the engine session and serialises every engine
    interaction, so a toggle (write + recalculate + publish) and a read can
    never interleave.  A reader therefore never observes a half-updated tree,
    and an illegal index is rejected before the workbook is touched.
    """

    def __init__(self, model: HeliosModel, token: str, host: str = "127.0.0.1", port: int = 7979):
        self.model = model
        self.engine = model.engine
        self.token = token
        self.host = host
        self.requested_port = port
        self.port = port
        self._socket: Optional[socket.socket] = None
        self._thread: Optional[threading.Thread] = None
        self._stop = threading.Event()
        self._lock = threading.RLock()
        self._name_cells: Dict[str, str] = {}
        self.toggles_applied = 0
        self.toggles_rejected = 0
        self.reads_served = 0

    # -- lifecycle --------------------------------------------------------
    def start(self) -> int:
        self._socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self._socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        try:
            self._socket.bind((self.host, self.requested_port))
        except OSError:
            self._socket.bind((self.host, 0))  # the port is taken: take a free one
        self._socket.listen(8)
        self.port = int(self._socket.getsockname()[1])
        table = self.model.name_table()
        for name, entry in table.items():
            sheet, cell = split_refers_to(entry["refersTo"])
            self._name_cells[name] = "%s!%s" % (sheet, cell) if sheet else cell
        self._thread = threading.Thread(target=self._accept_loop, name="control-accept", daemon=True)
        self._thread.start()
        return self.port

    def stop(self) -> None:
        self._stop.set()
        if self._socket is not None:
            try:
                self._socket.close()
            except OSError:
                pass
        if self._thread is not None:
            self._thread.join(timeout=5)

    def _accept_loop(self) -> None:
        assert self._socket is not None
        while not self._stop.is_set():
            try:
                connection, _ = self._socket.accept()
            except OSError:
                break
            thread = threading.Thread(target=self._serve, args=(connection,), daemon=True)
            thread.start()

    # -- the protocol -----------------------------------------------------
    def _serve(self, connection: socket.socket) -> None:
        with connection:
            reader = connection.makefile("r", encoding="utf-8", newline="\n")
            authenticated = False
            for line in reader:
                line = line.strip()
                if not line:
                    continue
                try:
                    frame = json.loads(line)
                except json.JSONDecodeError:
                    self._send(
                        connection,
                        {
                            "id": None,
                            "ok": False,
                            "error": {"code": "malformed_frame", "message": "the frame is not JSON"},
                        },
                    )
                    return
                if not isinstance(frame, dict):
                    self._send(
                        connection,
                        {
                            "id": None,
                            "ok": False,
                            "error": {"code": "malformed_frame", "message": "the frame is not an object"},
                        },
                    )
                    return
                if not authenticated:
                    reply, authenticated = self._authenticate(frame)
                    self._send(connection, reply)
                    if not authenticated:
                        return
                    continue
                self._send(connection, self._dispatch(frame))

    def _authenticate(self, frame: Dict[str, Any]) -> Tuple[Dict[str, Any], bool]:
        request_id = frame.get("id")
        if frame.get("method") != AUTH_METHOD:
            return (
                {
                    "id": request_id,
                    "ok": False,
                    "error": {
                        "code": "auth_required",
                        "message": "the first frame must be the auth frame",
                    },
                },
                False,
            )
        token = str((frame.get("params") or {}).get("token", ""))
        if not hmac.compare_digest(token, self.token):
            return (
                {
                    "id": request_id,
                    "ok": False,
                    "error": {"code": "auth_failed", "message": "invalid automation token"},
                },
                False,
            )
        return (
            {
                "id": request_id,
                "ok": True,
                "result": {
                    "authenticated": True,
                    "legal_indexes": sorted(SCENARIO_BY_INDEX),
                    "scenarios": [name for name, _ in SCENARIOS],
                },
            },
            True,
        )

    def _dispatch(self, frame: Dict[str, Any]) -> Dict[str, Any]:
        request_id = frame.get("id")
        method = frame.get("method")
        params = frame.get("params") or {}
        try:
            if method == TOGGLE_METHOD:
                result = self._toggle(params)
            elif method == EXECUTE_METHOD:
                result = self._execute(params)
            else:
                return {
                    "id": request_id,
                    "ok": False,
                    "error": {
                        "code": "unknown_method",
                        "message": "the control channel has no method %r" % (method,),
                    },
                }
        except ControlChannelError as error:
            return {"id": request_id, "ok": False, "error": error.payload}
        return {"id": request_id, "ok": True, "result": result}

    def _toggle(self, params: Dict[str, Any]) -> Dict[str, Any]:
        index = params.get("index")
        with self._lock:
            if not isinstance(index, int) or isinstance(index, bool) or index not in SCENARIO_BY_INDEX:
                self.toggles_rejected += 1
                raise ControlChannelError(
                    {
                        "code": "illegal_scenario_index",
                        "message": "scenario index %r is not legal" % (index,),
                        "legal_indexes": sorted(SCENARIO_BY_INDEX),
                        "active_scenario": self.model.active_index(),
                    }
                )
            applied = self.model.apply_scenario(index)
            outputs = self.model.outputs()
            outputs["Scenario.Active"] = self.model.active_index()
            self.toggles_applied += 1
        return {
            "index": index,
            "scenario": applied["scenario"],
            "active_scenario": outputs["Scenario.Active"],
            "outputs": outputs,
        }

    def _execute(self, params: Dict[str, Any]) -> Dict[str, Any]:
        command = params.get("command")
        command_params = params.get("params") or {}
        if command != READ_COMMAND:
            raise ControlChannelError(
                {
                    "code": "unknown_command",
                    "message": "the control channel cannot run %r" % (command,),
                }
            )
        name = command_params.get("name")
        with self._lock:
            value = self._read_output(name)
            self.reads_served += 1
        return {"name": name, "value": value}

    def _read_output(self, name: Any) -> Any:
        cell = self._name_cells.get(str(name))
        if cell is None:
            raise ControlChannelError(
                {"code": "unknown_name", "message": "%r is not a defined name" % (name,)}
            )
        payload = self.engine.tool("read_range", {"range": cell})
        values = payload.get("values") or []
        if not values or not values[0]:
            return None
        return values[0][0]

    @staticmethod
    def _send(connection: socket.socket, payload: Dict[str, Any]) -> None:
        connection.sendall((json.dumps(payload) + "\n").encode("utf-8"))


class ControlClient:
    """A client for the loopback control channel."""

    def __init__(self, host: str, port: int, token: str, timeout: float = 15.0):
        self._socket = socket.create_connection((host, port), timeout=timeout)
        self._socket.settimeout(timeout)
        self._reader = self._socket.makefile("r", encoding="utf-8", newline="\n")
        self._next_id = 0
        reply = self.request(AUTH_METHOD, {"token": token}, request_id="auth")
        if not reply.get("ok"):
            raise ControlChannelError(reply.get("error") or {"code": "auth_failed", "message": "?"})

    def request(
        self, method: str, params: Dict[str, Any], request_id: Optional[Any] = None
    ) -> Dict[str, Any]:
        self._next_id += 1
        frame = {
            "id": request_id if request_id is not None else self._next_id,
            "method": method,
            "params": params,
        }
        self._socket.sendall((json.dumps(frame) + "\n").encode("utf-8"))
        line = self._reader.readline()
        if not line:
            raise ControlChannelError({"code": "connection_closed", "message": "the server closed the socket"})
        return json.loads(line)

    def close(self) -> None:
        try:
            self._socket.close()
        except OSError:
            pass


# --------------------------------------------------------------------------
# The race harness
# --------------------------------------------------------------------------
def is_legal_read(value: Any, legal: Sequence[Any]) -> bool:
    """Acceptance predicate: a read is legal only if it is one of the settled values."""
    return value in legal


def run_scheduler(
    host: str,
    port: int,
    token: str,
    duration: float,
    indexes: Sequence[int],
    interval: float,
    result_path: Path,
) -> int:
    """Push scenario toggles at a fixed cadence over the control channel."""
    client = ControlClient(host, port, token)
    toggles = 0
    errors: List[Any] = []
    deadline = time.monotonic() + duration
    turn = 0
    try:
        while time.monotonic() < deadline:
            index = indexes[turn % len(indexes)]
            turn += 1
            reply = client.request(TOGGLE_METHOD, {"index": index})
            if reply.get("ok"):
                toggles += 1
            else:
                errors.append(reply.get("error"))
            time.sleep(interval)
    finally:
        client.close()
    result_path.write_text(
        json.dumps(
            {
                "role": "scheduler",
                "toggles": toggles,
                "errors": errors,
                "indexes": list(indexes),
                "interval_s": interval,
                "duration_s": duration,
            },
            indent=2,
        )
    )
    return 0


def run_reader(
    host: str,
    port: int,
    token: str,
    name: str,
    legal: Sequence[Any],
    duration: float,
    result_path: Path,
) -> int:
    """Read one named output as fast as the channel allows and check every read."""
    client = ControlClient(host, port, token)
    reads = 0
    distinct: Dict[str, Any] = {}
    illegal: List[Any] = []
    max_latency_ms = 0.0
    deadline = time.monotonic() + duration
    try:
        while time.monotonic() < deadline:
            started = time.perf_counter()
            reply = client.request(
                EXECUTE_METHOD, {"command": READ_COMMAND, "params": {"name": name}}
            )
            latency_ms = (time.perf_counter() - started) * 1000.0
            max_latency_ms = max(max_latency_ms, latency_ms)
            reads += 1
            if not reply.get("ok"):
                illegal.append({"error": reply.get("error")})
                continue
            value = reply["result"]["value"]
            distinct[json.dumps(value, sort_keys=True)] = value
            if not is_legal_read(value, legal):
                illegal.append({"value": value})
            time.sleep(0.001)  # keep the scheduler's turns coming
    finally:
        client.close()
    result_path.write_text(
        json.dumps(
            {
                "role": "reader",
                "name": name,
                "reads": reads,
                "distinct_values": [distinct[key] for key in sorted(distinct)],
                "legal_values": list(legal),
                "illegal_reads": len(illegal),
                "illegal_samples": illegal[:10],
                "max_read_latency_ms": round(max_latency_ms, 3),
            },
            indent=2,
        )
    )
    # A read outside the legal set is a torn recompute: fail loudly.
    return 1 if illegal else 0


def spawn_role(role: str, arguments: Sequence[str]) -> subprocess.Popen:
    command = [sys.executable, str(Path(__file__).resolve()), "--role", role] + list(arguments)
    return subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


# --------------------------------------------------------------------------
# The audit of the effective assumptions
# --------------------------------------------------------------------------
def audit_effective_assumptions(
    model: HeliosModel, graph: Dict[str, Any]
) -> List[Dict[str, Any]]:
    """The `EffectiveAssumption` table: what each assumption resolved to."""
    table = model.name_table()
    dependents: Dict[str, List[str]] = {}
    for edge in graph["edges"]:
        dependents.setdefault(edge["from"], []).append(edge["to"])

    audit: List[Dict[str, Any]] = []
    for key in model.assumptions:
        override_name = "Overrides.Value.%s" % key
        override_cell = table.get(override_name, {}).get("value")
        override_present = isinstance(override_cell, (int, float)) and not isinstance(
            override_cell, bool
        )
        audit.append(
            {
                "name": key,
                "scenario_value": table.get("Scenario.Value.%s" % key, {}).get("value"),
                "override_present": override_present,
                "override_value": override_cell if override_present else None,
                "effective_value": table.get("Effective.%s" % key, {}).get("value"),
                "used_by": sorted(dependents.get("Effective.%s" % key, [])),
            }
        )
    return audit


# --------------------------------------------------------------------------
# The main flow
# --------------------------------------------------------------------------
def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_table(path: Optional[str]) -> Dict[str, Any]:
    if not path:
        return json.loads(json.dumps(DEFAULT_TABLE))
    return json.loads(Path(path).read_text())


def parent_main(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    engine = MCPClient([ENGINE, "mcp"], log_path=out_dir / "engine.log")
    report: Dict[str, Any] = {
        "generated_by": Path(__file__).name,
        "control_protocol": CONTROL_PROTOCOL,
        "artifacts": {},
    }
    try:
        server_info = engine.initialize()
        report["engine"] = server_info
        report["engine"]["commands"] = verify_command_catalogue(engine)
        audit_commands = {
            "errorChecking": "formulas.errorChecking",
            "tracePrecedents": "formulas.tracePrecedents",
        }

        model = HeliosModel(engine, load_table(args.scenario_table))
        model.build()
        report["engine_scenarios"] = engine.command("data.scenarioManager", {"sheet": "*"})

        # 1. the dependency map, asserted acyclic before anything is toggled
        graph = build_dependency_map(model, audit_commands)
        report["dependency_map"] = {
            "nodes": graph["nodes"],
            "edges": graph["edges"],
            "acyclic": graph["acyclic"],
            "depth_max": graph["depth_max"],
            "computed_under_scenario": graph["computed_under_scenario"],
            "external_precedents": graph["external_precedents"],
            "engine_audit": graph["engine_audit"],
            "trace_cross_check": graph["trace_cross_check"],
        }
        (out_dir / "dependency-map.json").write_text(json.dumps(graph, indent=2))

        report["effective_assumptions"] = audit_effective_assumptions(model, graph)

        # 1b. every scenario resolves, and the base scenario is restored
        scenario_outputs: Dict[str, Any] = {}
        for name, index in SCENARIOS:
            model.apply_scenario(index)
            scenario_outputs[name] = model.outputs()
        model.apply_scenario(2)
        report["scenario_outputs"] = scenario_outputs

        # 2. the toggle is idempotent: the same index twice gives the same
        #    named outputs and the same bytes on disk
        model.apply_scenario(2)
        first_values = {name: entry["value"] for name, entry in model.name_table().items()}
        first_path = out_dir / "toggle-once.xlsx"
        engine.command("file.save", {"path": str(first_path)})
        model.apply_scenario(2)
        second_values = {name: entry["value"] for name, entry in model.name_table().items()}
        second_path = out_dir / "toggle-twice.xlsx"
        engine.command("file.save", {"path": str(second_path)})
        report["idempotence"] = {
            "scenario_index": 2,
            "names_compared": len(first_values),
            "outputs": first_values,
            "outputs_identical": first_values == second_values,
            "workbook_bytes_identical": sha256_of(first_path) == sha256_of(second_path),
            "sha256": [sha256_of(first_path), sha256_of(second_path)],
        }

        # 3. the control channel and the two-process race
        token = secrets.token_hex(32)
        server = ControlServer(model, token, host=args.host, port=args.port)
        port = server.start()
        try:
            # The two values the watched output can take while the scheduler
            # toggles between Bear and Bull.
            model.apply_scenario(1)
            bear_value = model.output_value(WATCHED_OUTPUT)
            model.apply_scenario(3)
            bull_value = model.output_value(WATCHED_OUTPUT)
            legal = [bear_value, bull_value]

            scheduler_result = out_dir / "scheduler.json"
            reader_result = out_dir / "reader.json"
            scheduler = spawn_role(
                "scheduler",
                [
                    "--host", args.host,
                    "--port", str(port),
                    "--token", token,
                    "--duration", str(args.duration),
                    "--indexes", args.indexes,
                    "--interval", str(args.interval),
                    "--result", str(scheduler_result),
                ],
            )
            reader = spawn_role(
                "reader",
                [
                    "--host", args.host,
                    "--port", str(port),
                    "--token", token,
                    "--name", WATCHED_OUTPUT,
                    "--legal", ",".join(repr(float(value)) for value in legal),
                    "--duration", str(args.duration),
                    "--result", str(reader_result),
                ],
            )
            scheduler_out, scheduler_err = scheduler.communicate(timeout=args.duration + 60)
            reader_out, reader_err = reader.communicate(timeout=args.duration + 60)
            if scheduler.returncode != 0 or reader.returncode != 0:
                raise EngineError(
                    "the race harness failed: %s %s"
                    % (scheduler_err.decode("utf-8", "replace"), reader_err.decode("utf-8", "replace"))
                )
            scheduler_report = json.loads(scheduler_result.read_text())
            reader_report = json.loads(reader_result.read_text())
            # The counters are read before the fail-closed probes, so they
            # account for the race alone.
            race_counters = {
                "toggles_applied": server.toggles_applied,
                "toggles_rejected": server.toggles_rejected,
                "reads_served": server.reads_served,
            }

            # 4. fail closed: an illegal index is rejected and nothing is written
            control = ControlClient(args.host, port, token)
            try:
                before = control.request(
                    EXECUTE_METHOD, {"command": READ_COMMAND, "params": {"name": WATCHED_OUTPUT}}
                )
                fingerprint_before = save_fingerprint(engine, out_dir / "before-rejection.json")
                rejected = control.request(TOGGLE_METHOD, {"index": 5})
                after = control.request(
                    EXECUTE_METHOD, {"command": READ_COMMAND, "params": {"name": WATCHED_OUTPUT}}
                )
                fingerprint_after = save_fingerprint(engine, out_dir / "after-rejection.json")
            finally:
                control.close()

            report["fail_closed"] = {
                "control_channel": {
                    "index": 5,
                    "rejected": not rejected.get("ok", False),
                    "error": rejected.get("error"),
                    "state_held": before.get("result", {}).get("value")
                    == after.get("result", {}).get("value"),
                    "value_after_rejection": after.get("result", {}).get("value"),
                    "workbook_unchanged": fingerprint_before == fingerprint_after,
                }
            }
        finally:
            server.stop()

        # 5. fail closed inside the model itself: an index written straight
        #    into the switch cell must not silently clamp
        model.force_index(5)
        audit = engine.command("formulas.errorChecking", {})
        report["fail_closed"]["model"] = {
            "written_index": 5,
            "effective_value": model.output_value("Effective.arr"),
            "engine_audit": {"circular": audit.get("circular", []), "errors": audit.get("errors", [])},
        }
        model.apply_scenario(2)
        report["fail_closed"]["model"]["restored"] = model.active_index() == 2
        report["fail_closed"]["model"]["restored_outputs"] = model.outputs()

        # 6. the artefacts
        workbook_path = out_dir / "helios-scenario-model.xlsx"
        engine.command("file.save", {"path": str(workbook_path)})
        report["artifacts"] = {
            "workbook": str(workbook_path),
            "workbook_sha256": sha256_of(workbook_path),
            "dependency_map": str(out_dir / "dependency-map.json"),
        }
        report["race"] = {
            "duration_s": args.duration,
            "port": port,
            "scheduler": scheduler_report,
            "reader": reader_report,
            "toggles": scheduler_report["toggles"],
            "reads": reader_report["reads"],
            "distinct_values_observed": reader_report["distinct_values"],
            "legal_values": legal,
            "illegal_reads": reader_report["illegal_reads"],
            "max_read_latency_ms": reader_report["max_read_latency_ms"],
            "both_scenarios_seen": len(set(reader_report["distinct_values"])) == 2,
            "control_channel_counters": race_counters,
        }
        report["named_outputs"] = model.outputs()
        report["active_scenario"] = model.active_index()
    except ModelCycleError as error:
        report["error"] = {
            "error": "dependency_cycle",
            "cycle": error.cycle,
            "reported_by": error.reported_by,
        }
        (out_dir / "scenario-race-report.json").write_text(json.dumps(report, indent=2))
        print("the model graph is not acyclic: %s" % error)
        return 2
    finally:
        engine.close()

    report_path = out_dir / "scenario-race-report.json"
    report_path.write_text(json.dumps(report, indent=2))
    print("Helios scenario model")
    print("  workbook          %s" % report["artifacts"]["workbook"])
    print("  named ranges      %d" % len(report["dependency_map"]["nodes"]))
    print("  dependency edges  %d (acyclic, depth %d)"
          % (len(report["dependency_map"]["edges"]), report["dependency_map"]["depth_max"]))
    print("  toggles / reads   %d / %d" % (report["race"]["toggles"], report["race"]["reads"]))
    print("  illegal reads     %d" % report["race"]["illegal_reads"])
    print("  report            %s" % report_path)
    return 0 if report["race"]["illegal_reads"] == 0 else 1


def save_fingerprint(engine: MCPClient, path: Path) -> str:
    """Save the workbook as JSON and return the digest of the bytes on disk.

    The JSON export is byte-stable for a given state, so two fingerprints that
    match prove that a rejected frame wrote nothing at all.
    """
    engine.command("file.save", {"path": str(path)})
    return sha256_of(path)


# --------------------------------------------------------------------------
# The command line
# --------------------------------------------------------------------------
def parse_args(argv: Optional[Sequence[str]] = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Helios scenario-toggle model")
    parser.add_argument("--role", choices=("parent", "scheduler", "reader"), default="parent")
    parser.add_argument("--out-dir", default="helios-out", help="where the artefacts are written")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=7979, help="the control channel's port")
    parser.add_argument("--duration", type=float, default=10.0, help="seconds the race harness runs")
    parser.add_argument("--token", default="", help="the control channel's automation token")
    parser.add_argument("--name", default=WATCHED_OUTPUT, help="the named output the reader watches")
    parser.add_argument("--legal", default="", help="comma separated legal values for the reader")
    parser.add_argument("--indexes", default="1,3", help="the scenario indexes the scheduler toggles")
    parser.add_argument("--interval", type=float, default=0.05, help="seconds between toggles")
    parser.add_argument("--result", default="", help="where a child process writes its report")
    parser.add_argument("--scenario-table", default=None, help="JSON fixture with the assumption table")
    return parser.parse_args(argv)


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = parse_args(argv)
    if args.role == "scheduler":
        indexes = [int(part) for part in args.indexes.split(",") if part.strip()]
        return run_scheduler(
            args.host,
            args.port,
            args.token,
            args.duration,
            indexes,
            args.interval,
            Path(args.result),
        )
    if args.role == "reader":
        legal = [float(part) for part in args.legal.split(",") if part]
        return run_reader(
            args.host,
            args.port,
            args.token,
            args.name,
            legal,
            args.duration,
            Path(args.result),
        )
    return parent_main(args)


if __name__ == "__main__":
    sys.exit(main())
