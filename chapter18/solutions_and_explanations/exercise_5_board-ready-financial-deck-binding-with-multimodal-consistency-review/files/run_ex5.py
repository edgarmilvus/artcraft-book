#!/usr/bin/env python3
"""
run_ex5.py -- the acceptance harness for exercise 5.

It builds the exercise's fixtures with the real engines (two audited
GridCraft workbooks and a declarative deck template), writes a deterministic
stand-in for the multimodal reviewer, runs `06_deck_binding.py` against
them and then checks the artefacts the run left behind: the published deck,
the PDF, the binding map, the audit report, the rendered slides and their
hashes, the corrections that were applied and the findings that were not.

The harness also replays the late-breaking-adjustment story: it books a
synthetic adjustment in the consolidated workbook, runs the binding pass
again and checks that the deck followed the workbook without a human
touching a slide.

The harness needs the ArtCraft CLIs on PATH (it adds the repository's
`tools/craft-cli/bin` when they are there) and nothing else: no API key, no
network, no service to start.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence, Tuple

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
CLIS = REPO / "tools" / "craft-cli" / "bin"
SOLUTION = HERE / "05_board-ready-financial-deck-binding-with-multimodal-consistency-review.py"
CONTRACT_BINDINGS = HERE / "01_typescript.ts"
CONTRACT_REPORT = HERE / "02_typescript.ts"

PASSED = 0
FAILURES: List[str] = []


def check(label: str, condition: Any, detail: str = "") -> bool:
    """Record one assertion."""
    global PASSED
    if condition:
        PASSED += 1
        print("PASS %s" % label)
        return True
    FAILURES.append(label)
    print("FAIL %s%s" % (label, (" -- " + detail) if detail else ""))
    return False


# --------------------------------------------------------------------------
# A small MCP client, so the harness can ask the engines themselves
# --------------------------------------------------------------------------
class MCPClient:
    def __init__(self, argv: Sequence[str], cwd: Optional[str] = None):
        self.process = subprocess.Popen(
            list(argv),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
            cwd=cwd,
        )
        self.next_id = 0

    def request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        self.next_id += 1
        frame = {"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params or {}}
        assert self.process.stdin is not None and self.process.stdout is not None
        self.process.stdin.write((json.dumps(frame) + "\n").encode("utf-8"))
        self.process.stdin.flush()
        line = self.process.stdout.readline()
        if not line:
            raise RuntimeError("the MCP server closed its stdout")
        reply = json.loads(line.decode("utf-8"))
        if "error" in reply:
            raise RuntimeError("%s failed: %s" % (method, reply["error"]))
        return reply.get("result", {})

    def tool(self, name: str, arguments: Optional[Dict[str, Any]] = None) -> Any:
        result = self.request("tools/call", {"name": name, "arguments": arguments or {}})
        if result.get("isError"):
            raise RuntimeError("%s: %s" % (name, result.get("content")))
        for block in result.get("content", []):
            if block.get("type") == "text":
                try:
                    return json.loads(block["text"])
                except json.JSONDecodeError:
                    return block["text"]
        raise RuntimeError("%s returned no text content block" % name)

    def command(self, command_id: str, params: Optional[Dict[str, Any]] = None) -> Any:
        return self.tool("execute_command", {"command": command_id, "params": params or {}})

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

    def __enter__(self) -> "MCPClient":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


# --------------------------------------------------------------------------
# The fixture model
# --------------------------------------------------------------------------
#: The consolidated P&L of the Helios group, in dollars.
CONSOLIDATED_SHEETS: List[Tuple[str, List[Tuple[str, Any]]]] = [
    ("Consolidated", [
        ("A1", "Helios consolidated P&L (2026-09)"),
        ("A3", "Line item"), ("B3", "Amount"),
        ("A4", "Gross revenue"), ("B4", 168_400_000.0),
        ("A5", "Eliminations"), ("B5", -4_200_000.0),
        ("A6", "Net revenue"), ("B6", "=B4+B5"),
        ("A7", "Cost of sales"), ("B7", -71_700_000.0),
        ("A8", "Gross profit"), ("B8", "=B6+B7"),
        ("A9", "Gross margin"), ("B9", "=B8/B6"),
        ("A10", "Operating expense"), ("B10", -52_300_000.0),
        ("A11", "EBITDA"), ("B11", "=B8+B10"),
        ("A12", "Depreciation and amortisation"), ("B12", -9_800_000.0),
        ("A13", "EBIT"), ("B13", "=B11+B12"),
        ("A14", "Interest"), ("B14", -6_100_000.0),
        ("A15", "Tax"), ("B15", -7_440_000.0),
        ("A16", "Net income"), ("B16", "=B13+B14+B15"),
        ("A17", "Capital expenditure"), ("B17", -8_900_000.0),
        ("A18", "Free cash flow"), ("B18", "=B16+B17"),
        ("A19", "Net margin"), ("B19", "=B16/B6"),
    ]),
    ("Scenarios", [
        ("A1", "Scenario"), ("B1", "Net revenue"), ("C1", "EBITDA"),
        ("A2", "Base"), ("B2", "=Consolidated!B6"), ("C2", "=Consolidated!B11"),
        ("A3", "Upside"), ("B3", "=Consolidated!B6*1.08"), ("C3", "=Consolidated!B11*1.12"),
        ("A4", "Downside"), ("B4", "=Consolidated!B6*0.93"), ("C4", "=Consolidated!B11*0.88"),
    ]),
]

CONSOLIDATED_NAMES = [
    ("Helios.Revenue.Q3", "=Consolidated!$B$6"),
    ("Helios.GrossMargin.Pct", "=Consolidated!$B$9"),
    ("Helios.Ebitda.Q3", "=Consolidated!$B$11"),
    ("Helios.NetIncome.Q3", "=Consolidated!$B$16"),
    ("Helios.FreeCashFlow.Q3", "=Consolidated!$B$18"),
    ("Helios.NetMargin.Pct", "=Consolidated!$B$19"),
]

RECONCILIATION_SHEETS: List[Tuple[str, List[Tuple[str, Any]]]] = [
    ("Reconciliation", [
        ("A1", "Helios close reconciliation (2026-09)"),
        ("A3", "Line item"), ("B3", "Amount"),
        ("A4", "Net revenue per consolidation"), ("B4", 164_200_000.0),
        ("A5", "Reconciling items raised"), ("B5", 125_000.0),
        ("A6", "Unresolved items"), ("B6", 40_000.0),
        ("A7", "Reconciled net revenue"), ("B7", "=B4+B5-B6"),
        ("A8", "Variance to the audited close"), ("B8", "=B7-164200000"),
    ]),
]

RECONCILIATION_NAMES = [
    ("Helios.Close.Items", "=Reconciliation!$B$5"),
    ("Helios.Close.Unresolved", "=Reconciliation!$B$6"),
    ("Helios.Close.Reconciled", "=Reconciliation!$B$7"),
    ("Helios.Close.Variance", "=Reconciliation!$B$8"),
]

#: The figures the fixture is worth, computed by hand.
EXPECTED = {
    "revenue": 164_200_000.0,
    "gross_margin": 92_500_000.0 / 164_200_000.0,
    "ebitda": 40_200_000.0,
    "net_income": 16_860_000.0,
    "free_cash_flow": 7_960_000.0,
    "net_margin": 16_860_000.0 / 164_200_000.0,
    "items": 125_000.0,
    "unresolved": 40_000.0,
    "reconciled": 164_285_000.0,
    "variance": 85_000.0,
}

#: The figure a colleague typed into the deck by hand and never bound.  It
#: is the gross revenue, presented as the net revenue: the defect the
#: pipeline has to escalate instead of correcting.
STALE_TEXT = "Net revenue: $168.4M"

#: The footnote that does not fit on its slide.
FOOTNOTE = "\n".join(
    "Footnote %d: the figures of this slide are the audited close and are not" % index
    for index in range(1, 8)
)


def build_workbook(path: Path, sheets: List[Tuple[str, List[Tuple[str, Any]]]],
                   names: Sequence[Tuple[str, str]] = ()) -> Dict[str, Any]:
    """Write one source workbook with the engine itself."""
    path.parent.mkdir(parents=True, exist_ok=True)
    client = MCPClient(["gridcraft-cli", "mcp"], cwd=str(path.parent))
    try:
        client.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "run-ex5-fixture", "version": "1.0"},
            },
        )
        client.tool("new_workbook", {})
        client.command("sheet.rename", {"sheet": "Sheet1", "name": sheets[0][0]})
        for name, _cells in sheets[1:]:
            client.command("home.insertSheet", {"name": name})
        for sheet, cells in sheets:
            for address, value in cells:
                client.command("cell.set", {"sheet": sheet, "cell": address, "input": value})
        for name, refers_to in names:
            client.command("formulas.defineName", {"name": name, "refersTo": refers_to})
        client.command("formulas.calculateNow", {})
        audit = client.command("formulas.errorChecking", {}) or {}
        defined = client.command("formulas.nameManager", {}) or []
        client.tool("save_workbook", {"path": str(path)})
    finally:
        client.close()
    return {"audit": audit, "names": defined}


def build_template() -> Dict[str, Any]:
    """The declarative deck the agent authors and binds."""
    return {
        "version": "1",
        "period": "2026-09",
        "sources": {
            "helios-consolidated": "helios-consolidated.xlsx",
            "close-reconciliation": "close-reconciliation.xlsx",
        },
        "reference": [
            {"label": "Net revenue", "source_kind": "name",
             "source_book": "helios-consolidated", "source_ref": "Helios.Revenue.Q3",
             "format": "$0.0M"},
            {"label": "EBITDA", "source_kind": "name",
             "source_book": "helios-consolidated", "source_ref": "Helios.Ebitda.Q3",
             "format": "$0.0M"},
        ],
        "slides": [
            {
                "layout": "titleOnly",
                "title": "Helios - board pack (2026-09)",
                "frames": [
                    {"slot": "kpi.revenue", "kind": "text", "x": 60, "y": 170, "w": 280,
                     "h": 36, "size": 24, "placeholder": "[[kpi.revenue]]",
                     "binding": {"label": "Net revenue", "prefix": "Net revenue: ",
                                 "source_kind": "name", "source_book": "helios-consolidated",
                                 "source_ref": "Helios.Revenue.Q3", "format": "$0.0M"}},
                    {"slot": "kpi.ebitda", "kind": "text", "x": 60, "y": 240, "w": 280,
                     "h": 36, "size": 24, "placeholder": "[[kpi.ebitda]]",
                     "binding": {"label": "EBITDA", "prefix": "EBITDA: ",
                                 "source_kind": "name", "source_book": "helios-consolidated",
                                 "source_ref": "Helios.Ebitda.Q3", "format": "$0.0M"}},
                    {"slot": "kpi.netincome", "kind": "text", "x": 380, "y": 170, "w": 280,
                     "h": 36, "size": 24, "placeholder": "[[kpi.netincome]]",
                     "binding": {"label": "Net income", "prefix": "Net income: ",
                                 "source_kind": "name", "source_book": "helios-consolidated",
                                 "source_ref": "Helios.NetIncome.Q3", "format": "$0.0M"}},
                    {"slot": "kpi.fcf", "kind": "text", "x": 380, "y": 240, "w": 280,
                     "h": 36, "size": 24, "placeholder": "[[kpi.fcf]]",
                     "binding": {"label": "Free cash flow", "prefix": "Free cash flow: ",
                                 "source_kind": "name", "source_book": "helios-consolidated",
                                 "source_ref": "Helios.FreeCashFlow.Q3", "format": "$0.0M"}},
                    {"slot": "kpi.grossmargin", "kind": "text", "x": 700, "y": 170, "w": 200,
                     "h": 36, "size": 24, "placeholder": "[[kpi.grossmargin]]",
                     "binding": {"label": "Gross margin", "prefix": "Gross margin: ",
                                 "source_kind": "name", "source_book": "helios-consolidated",
                                 "source_ref": "Helios.GrossMargin.Pct", "format": "0.00%"}},
                    {"slot": "kpi.netmargin", "kind": "text", "x": 700, "y": 240, "w": 200,
                     "h": 36, "size": 24, "placeholder": "[[kpi.netmargin]]",
                     "binding": {"label": "Net margin", "prefix": "Net margin: ",
                                 "source_kind": "name", "source_book": "helios-consolidated",
                                 "source_ref": "Helios.NetMargin.Pct", "format": "0.00%"}},
                ],
            },
            {
                "layout": "titleOnly",
                "title": "P&L bridge (2026-09)",
                "frames": [
                    {"slot": "bridge.chart", "kind": "chart", "chart_type": "column",
                     "chart_title": "Scenarios", "x": 60, "y": 150, "w": 840, "h": 300,
                     "placeholder_categories": ["Base"], "placeholder_series": [{"name": "Net revenue", "values": [0.0]}],
                     "binding": {"label": "Scenario comparison", "source_kind": "range",
                                 "source_book": "helios-consolidated",
                                 "source_ref": "Scenarios!A1:C4", "format": "plain"}},
                    {"slot": "bridge.revenue", "kind": "text", "x": 60, "y": 470, "w": 300,
                     "h": 30, "size": 18, "placeholder": "[[bridge.revenue]]",
                     "binding": {"label": "Net revenue", "prefix": "Net revenue: ",
                                 "source_kind": "name", "source_book": "helios-consolidated",
                                 "source_ref": "Helios.Revenue.Q3", "format": "$0.0M"}},
                    {"slot": "bridge.ebitda", "kind": "text", "x": 400, "y": 470, "w": 300,
                     "h": 30, "size": 18, "placeholder": "[[bridge.ebitda]]",
                     "binding": {"label": "EBITDA", "prefix": "EBITDA: ",
                                 "source_kind": "name", "source_book": "helios-consolidated",
                                 "source_ref": "Helios.Ebitda.Q3", "format": "$0.0M"}},
                ],
            },
            {
                "layout": "titleOnly",
                "title": "Scenario comparison (2026-09)",
                "frames": [
                    {"slot": "scenario.base", "kind": "text", "x": 60, "y": 170, "w": 280,
                     "h": 36, "size": 24, "placeholder": "[[scenario.base]]",
                     "binding": {"label": "Base", "prefix": "Base: ", "source_kind": "cell",
                                 "source_book": "helios-consolidated",
                                 "source_ref": "Scenarios!B2", "format": "$0.0M"}},
                    {"slot": "scenario.upside", "kind": "text", "x": 380, "y": 170, "w": 280,
                     "h": 36, "size": 24, "placeholder": "[[scenario.upside]]",
                     "binding": {"label": "Upside", "prefix": "Upside: ", "source_kind": "cell",
                                 "source_book": "helios-consolidated",
                                 "source_ref": "Scenarios!B3", "format": "$0.0M"}},
                    {"slot": "scenario.downside", "kind": "text", "x": 700, "y": 170, "w": 200,
                     "h": 36, "size": 24, "placeholder": "[[scenario.downside]]",
                     "binding": {"label": "Downside", "prefix": "Downside: ", "source_kind": "cell",
                                 "source_book": "helios-consolidated",
                                 "source_ref": "Scenarios!B4", "format": "$0.0M"}},
                    {"slot": "scenario.footnote", "kind": "text", "x": 60, "y": 380, "w": 840,
                     "h": 40, "size": 18, "placeholder": FOOTNOTE},
                ],
            },
            {
                "layout": "titleOnly",
                "title": "Close reconciliation (2026-09)",
                "frames": [
                    {"slot": "close.reconciled", "kind": "text", "x": 60, "y": 170, "w": 400,
                     "h": 36, "size": 24, "placeholder": "[[close.reconciled]]",
                     "binding": {"label": "Reconciled net revenue", "prefix": "Reconciled net revenue: ",
                                 "source_kind": "name", "source_book": "close-reconciliation",
                                 "source_ref": "Helios.Close.Reconciled", "format": "$0.0M"}},
                    {"slot": "close.items", "kind": "text", "x": 60, "y": 240, "w": 400,
                     "h": 36, "size": 24, "placeholder": "[[close.items]]",
                     "binding": {"label": "Items raised", "prefix": "Items raised: ",
                                 "source_kind": "name", "source_book": "close-reconciliation",
                                 "source_ref": "Helios.Close.Items", "format": "$0K"}},
                    {"slot": "close.unresolved", "kind": "text", "x": 540, "y": 170, "w": 360,
                     "h": 36, "size": 24, "placeholder": "[[close.unresolved]]",
                     "binding": {"label": "Unresolved items", "prefix": "Unresolved: ",
                                 "source_kind": "name", "source_book": "close-reconciliation",
                                 "source_ref": "Helios.Close.Unresolved", "format": "$0K"}},
                    {"slot": "close.variance", "kind": "text", "x": 540, "y": 240, "w": 360,
                     "h": 36, "size": 24, "placeholder": "[[close.variance]]",
                     "binding": {"label": "Variance", "prefix": "Variance to the audited close: ",
                                 "source_kind": "name", "source_book": "close-reconciliation",
                                 "source_ref": "Helios.Close.Variance", "format": "$0K"}},
                    {"slot": "close.typed_by_hand", "kind": "text", "x": 60, "y": 320, "w": 400,
                     "h": 36, "size": 24, "placeholder": STALE_TEXT},
                ],
            },
        ],
    }


STAND_IN = '''"""A deterministic stand-in for the multimodal reviewer.

The production reviewer calls a vision model; this one reads the rendered
PNG with the standard library only, so the pipeline can be exercised
without a network and without a model.  It reproduces the two defects the
fixture was built to contain:

  * a footnote that runs off the bottom of the slide, which it finds by
    looking for ink in the bottom margin of the rendered image;
  * a figure that was typed into the deck by hand and disagrees with the
    workbook, which it replays from the defect table below.

Its first answer is deliberately malformed, so the pipeline has to refuse it
and ask again.
"""
import struct
import zlib
from pathlib import Path

#: The numeric mismatches the fixture contains.
DEFECTS = %(defects)s

#: The number of answers this module has given.
CALLS = {"n": 0}

#: The bottom margin, in rows, that is inspected for overflow.
MARGIN_ROWS = 12


def _rows(png):
    """The pixels of a PNG, as a list of rows of RGBA tuples."""
    width, height, depth, colour = struct.unpack(">IIBB", png[16:26])
    if depth != 8 or colour != 6:
        raise ValueError("the renderer did not answer with 8 bit RGBA")
    position = 8
    data = b""
    while position < len(png):
        length = struct.unpack(">I", png[position:position + 4])[0]
        kind = png[position + 4:position + 8]
        if kind == b"IDAT":
            data += png[position + 8:position + 8 + length]
        position += 12 + length
    raw = zlib.decompress(data)
    stride = width * 4
    lines = []
    previous = bytearray(stride)
    offset = 0
    for _ in range(height):
        filter_type = raw[offset]
        offset += 1
        line = bytearray(raw[offset:offset + stride])
        offset += stride
        for index in range(stride):
            left = line[index - 4] if index >= 4 else 0
            above = previous[index]
            corner = previous[index - 4] if index >= 4 else 0
            if filter_type == 1:
                line[index] = (line[index] + left) & 255
            elif filter_type == 2:
                line[index] = (line[index] + above) & 255
            elif filter_type == 3:
                line[index] = (line[index] + (left + above) // 2) & 255
            elif filter_type == 4:
                estimate = left + above - corner
                da, db, dc = (abs(estimate - left), abs(estimate - above),
                              abs(estimate - corner))
                if da <= db and da <= dc:
                    predictor = left
                elif db <= dc:
                    predictor = above
                else:
                    predictor = corner
                line[index] = (line[index] + predictor) & 255
        lines.append(bytes(line))
        previous = line
    return width, height, lines


def _bottom_ink(png):
    """The normalised box of the ink that sits in the bottom margin."""
    width, height, lines = _rows(png)
    top = height - MARGIN_ROWS
    left, right, bottom = None, None, None
    for y in range(top, height):
        line = lines[y]
        for x in range(width):
            pixel = line[x * 4:x * 4 + 4]
            if pixel[3] == 0:
                continue
            if pixel[0] > 245 and pixel[1] > 245 and pixel[2] > 245:
                continue
            if left is None or x < left:
                left = x
            if right is None or x > right:
                right = x
            if bottom is None or y > bottom:
                bottom = y
    if left is None:
        return None
    return {
        "x": round(left / float(width), 4),
        "y": round(top / float(height), 4),
        "w": round((right - left + 1) / float(width), 4),
        "h": round((bottom - top + 1) / float(height), 4),
    }


def review(png_path, ground_truth):
    """The verdict of one rendered slide."""
    CALLS["n"] += 1
    if CALLS["n"] == 1:
        # A malformed answer: the pipeline has to refuse it and ask again.
        return "the slide looks fine to me"
    slide_index = int(ground_truth.get("slide_index", 0))
    findings = []
    overflow = _bottom_ink(Path(png_path).read_bytes())
    if overflow is not None:
        findings.append({
            "kind": "text_overflow",
            "severity": "high",
            "slide_index": slide_index,
            "region": overflow,
            "detail": "the footnote runs off the bottom of the slide",
        })
    for defect in DEFECTS:
        if int(defect["slide_index"]) != slide_index:
            continue
        findings.append({
            "kind": "numeric_mismatch",
            "severity": "high",
            "slide_index": slide_index,
            "region": defect["region"],
            "detail": "the figure on the slide disagrees with the audited workbook",
            "expected": defect["expected"],
            "observed": defect["observed"],
        })
    return {
        "findings": findings,
        "overall_assessment": "reviewed against the audited figures",
        "iteration_suggestion": "correct what can be corrected, escalate the rest",
    }
'''


def write_stand_in(directory: Path, defects: List[Dict[str, Any]]) -> Path:
    """Write the deterministic reviewer and return its module path."""
    directory.mkdir(parents=True, exist_ok=True)
    path = directory / "stand_in_reviewer.py"
    path.write_text(STAND_IN % {"defects": json.dumps(defects, indent=4)}, encoding="utf-8")
    return path


# --------------------------------------------------------------------------
# Helpers
# --------------------------------------------------------------------------
def sha256_of(path: Path) -> str:
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def contract_spec(text: str, interface: str) -> List[Tuple[str, bool]]:
    """The fields of one interface of the published TypeScript contract.

    A field the contract marks with a question mark is optional.
    """
    match = re.search(r"interface\s+%s\s*\{(.*?)\n\}" % interface, text, re.S)
    if not match:
        return []
    spec = []
    for name, optional in re.findall(
            r"^\s*([A-Za-z_][A-Za-z0-9_]*)(\??)\s*:", match.group(1), re.M):
        spec.append((name, bool(optional)))
    return spec


def contract_fields(text: str, interface: str) -> List[str]:
    """The required field names of one interface of the published contract."""
    return [name for name, optional in contract_spec(text, interface) if not optional]


def deck_shapes(deck_path: Path) -> List[Dict[str, Any]]:
    """Every shape of the published deck, read back by the engine."""
    client = MCPClient(["deckcraft-cli", "mcp", "--automation-read-root", str(deck_path.parent),
                        "--automation-write-root", str(deck_path.parent)], cwd=str(deck_path.parent))
    shapes: List[Dict[str, Any]] = []
    try:
        client.request(
            "initialize",
            {"protocolVersion": "2024-11-05", "capabilities": {},
             "clientInfo": {"name": "run-ex5-verify", "version": "1.0"}},
        )
        client.tool("open_presentation", {"path": str(deck_path)})
        document = client.tool("inspect_document", {}) or {}
        for slide in document.get("slides", []):
            index = int(slide.get("index", 0))
            detail = client.tool("inspect_slide", {"index": index}) or {}
            for shape in detail.get("shapes", []):
                entry = dict(shape)
                entry["slide_index"] = index
                shapes.append(entry)
    finally:
        client.close()
    return shapes


def workbook_values(path: Path) -> Dict[str, Any]:
    """The defined names of a workbook, with the values the engine computed."""
    client = MCPClient(["gridcraft-cli", "mcp"], cwd=str(path.parent))
    try:
        client.request(
            "initialize",
            {"protocolVersion": "2024-11-05", "capabilities": {},
             "clientInfo": {"name": "run-ex5-verify", "version": "1.0"}},
        )
        client.tool("open_workbook", {"path": str(path)})
        names = client.command("formulas.nameManager", {}) or []
        audit = client.command("formulas.errorChecking", {}) or {}
        return {"names": {entry["name"]: entry.get("value") for entry in names},
                "audit": audit}
    finally:
        client.close()


# --------------------------------------------------------------------------
# The run
# --------------------------------------------------------------------------
def main() -> int:
    if CLIS.is_dir():
        os.environ["PATH"] = "%s%s%s" % (CLIS, os.pathsep, os.environ.get("PATH", ""))
    if shutil.which("gridcraft-cli") is None or shutil.which("deckcraft-cli") is None:
        print("FAIL the ArtCraft CLIs are not on PATH")
        print("0 assertions passed")
        return 1

    keep = "--keep" in sys.argv
    # The artefacts are kept next to the code, the way every other
    # project in the repository keeps them.
    work = Path(__file__).resolve().parent.parent / "output" / "work"
    if work.exists():
        shutil.rmtree(work)
    work.mkdir(parents=True, exist_ok=True)
    try:
        return run(work, keep)
    finally:
        print("work directory: %s" % work, file=sys.stderr)


def run(work: Path, keep: bool) -> int:
    fixtures = work / "fixtures"
    out_dir = work / "out"
    reviewers = work / "reviewers"
    fixtures.mkdir(parents=True, exist_ok=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    # -- the fixtures ------------------------------------------------------
    consolidated = fixtures / "helios-consolidated.xlsx"
    reconciliation = fixtures / "close-reconciliation.xlsx"
    audit = build_workbook(consolidated, CONSOLIDATED_SHEETS, CONSOLIDATED_NAMES)
    close_audit = build_workbook(reconciliation, RECONCILIATION_SHEETS, RECONCILIATION_NAMES)
    template = build_template()
    (fixtures / "deck-template.json").write_text(json.dumps(template, indent=2), encoding="utf-8")

    check("the fixture workbooks are real xlsx containers",
          zipfile.is_zipfile(consolidated) and zipfile.is_zipfile(reconciliation))
    check("the fixture workbooks hold no calculation error",
          not (audit["audit"].get("errors") or []) and not (audit["audit"].get("circular") or [])
          and not (close_audit["audit"].get("errors") or []),
          json.dumps({"consolidated": audit["audit"], "close": close_audit["audit"]})[:300])
    check("the consolidated workbook carries its named ranges",
          sorted(entry["name"] for entry in audit["names"])
          == sorted(name for name, _ in CONSOLIDATED_NAMES),
          json.dumps([entry["name"] for entry in audit["names"]]))
    check("the close workbook carries its named ranges",
          sorted(entry["name"] for entry in close_audit["names"])
          == sorted(name for name, _ in RECONCILIATION_NAMES),
          json.dumps([entry["name"] for entry in close_audit["names"]]))
    check("the template names the two source workbooks",
          sorted(template["sources"]) == ["close-reconciliation", "helios-consolidated"])

    values = workbook_values(consolidated)["names"]
    check("the engine computes the net revenue of the fixture",
          abs(values.get("Helios.Revenue.Q3", 0.0) - EXPECTED["revenue"]) <= 1e-6,
          str(values.get("Helios.Revenue.Q3")))
    check("the engine computes the net margin of the fixture",
          abs(values.get("Helios.NetMargin.Pct", 0.0) - EXPECTED["net_margin"]) <= 1e-9,
          str(values.get("Helios.NetMargin.Pct")))
    digests = {"consolidated": sha256_of(consolidated), "reconciliation": sha256_of(reconciliation)}

    # -- the deterministic reviewer ---------------------------------------
    stale_region = {
        "x": round(60 / 960.0, 4),
        "y": round(320 / 540.0, 4),
        "w": round(400 / 960.0, 4),
        "h": round(36 / 540.0, 4),
    }
    write_stand_in(reviewers, [{
        "slide_index": 3,
        "region": stale_region,
        "expected": "$164.2M",
        "observed": "$168.4M",
    }])
    environment = dict(os.environ)
    environment["PYTHONPATH"] = str(reviewers) + os.pathsep + environment.get("PYTHONPATH", "")

    # -- the agent ---------------------------------------------------------
    completed = subprocess.run(
        [sys.executable, str(SOLUTION),
         "--fixtures", str(fixtures), "--out", str(out_dir),
         "--reviewer", "stand_in_reviewer:review"],
        capture_output=True, text=True, timeout=900, env=environment,
    )
    check("the agent exits cleanly", completed.returncode == 0,
          "exit=%d %s" % (completed.returncode, completed.stderr[-500:]))
    check("the agent writes nothing to stderr", completed.stderr.strip() == "",
          completed.stderr[-500:])
    try:
        summary = json.loads(completed.stdout)
    except json.JSONDecodeError:
        summary = {}
    check("the agent reports what it did",
          summary.get("iterations") == 2 and summary.get("termination") == "blocking-only"
          and summary.get("converged") is False
          and summary.get("blocking_issues") == 1
          and summary.get("bound_slots") == 16,
          completed.stdout[-500:])

    # -- the artefacts -----------------------------------------------------
    deck_path = (out_dir / "helios-board-2026-09.deck").resolve()
    pdf_path = (out_dir / "helios-board-2026-09.pdf").resolve()
    map_path = (out_dir / "bindings.json").resolve()
    report_path = (out_dir / "deck-audit-report.json").resolve()
    markdown_path = (out_dir / "deck-audit-report.md").resolve()
    if not check("the audit report exists", report_path.is_file()):
        print("0 assertions passed")
        return 1
    report = json.loads(report_path.read_text())
    check("the published deck exists", deck_path.is_file())
    check("the published PDF exists and is a PDF",
          pdf_path.is_file() and pdf_path.read_bytes()[:4] == b"%PDF")
    check("the binding map exists", map_path.is_file())
    check("the readable audit report exists", markdown_path.is_file())
    check("the binding map is published next to the deck",
          json.loads(map_path.read_text()).get("deck_path") == str(deck_path))
    check("the published deck is a deckcraft container", zipfile.is_zipfile(deck_path))

    # -- the published contract -------------------------------------------
    binding_text = CONTRACT_BINDINGS.read_text()
    report_text = CONTRACT_REPORT.read_text()
    bindings = json.loads(map_path.read_text())
    for interface, payload, source in (
            ("BindingMap", bindings, binding_text),
            ("BindingEntry", (bindings.get("entries") or [{}])[0], binding_text),
            ("DeckAuditReport", report, report_text)):
        fields = contract_fields(source, interface)
        check("the %s carries every published field" % interface,
              bool(fields) and all(field in payload for field in fields),
              str([field for field in fields if field not in payload]))
    records = [record for iteration in report["iterations"] for record in iteration["records"]]
    check("every iteration record carries every published field",
          bool(records) and all(
              all(field in record for field in contract_fields(report_text, "IterationRecord"))
              for record in records),
          str([field for field in contract_fields(report_text, "IterationRecord")
               if records and field not in records[0]]))
    parsed = [record["vision_parsed"] for record in records]
    check("every vision answer carries every published field",
          bool(parsed) and all(
              all(field in answer for field in contract_fields(report_text, "VisionResponse"))
              for answer in parsed))
    findings = [finding for answer in parsed for finding in answer["findings"]]
    check("every finding carries every published field",
          bool(findings) and all(
              all(field in finding for field in contract_fields(report_text, "VisionFinding"))
              for finding in findings),
          str([field for field in contract_fields(report_text, "VisionFinding")
               if findings and field not in findings[0]]))
    check("the optional fields of a finding are the ones the contract marks optional",
          all(all(name in finding for name, optional in contract_spec(report_text, "VisionFinding")
                  if not optional)
              for finding in findings))
    check("the binding map names every bound frame of the deck",
          len(bindings["entries"]) == 16
          and all(entry.get("refresh_command") in ("text.set", "chart.data")
                  for entry in bindings["entries"]),
          json.dumps([entry.get("refresh_command") for entry in bindings["entries"]]))
    commands = report.get("commands") or {}
    check("the report publishes the command ids the engines exposed",
          commands.get("deckcraft", {}).get("set_text") == "text.set"
          and commands.get("deckcraft", {}).get("chart_data") == "chart.data"
          and commands.get("deckcraft", {}).get("export") == "file.export"
          and commands.get("gridcraft", {}).get("names") == "formulas.nameManager"
          and commands.get("gridcraft", {}).get("read") == "sheet.read",
          json.dumps(commands)[:300])

    # -- the deck, read back by the engine ---------------------------------
    shapes = deck_shapes(deck_path)
    by_name = {shape.get("name"): shape for shape in shapes}
    check("the engine re-opens the deck with its four slides",
          len({shape["slide_index"] for shape in shapes}) == 4, str(len(shapes)))
    check("every bound frame of the binding map exists in the deck",
          all(any(int(shape["id"]) == int(entry["deck_frame_id"]) for shape in shapes)
              for entry in bindings["entries"]))
    check("the deck carries the net revenue of the workbook",
          by_name.get("kpi.revenue", {}).get("text") == "Net revenue: $164.2M",
          json.dumps(by_name.get("kpi.revenue")))
    check("the deck carries the EBITDA of the workbook",
          by_name.get("kpi.ebitda", {}).get("text") == "EBITDA: $40.2M",
          json.dumps(by_name.get("kpi.ebitda")))
    check("the deck carries the net income of the workbook",
          by_name.get("kpi.netincome", {}).get("text") == "Net income: $16.9M",
          json.dumps(by_name.get("kpi.netincome")))
    check("the deck carries the free cash flow of the workbook",
          by_name.get("kpi.fcf", {}).get("text") == "Free cash flow: $8.0M",
          json.dumps(by_name.get("kpi.fcf")))
    check("the deck carries the net margin of the workbook",
          by_name.get("kpi.netmargin", {}).get("text") == "Net margin: 10.27%",
          json.dumps(by_name.get("kpi.netmargin")))
    check("the deck carries the scenarios of the workbook",
          by_name.get("scenario.base", {}).get("text") == "Base: $164.2M"
          and by_name.get("scenario.upside", {}).get("text") == "Upside: $177.3M"
          and by_name.get("scenario.downside", {}).get("text") == "Downside: $152.7M",
          json.dumps([by_name.get(name, {}).get("text")
                      for name in ("scenario.base", "scenario.upside", "scenario.downside")]))
    check("the deck carries the close of the workbook",
          by_name.get("close.reconciled", {}).get("text") == "Reconciled net revenue: $164.3M"
          and by_name.get("close.items", {}).get("text") == "Items raised: $125K"
          and by_name.get("close.unresolved", {}).get("text") == "Unresolved: $40K"
          and by_name.get("close.variance", {}).get("text") == "Variance to the audited close: $85K",
          json.dumps([by_name.get(name, {}).get("text") for name in
                      ("close.reconciled", "close.items", "close.unresolved", "close.variance")]))
    chart = next((shape for shape in shapes if shape.get("kind") == "chart"), None)
    check("the chart of the deck carries the scenario range of the workbook",
          chart is not None
          and [category for category in (chart.get("chart") or {}).get("categories", [])]
          == ["Base", "Upside", "Downside"]
          and abs((chart["chart"]["series"][0]["values"][0]) - EXPECTED["revenue"]) <= 1e-6,
          json.dumps(chart.get("chart"))[:300])

    # -- the audit loop ----------------------------------------------------
    check("the loop stopped after two iterations", len(report["iterations"]) == 2,
          str(len(report["iterations"])))
    check("the loop terminated with the human review queue",
          report["termination_reason"] == "blocking-only" and report["converged"] is False)
    check("the loop never exceeded its iteration budget",
          all(iteration["iteration"] <= 5 for iteration in report["iterations"]))
    check("every iteration recorded the screenshot of every slide",
          all(len(iteration["records"]) == 4 for iteration in report["iterations"]))
    check("every recorded screenshot is on disk with the recorded hash",
          all(Path(record["screenshot_path"]).is_file()
              and sha256_of(Path(record["screenshot_path"])) == record["screenshot_sha256"]
              and Path(record["post_screenshot_path"]).is_file()
              and sha256_of(Path(record["post_screenshot_path"])) == record["new_screenshot_sha256"]
              for iteration in report["iterations"] for record in iteration["records"]))
    check("the screenshots are named after the iteration and the slide",
          all((out_dir / "audit-screenshots" / ("iter-%d-slide-%d.png" % (iteration["iteration"], record["slide_index"]))).is_file()
              for iteration in report["iterations"] for record in iteration["records"]))

    # -- the bounded correction --------------------------------------------
    applied = [command for iteration in report["iterations"]
               for record in iteration["records"]
               for command in record["applied_batch"]["commands"]]
    check("the correction batch moved and restyled frames", len(applied) > 0,
          str(applied))
    check("no correction ever wrote text",
          all(command.get("command") not in ("text.set", "text.edit", "text.insert", "edit.pasteText")
              for command in applied),
          json.dumps([command.get("command") for command in applied]))
    check("no correction touched the frame of the hand typed figure",
          all(int((command.get("params") or {}).get("id", -1))
              != int(by_name.get("close.typed_by_hand", {}).get("id", -2))
              for command in applied),
          json.dumps([command.get("params") for command in applied]))
    check("the hand typed figure is still in the deck, untouched",
          by_name.get("close.typed_by_hand", {}).get("text") == STALE_TEXT,
          json.dumps(by_name.get("close.typed_by_hand")))
    footnote = by_name.get("scenario.footnote", {})
    check("the overflowing footnote was moved back inside the slide",
          float(footnote.get("box", [0, 0, 0, 0])[1]) < 380.0,
          json.dumps(footnote.get("box")))
    overflow_record = next((record for iteration in report["iterations"]
                            for record in iteration["records"]
                            if record["slide_index"] == 2), None)
    check("the corrected slide was rendered again after the correction",
          overflow_record is not None
          and overflow_record["new_screenshot_sha256"] != overflow_record["screenshot_sha256"],
          json.dumps(overflow_record and overflow_record["screenshot_sha256"]))
    second_iteration = report["iterations"][1]
    first_iteration = report["iterations"][0]
    check("the forensic chain joins the two iterations",
          all(record["new_screenshot_sha256"] == other["screenshot_sha256"]
              for record, other in zip(first_iteration["records"], second_iteration["records"])),
          json.dumps([record["new_screenshot_sha256"] for record in first_iteration["records"]]))

    # -- the review queue and the schema ----------------------------------
    queue = report.get("human_review_queue") or []
    check("the numeric mismatch was routed to the human review queue",
          len(queue) == 1 and queue[0]["kind"] == "numeric_mismatch"
          and queue[0]["severity"] == "blocking",
          json.dumps(queue)[:300])
    check("the escalation names the figure and the reason",
          queue and queue[0].get("expected") == "$164.2M"
          and queue[0].get("observed") == "$168.4M"
          and "source of truth" in (queue[0].get("reason") or ""),
          json.dumps(queue)[:300])
    check("the malformed reviewer answer was refused and asked again",
          any(record.get("vision_attempts", 1) > 1 for record in records)
          and any(record.get("vision_refusals") for record in records),
          json.dumps([(record.get("vision_attempts"), record.get("vision_refusals"))
                      for record in records])[:400])
    check("the report keeps the raw answer of the reviewer",
          all(isinstance(record["vision_raw"], str) and record["vision_raw"].startswith("{")
              for record in records))

    # -- the sources are untouched ----------------------------------------
    check("the source workbooks are byte-identical after the run",
          sha256_of(consolidated) == digests["consolidated"]
          and sha256_of(reconciliation) == digests["reconciliation"])
    after = workbook_values(consolidated)
    check("the engine's own audit of the sources is still clean",
          not (after["audit"].get("errors") or [])
          and not (after["audit"].get("circular") or []),
          json.dumps(after["audit"]))

    # -- a reviewer that never answers -------------------------------------
    broken_dir = work / "reviewers-broken"
    broken_dir.mkdir(parents=True, exist_ok=True)
    (broken_dir / "broken_reviewer.py").write_text(
        'def review(png_path, ground_truth):\n'
        '    return "I could not read the slide"\n',
        encoding="utf-8")
    broken_env = dict(os.environ)
    broken_env["PYTHONPATH"] = str(broken_dir) + os.pathsep + broken_env.get("PYTHONPATH", "")
    broken_out = work / "out-broken"
    broken = subprocess.run(
        [sys.executable, str(SOLUTION),
         "--fixtures", str(fixtures), "--out", str(broken_out),
         "--reviewer", "broken_reviewer:review"],
        capture_output=True, text=True, timeout=900, env=broken_env,
    )
    check("a reviewer that never answers stops the run", broken.returncode == 1,
          "exit=%d %s" % (broken.returncode, broken.stderr[-300:]))
    broken_report_path = broken_out / "deck-audit-report.json"
    if check("the failed run still leaves an audit report", broken_report_path.is_file()):
        broken_report = json.loads(broken_report_path.read_text())
        check("the failed run says why it stopped",
              broken_report.get("termination_reason") == "error"
              and bool(broken_report.get("failure")),
              json.dumps(broken_report.get("failure"))[:300])
        check("the failed run published no verdict it did not get",
              all(not iteration["records"] or all(record["vision_refusals"] for record in iteration["records"])
                  for iteration in broken_report.get("iterations", [])),
              json.dumps(broken_report.get("iterations"))[:300])

    # -- determinism -------------------------------------------------------
    second_dir = work / "out-second"
    second = subprocess.run(
        [sys.executable, str(SOLUTION),
         "--fixtures", str(fixtures), "--out", str(second_dir),
         "--reviewer", "stand_in_reviewer:review"],
        capture_output=True, text=True, timeout=900, env=environment,
    )
    check("the agent runs again cleanly", second.returncode == 0, second.stderr[-400:])
    if second.returncode == 0:
        second_text = (second_dir / "deck-audit-report.json").read_text()
        second_text = second_text.replace(str(second_dir), str(out_dir))
        second_report = json.loads(second_text)
        first = {key: value for key, value in report.items() if key != "total_wall_clock_ms"}
        again = {key: value for key, value in second_report.items() if key != "total_wall_clock_ms"}
        check("the second run produces the same report", first == again,
              "the reports differ")
        check("the second run renders the same slides",
              [record["screenshot_sha256"] for iteration in report["iterations"]
               for record in iteration["records"]]
              == [record["screenshot_sha256"] for iteration in second_report["iterations"]
                  for record in iteration["records"]])

    # -- the late breaking adjustment -------------------------------------
    client = MCPClient(["gridcraft-cli", "mcp"], cwd=str(fixtures))
    try:
        client.request(
            "initialize",
            {"protocolVersion": "2024-11-05", "capabilities": {},
             "clientInfo": {"name": "run-ex5-adjust", "version": "1.0"}},
        )
        client.tool("open_workbook", {"path": str(consolidated)})
        client.command("cell.set", {"sheet": "Consolidated", "cell": "B4", "input": 173_400_000.0})
        client.command("formulas.calculateNow", {})
        client.tool("save_workbook", {"path": str(consolidated)})
    finally:
        client.close()
    adjusted = workbook_values(consolidated)["names"]
    check("the synthetic adjustment moved the net revenue of the workbook",
          abs(adjusted.get("Helios.Revenue.Q3", 0.0) - 169_200_000.0) <= 1e-6,
          str(adjusted.get("Helios.Revenue.Q3")))

    refreshed = subprocess.run(
        [sys.executable, str(SOLUTION),
         "--fixtures", str(fixtures), "--out", str(out_dir), "--mode", "refresh"],
        capture_output=True, text=True, timeout=900, env=environment,
    )
    check("the binding pass runs again cleanly", refreshed.returncode == 0,
          "exit=%d %s" % (refreshed.returncode, refreshed.stderr[-400:]))
    try:
        refresh_summary = json.loads(refreshed.stdout)
    except json.JSONDecodeError:
        refresh_summary = {}
    check("the binding pass reports what it refreshed",
          refresh_summary.get("refreshed") == 16, refreshed.stdout[-300:])
    shapes_after = deck_shapes(deck_path)
    by_name_after = {shape.get("name"): shape for shape in shapes_after}
    check("the deck followed the workbook after the adjustment",
          by_name_after.get("kpi.revenue", {}).get("text") == "Net revenue: $169.2M",
          json.dumps(by_name_after.get("kpi.revenue")))
    check("the close slide followed the workbook after the adjustment",
          by_name_after.get("close.reconciled", {}).get("text") == "Reconciled net revenue: $164.3M",
          json.dumps(by_name_after.get("close.reconciled")))
    check("the hand typed figure is still untouched after the refresh",
          by_name_after.get("close.typed_by_hand", {}).get("text") == STALE_TEXT,
          json.dumps(by_name_after.get("close.typed_by_hand")))
    check("the refresh left the binding map in place",
          json.loads(map_path.read_text()).get("entries") is not None)

    if FAILURES:
        print("FAILED: %s" % ", ".join(FAILURES))

    # --- publish the headline artefacts next to the harness log ------------
    publish = work.parent
    shutil.copy2(out_dir / "helios-board-2026-09.deck", publish / "helios-board-2026-09.deck")
    shutil.copy2(out_dir / "helios-board-2026-09.pdf", publish / "helios-board-2026-09.pdf")
    shutil.copy2(out_dir / "bindings.json", publish / "bindings.json")
    shutil.copy2(out_dir / "deck-audit-report.json", publish / "deck-audit-report.json")

    print("%d assertions passed" % PASSED)
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
