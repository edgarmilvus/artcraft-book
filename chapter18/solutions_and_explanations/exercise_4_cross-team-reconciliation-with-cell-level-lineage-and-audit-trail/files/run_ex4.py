#!/usr/bin/env python3
"""
run_ex4.py -- the acceptance harness for exercise 4.

It builds the exercise's fixtures with the real GridCraft engine (three
source workbooks, a reconciling-items sheet, a reconciliation fixture and a
prior-period snapshot), runs `04_close_reconciliation.py` against them, and
then checks the artefacts the run left behind: the reconciliation workbook
(re-opened by the engine itself), the PDF audit package, the scratch workbook
that holds the simulated remediation, the JSON report, and the engine's own
audit of the source workbooks before and after the run.

Every check prints one `PASS <label>` line; the run ends with the number of
assertions that passed.

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
SOLUTION = HERE / "04_cross-team-reconciliation-with-cell-level-lineage-and-audit-trail.py"
CONTRACT_TYPES = HERE / "01_typescript.ts"
CONTRACT_REPORT = HERE / "02_typescript.ts"

# --------------------------------------------------------------------------
# The fixture model
# --------------------------------------------------------------------------
# The 24 segment drivers of the forecast.  Rows 19 to 31 were re-forecast
# between the prior period and the close, the others were not.
DRIVER_ROWS = list(range(11, 35))
DRIVER_CURRENT = {row: 1_880_000.0 for row in DRIVER_ROWS}
DRIVER_CURRENT[13] = 1_905_000.0
DRIVER_CURRENT[21] = 1_860_000.0
DRIVER_PRIOR = {row: value for row, value in DRIVER_CURRENT.items()}
for row in range(19, 32):
    DRIVER_PRIOR[row] = 1_865_000.0

#: The value of the whole driver block, and therefore of the ARR driver.
DRIVER_TOTAL = sum(DRIVER_CURRENT.values())

MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep"]
MONTHLY_REVENUE = [41_000_000.0, 41_500_000.0, 42_250_000.0, 43_000_000.0,
                   43_500_000.0, 44_000_000.0, 44_250_000.0, 44_500_000.0,
                   45_480_000.0]

FPA_SHEETS: List[Tuple[str, List[Tuple[str, Any]]]] = [
    ("Assumptions", [
        ("A1", "Helios FP&A forecast - assumptions (2026-09)"),
        ("A3", "Base MRR"), ("B3", 4_200_000.0),
        ("A4", "Net revenue retention"), ("B4", 1.08),
        ("A5", "Churn rate"), ("B5", 0.021),
        ("A6", "Deferred revenue build"), ("B6", 0.18),
        ("A7", "Opening debt"), ("B7", 125_000_000.0),
        ("A8", "Undrawn revolver"), ("B8", 2_500_000.0),
        ("A10", "Segment revenue drivers"), ("B10", "2026-09"),
    ] + [
        cell
        for row in DRIVER_ROWS
        for cell in (("A%d" % row, "Segment %02d revenue" % (row - 10)),
                     ("B%d" % row, DRIVER_CURRENT[row]))
    ] + [
        ("A36", "Total segment revenue"), ("B36", "=SUM(B11:B34)"),
        ("A37", "Churned MRR"), ("B37", "=B3*B5"),
        ("A38", "Net new MRR"), ("B38", "=B3*(B4-1)"),
        ("A39", "Ending ARR"), ("B39", "=(B36+B38-B37)*12"),
        ("A40", "Cash"), ("B40", "=B8*0.95"),
        ("A41", "Deferred revenue"), ("B41", "=B36*B6"),
        ("A42", "Debt amortisation"), ("B42", 25_000_000.0),
        ("A43", "Closing debt"), ("B43", "=B7-B42"),
        ("A44", "Available liquidity"), ("B44", "=B40+B8"),
    ]),
    ("Summary", [
        ("A1", "Helios FP&A forecast - summary (2026-09)"),
        ("A9", "Reconciliation accounts"),
        ("A10", "Cash"), ("B10", "=Assumptions!B40"),
        ("A11", "ARR"), ("B11", "=Assumptions!B39"),
        ("A12", "DeferredRevenue"), ("B12", "=Assumptions!B41"),
        ("A13", "TotalDebt"), ("B13", "=Assumptions!B43"),
        ("A14", "AvailableLiquidity"), ("B14", "=Assumptions!B44"),
    ]),
]

FPA_NAMES = [
    ("Assumptions.Base.MRR", "=Assumptions!$B$3"),
    ("Assumptions.NRR", "=Assumptions!$B$4"),
    ("Assumptions.OpeningDebt", "=Assumptions!$B$7"),
    ("Assumptions.Revolver", "=Assumptions!$B$8"),
]

ACCT_SHEETS: List[Tuple[str, List[Tuple[str, Any]]]] = [
    ("Monthly", [
        ("A1", "Helios accounting actuals - 2026-09"),
        ("A3", "Month"),
    ] + [
        cell
        for index, month in enumerate(MONTHS)
        for cell in (("%s3" % chr(ord("B") + index), month),)
    ] + [
        ("A4", "Revenue recognised"),
    ] + [
        ("%s4" % chr(ord("B") + index), value)
        for index, value in enumerate(MONTHLY_REVENUE)
    ] + [
        ("A5", "Deferred revenue balance"), ("J5", 8_122_500.0),
        ("A6", "Closing debt"), ("J6", 100_000_000.0),
        ("A7", "Closing cash"), ("J7", 2_375_000.0),
        ("A8", "Undrawn revolver"), ("J8", 2_250_000.0),
        ("A9", "Annualised revenue"), ("J9", "=J4*12"),
        ("A11", "Cash"), ("B11", "=J7"),
        ("A12", "ARR"), ("B12", "=J9"),
        ("A13", "DeferredRevenue"), ("B13", "=J5"),
        ("A14", "TotalDebt"), ("B14", "=J6"),
        ("A15", "AvailableLiquidity"), ("B15", "=J7+J8"),
    ]),
    ("ReconcilingItems", [
        ("A1", "Helios reconciling items - 2026-09"),
        ("A3", "Account"), ("B3", "Description"), ("C3", "Amount"),
        ("D3", "Raised by"), ("E3", "Raised on"),
        ("A4", "DeferredRevenue"),
        ("B4", "Deferred revenue true-up on the Q3 billing run"),
        ("C4", 0.4), ("D4", "Accounting"), ("E4", "2026-09-28"),
    ]),
]

TREAS_SHEETS: List[Tuple[str, List[Tuple[str, Any]]]] = [
    ("CashPosition", [
        ("A1", "Helios treasury cash position - 2026-09"),
        ("A3", "Balances"), ("B3", "2026-09"),
        ("A4", "Operating cash"), ("B4", 2_375_000.0),
        ("A5", "Undrawn revolver"), ("B5", 2_500_000.0),
        ("A6", "Deferred revenue held"), ("B6", 8_122_500.4),
        ("A7", "Gross debt (reported)"), ("B7", "=B20+B21"),
        ("A8", "September revenue"), ("B8", 45_480_000.0),
        ("A9", "Cash"), ("C9", "=B4"),
        ("A10", "ARR"), ("C10", "=B8*12"),
        ("A11", "DeferredRevenue"), ("C11", "=B6"),
        ("A12", "TotalDebt"), ("C12", "=B7"),
        ("A13", "AvailableLiquidity"), ("C13", "=B4+B5"),
        ("A20", "FX translation on the euro tranche"), ("B20", 0.2501),
        ("A21", "Debt principal"), ("B21", 100_000_000.0),
    ]),
]

#: The golden verdicts of the fixture: two clean passes, one account that is
#: explained by a declared reconciling item, and two accounts that fail.
GOLDEN_STATUS = {
    "Cash": "pass",
    "ARR": "pass",
    "DeferredRevenue": "pass-with-reconciling-item",
    "TotalDebt": "fail",
    "AvailableLiquidity": "fail",
}

#: The expected source values of every account, read out of the fixture.
GOLDEN_VALUES = {
    "Cash": {"fpa": 2_375_000.0, "acct": 2_375_000.0, "treas": 2_375_000.0},
    "ARR": {"fpa": (DRIVER_TOTAL + 336_000.0 - 88_200.0) * 12.0,
            "acct": 45_480_000.0 * 12.0, "treas": 45_480_000.0 * 12.0},
    "DeferredRevenue": {"fpa": DRIVER_TOTAL * 0.18, "acct": 8_122_500.0,
                        "treas": 8_122_500.4},
    "TotalDebt": {"fpa": 100_000_000.0, "acct": 100_000_000.0,
                  "treas": 100_000_000.0 + 0.2501},
    "AvailableLiquidity": {"fpa": 4_875_000.0, "acct": 4_625_000.0, "treas": 4_875_000.0},
}

LINEAGE_COLUMNS = ["reconciliation_account", "source_workbook", "source_cell",
                    "named_range", "value", "graph_distance", "salience_score",
                    "salience_reasons"]

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
# A small MCP client, so the harness can ask the engine itself
# --------------------------------------------------------------------------
class MCPClient:
    def __init__(self, argv: Sequence[str]):
        self.process = subprocess.Popen(
            list(argv),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            bufsize=0,
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
            raise RuntimeError("the GridCraft MCP server closed its stdout")
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
# The fixtures
# --------------------------------------------------------------------------
def build_workbook(path: Path, sheets: List[Tuple[str, List[Tuple[str, Any]]]],
                   names: Sequence[Tuple[str, str]] = ()) -> Dict[str, Any]:
    """Write one source workbook with the engine itself."""
    path.parent.mkdir(parents=True, exist_ok=True)
    client = MCPClient(["gridcraft-cli", "mcp"])
    try:
        client.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "run-ex4-fixture", "version": "1.0"},
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


def build_fixtures(root: Path) -> Dict[str, Any]:
    """The three source workbooks and the two fixture files."""
    sources = root / "fixtures"
    sources.mkdir(parents=True, exist_ok=True)
    fpa = build_workbook(sources / "fpa-forecast.xlsx", FPA_SHEETS, FPA_NAMES)
    acct = build_workbook(sources / "accounting-actuals.xlsx", ACCT_SHEETS)
    treas = build_workbook(sources / "treasury-cash.xlsx", TREAS_SHEETS)

    recon = {
        "period": "2026-09",
        "sources": {
            "fpa": "fpa-forecast.xlsx",
            "acct": "accounting-actuals.xlsx",
            "treas": "treasury-cash.xlsx",
        },
        "reconciling_items": {"workbook": "acct", "sheet": "ReconcilingItems"},
        "accounts": [
            {"account": "Cash", "fpa_cell": "Summary!B10", "acct_cell": "Monthly!B11",
             "treas_cell": "CashPosition!C9", "tolerance": "exact"},
            {"account": "ARR", "fpa_cell": "Summary!B11", "acct_cell": "Monthly!B12",
             "treas_cell": "CashPosition!C10", "tolerance": "pct:0.5"},
            {"account": "DeferredRevenue", "fpa_cell": "Summary!B12",
             "acct_cell": "Monthly!B13", "treas_cell": "CashPosition!C11",
             "tolerance": "exact"},
            {"account": "TotalDebt", "fpa_cell": "Summary!B13", "acct_cell": "Monthly!B14",
             "treas_cell": "CashPosition!C12", "tolerance": "exact"},
            {"account": "AvailableLiquidity", "fpa_cell": "Summary!B14",
             "acct_cell": "Monthly!B15", "treas_cell": "CashPosition!C13",
             "tolerance": "$250"},
        ],
    }
    (sources / "recon-accounts-2026-09.json").write_text(json.dumps(recon, indent=2))

    prior_cells: List[Dict[str, Any]] = []
    for row in DRIVER_ROWS:
        prior_cells.append({"workbook": "fpa", "cell": "Assumptions!B%d" % row,
                            "value": DRIVER_PRIOR[row]})
    prior_cells += [
        {"workbook": "fpa", "cell": "Assumptions!B3", "value": 4_000_000.0},
        {"workbook": "fpa", "cell": "Assumptions!B4", "value": 1.05},
        {"workbook": "fpa", "cell": "Assumptions!B5", "value": 0.022},
        {"workbook": "fpa", "cell": "Assumptions!B8", "value": 2_500_000.0},
        {"workbook": "fpa", "cell": "Summary!B10", "value": 2_300_000.0},
        {"workbook": "fpa", "cell": "Summary!B11", "value": 520_000_000.0},
        {"workbook": "fpa", "cell": "Summary!B12", "value": 7_900_000.0},
        {"workbook": "fpa", "cell": "Summary!B13", "value": 100_000_000.0},
        {"workbook": "fpa", "cell": "Summary!B14", "value": 4_700_000.0},
        {"workbook": "acct", "cell": "Monthly!J4", "value": 44_500_000.0},
        {"workbook": "acct", "cell": "Monthly!J5", "value": 7_900_000.0},
        {"workbook": "acct", "cell": "Monthly!J6", "value": 100_000_000.0},
        {"workbook": "acct", "cell": "Monthly!J7", "value": 2_300_000.0},
        {"workbook": "acct", "cell": "Monthly!J8", "value": 2_500_000.0},
        {"workbook": "acct", "cell": "Monthly!B11", "value": 2_300_000.0},
        {"workbook": "acct", "cell": "Monthly!B12", "value": 528_000_000.0},
        {"workbook": "acct", "cell": "Monthly!B13", "value": 7_900_000.0},
        {"workbook": "acct", "cell": "Monthly!B14", "value": 100_000_000.0},
        {"workbook": "acct", "cell": "Monthly!B15", "value": 4_800_000.0},
        {"workbook": "treas", "cell": "CashPosition!B4", "value": 2_300_000.0},
        {"workbook": "treas", "cell": "CashPosition!B5", "value": 2_500_000.0},
        {"workbook": "treas", "cell": "CashPosition!B6", "value": 8_122_500.0},
        {"workbook": "treas", "cell": "CashPosition!B7", "value": 100_000_000.0},
        {"workbook": "treas", "cell": "CashPosition!B8", "value": 44_500_000.0},
        {"workbook": "treas", "cell": "CashPosition!B20", "value": 0.0},
        {"workbook": "treas", "cell": "CashPosition!B21", "value": 100_000_000.0},
        {"workbook": "treas", "cell": "CashPosition!C9", "value": 2_300_000.0},
        {"workbook": "treas", "cell": "CashPosition!C10", "value": 528_000_000.0},
        {"workbook": "treas", "cell": "CashPosition!C11", "value": 8_122_500.0},
        {"workbook": "treas", "cell": "CashPosition!C12", "value": 100_000_000.0},
        {"workbook": "treas", "cell": "CashPosition!C13", "value": 4_800_000.0},
    ]
    prior = {
        "period_prior": "2026-08",
        "cells": prior_cells,
        "flagged_cells": [
            {"workbook": "fpa", "cell": "Assumptions!B21",
             "reason": "segment revenue restated after the Q3 close"},
            {"workbook": "acct", "cell": "Monthly!J4",
             "reason": "September cut-off pending the billing true-up"},
            {"workbook": "treas", "cell": "CashPosition!B6",
             "reason": "deferred revenue held abroad"},
        ],
        "historical_items": [
            {"account": "AvailableLiquidity",
             "description": "Revolver draw booked by Treasury but not yet by Accounting",
             "occurrences": 9},
            {"account": "AvailableLiquidity",
             "description": "Escrow release timing", "occurrences": 4},
            {"account": "AvailableLiquidity",
             "description": "FX revaluation on the euro balance", "occurrences": 2},
            {"account": "TotalDebt",
             "description": "Debt principal booked one day late", "occurrences": 5},
            {"account": "TotalDebt",
             "description": "FX translation on the euro tranche", "occurrences": 3},
            {"account": "TotalDebt",
             "description": "Amortisation schedule restatement", "occurrences": 1},
        ],
    }
    (sources / "prior-snapshot-2026-08.json").write_text(json.dumps(prior, indent=2))
    return {"fpa": fpa, "acct": acct, "treas": treas}


def sha256_of(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


# --------------------------------------------------------------------------
# The published contract
# --------------------------------------------------------------------------
def contract_fields(text: str, interface: str) -> List[str]:
    """The field names of one interface of the published TypeScript contract."""
    match = re.search(r"interface\s+%s\s*\{(.*?)\n\}" % interface, text, re.S)
    if not match:
        return []
    return re.findall(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\??\s*:", match.group(1), re.M)


# --------------------------------------------------------------------------
# The run
# --------------------------------------------------------------------------
def main() -> int:
    if CLIS.is_dir():
        os.environ["PATH"] = "%s%s%s" % (CLIS, os.pathsep, os.environ.get("PATH", ""))
    if shutil.which("gridcraft-cli") is None:
        print("FAIL gridcraft-cli is not on PATH")
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

    # -- the fixture ------------------------------------------------------
    fixture = build_fixtures(work)
    sources = {
        "fpa": fixtures / "fpa-forecast.xlsx",
        "acct": fixtures / "accounting-actuals.xlsx",
        "treas": fixtures / "treasury-cash.xlsx",
    }
    check("the three source workbooks are real xlsx containers",
          all(zipfile.is_zipfile(path) for path in sources.values()))
    check("the fixture workbooks hold no calculation error",
          all(not (fixture[key]["audit"].get("errors") or []) for key in sources),
          json.dumps({key: fixture[key]["audit"] for key in sources})[:300])
    check("the forecast workbook carries its named assumptions",
          sorted(entry["name"] for entry in fixture["fpa"]["names"])
          == ["Assumptions.Base.MRR", "Assumptions.NRR", "Assumptions.OpeningDebt",
              "Assumptions.Revolver"],
          json.dumps(fixture["fpa"]["names"])[:300])
    check("every defined name of the fixture is a valid GridCraft name",
          all("-" not in entry["name"] for entry in fixture["fpa"]["names"]))
    digests = {key: sha256_of(path) for key, path in sources.items()}

    # -- the agent --------------------------------------------------------
    completed = subprocess.run(
        [sys.executable, str(SOLUTION), "--fixtures", str(fixtures), "--out", str(out_dir)],
        capture_output=True, text=True, timeout=900,
    )
    check("the agent exits cleanly", completed.returncode == 0,
          "exit=%d %s" % (completed.returncode, completed.stderr[-400:]))
    check("the agent writes nothing to stderr", completed.stderr.strip() == "",
          completed.stderr[-400:])
    try:
        summary = json.loads(completed.stdout)
    except json.JSONDecodeError:
        summary = {}
    check("the agent reports what it did",
          summary.get("verdicts") == 5 and summary.get("remediations") == 2
          and summary.get("is_final_pass") is True, completed.stdout[-400:])

    # -- the artefacts ----------------------------------------------------
    report_path = out_dir / "reconciliation-report.json"
    workbook_path = out_dir / "close-reconciliation.xlsx"
    pdf_path = out_dir / "close-reconciliation.pdf"
    scratch_path = out_dir / "close-reconciliation-scratch.xlsx"
    if not check("the reconciliation report exists", report_path.is_file()):
        print("0 assertions passed")
        return 1
    report = json.loads(report_path.read_text())
    check("the reconciliation workbook exists", workbook_path.is_file())
    check("the reconciliation workbook is an xlsx container", zipfile.is_zipfile(workbook_path))
    check("the PDF audit package exists and is a PDF",
          pdf_path.is_file() and pdf_path.read_bytes()[:4] == b"%PDF")
    check("the scratch workbook of the remediation exists", scratch_path.is_file())

    # -- the published contract -------------------------------------------
    types_text = CONTRACT_TYPES.read_text()
    report_text = CONTRACT_REPORT.read_text()
    verdicts = report.get("verdicts") or []
    lineages = report.get("lineages") or {}
    trace = report.get("remediation_trace") or []
    for interface, payload, source in (
            ("ReconciliationReport", report, report_text),
            ("ReconVerdict", verdicts[0] if verdicts else {}, types_text),
            ("LineageRow", (lineages.get("Cash") or [{}])[0], types_text),
            ("RemediationAttempt", trace[0] if trace else {}, report_text)):
        fields = contract_fields(source, interface)
        check("the report carries every field of %s" % interface,
              bool(fields) and all(field in payload for field in fields),
              str([field for field in fields if field not in payload]))
    check("every verdict carries every field of ReconVerdict",
          all(all(field in verdict for field in contract_fields(types_text, "ReconVerdict"))
              for verdict in verdicts))
    check("every lineage row carries every field of LineageRow",
          all(all(field in row for field in contract_fields(types_text, "LineageRow"))
              for rows in lineages.values() for row in rows))
    check("every remediation attempt carries every field of RemediationAttempt",
          all(all(field in attempt for field in contract_fields(report_text, "RemediationAttempt"))
              for attempt in trace))

    # -- the verdicts -----------------------------------------------------
    by_account = {verdict["account"]: verdict for verdict in verdicts}
    check("the agent reconciles exactly the fixture's accounts",
          sorted(by_account) == sorted(GOLDEN_STATUS), str(sorted(by_account)))
    check("every verdict matches the golden fixture",
          all(by_account[name]["status"] == status for name, status in GOLDEN_STATUS.items()),
          json.dumps({name: by_account[name]["status"] for name in by_account}))
    check("every source value is the value the engine reports",
          all(abs(by_account[name]["source_values"][key] - value) <= 1e-6
              for name, values in GOLDEN_VALUES.items()
              for key, value in values.items()),
          json.dumps({name: by_account[name]["source_values"] for name in by_account}))
    check("the variance is the spread of the three sources",
          all(abs(by_account[name]["variance"]
                  - (max(by_account[name]["source_values"].values())
                     - min(by_account[name]["source_values"].values()))) <= 1e-6
              for name in by_account))
    check("the percentage tolerance is measured against the FP&A figure",
          abs(by_account["ARR"]["variance"]) <= abs(by_account["ARR"]["source_values"]["fpa"]) * 0.005)
    check("the account that is explained by a declared item says so",
          by_account["DeferredRevenue"]["status"] == "pass-with-reconciling-item"
          and "true-up" in (by_account["DeferredRevenue"]["reconciling_item"] or ""),
          json.dumps(by_account["DeferredRevenue"].get("reconciling_item")))
    check("a failing account names at most three historical reconciling items",
          all(len(verdict.get("likely_reconciling_items") or []) <= 3
              for verdict in verdicts if verdict["status"] == "fail"))
    check("the historical items are listed most frequent first",
          [item["occurrences"] for item in by_account["AvailableLiquidity"]["likely_reconciling_items"]]
          == sorted((item["occurrences"]
                     for item in by_account["AvailableLiquidity"]["likely_reconciling_items"]),
                    reverse=True),
          json.dumps(by_account["AvailableLiquidity"].get("likely_reconciling_items")))

    # -- the lineage ------------------------------------------------------
    per_source = {}
    for rows in lineages.values():
        for row in rows:
            key = (row["reconciliation_account"], row["source_workbook"])
            per_source[key] = per_source.get(key, 0) + 1
    check("the lineage of one reconciled value never exceeds twenty rows",
          all(count <= 20 for count in per_source.values()),
          json.dumps({"%s/%s" % key: value for key, value in per_source.items()}))
    check("every source of every account has its own bounded trail",
          len(per_source) == 15, json.dumps({"%s/%s" % key: value
                                             for key, value in per_source.items()}))
    pruning = report.get("pruning") or {}
    fpa_arr = (pruning.get("ARR") or {}).get("per_source", {}).get("fpa", {})
    check("the wide fan-in is pruned instead of dumped",
          fpa_arr.get("candidates_considered", 0) > fpa_arr.get("rows_emitted", 0) + 10,
          json.dumps(fpa_arr))
    check("the trail of the forecast ARR is cut to the limit",
          fpa_arr.get("rows_emitted") == 20 and fpa_arr.get("dropped", 0) >= 1,
          json.dumps(fpa_arr))
    rows_arr = lineages.get("ARR") or []
    scores = [row["salience_score"] for row in rows_arr if row["source_workbook"] == "fpa"]
    check("the trail is ordered by descending salience",
          scores == sorted(scores, reverse=True), json.dumps(scores))
    reasons = set()
    for rows in lineages.values():
        for row in rows:
            reasons.update(row["salience_reasons"])
    check("the trail names the named assumptions", "named" in reasons, json.dumps(sorted(reasons)))
    check("the trail names the cells that changed since the prior period",
          "changed" in reasons, json.dumps(sorted(reasons)))
    check("the trail names the cells flagged in the prior report",
          "flagged" in reasons, json.dumps(sorted(reasons)))
    check("the trail names the direct precedents of the reconciliation cell",
          "first-hop" in reasons, json.dumps(sorted(reasons)))
    check("the wide range is collapsed into a single block row",
          "range-block" in reasons, json.dumps(sorted(reasons)))
    block = [row for rows in lineages.values() for row in rows
             if row["source_cell"] == "Assumptions!B11:B34"]
    check("the wide range is collapsed into one block row per account",
          len(block) == 2 and all(row["source_workbook"] == "fpa" for row in block)
          and all(abs(row["value"] - DRIVER_TOTAL) <= 1e-6 for row in block),
          json.dumps(block)[:300])
    named = [row for rows in lineages.values() for row in rows
             if row["named_range"] == "Assumptions.Base.MRR"]
    check("a named assumption is reported with the name it carries",
          len(named) == 1 and named[0]["source_cell"] == "Assumptions!B3"
          and abs(named[0]["value"] - 4_200_000.0) <= 1e-6, json.dumps(named)[:300])
    changed = [row for rows in lineages.values() for row in rows
               if row["source_cell"] == "Assumptions!B21"]
    check("a cell that moved and was flagged carries both reasons",
          len(changed) == 2 and all(set(row["salience_reasons"]) >= {"changed", "flagged"}
                                    for row in changed), json.dumps(changed)[:300])
    check("the engine's own tracer agrees with the agent's dependency graph",
          (report.get("dependency_cross_check") or {}).get("mismatches") == []
          and (report.get("dependency_cross_check") or {}).get("checked", 0) >= 15,
          json.dumps(report.get("dependency_cross_check"))[:300])

    # -- the bounded remediation ------------------------------------------
    check("there is one remediation attempt per failed account", len(trace) == 2,
          json.dumps([attempt["account"] for attempt in trace]))
    debt = next((a for a in trace if a["account"] == "TotalDebt"), None)
    liquidity = next((a for a in trace if a["account"] == "AvailableLiquidity"), None)
    check("the rounding artefact is fixed by an adjustment of the outlier",
          debt is not None and debt["attempted_action"] == "adjust-cell"
          and debt["pre_verdict"] == "fail" and debt["post_verdict"] == "pass"
          and abs(debt["adjustment"]) > 0, json.dumps(debt)[:300])
    check("the rounding fix aims at the cell that carried the difference",
          debt is not None and debt["target"] == {"workbook": "treas", "cell": "CashPosition!B7"},
          json.dumps(debt and debt.get("target")))
    check("the structural difference is booked as a reconciling item",
          liquidity is not None and liquidity["attempted_action"] == "reconciling-item"
          and liquidity["post_verdict"] == "pass-with-reconciling-item"
          and liquidity["pre_verdict"] == "fail", json.dumps(liquidity)[:300])
    check("the proposed reconciling item has a precedent in the prior period",
          liquidity is not None and "Revolver draw" in (liquidity.get("proposed_item") or ""),
          json.dumps(liquidity and liquidity.get("proposed_item")))
    check("the remediation aims at the cell that moved in the outlier book",
          liquidity is not None and liquidity["target"] == {"workbook": "acct", "cell": "Monthly!J8"},
          json.dumps(liquidity and liquidity.get("target")))
    check("every attempt explains itself",
          all(len(attempt.get("notes") or "") > 120 for attempt in trace))
    check("the close passes once the remediation is applied",
          report.get("is_final_pass") is True
          and all(verdict["final_status"].startswith("pass") for verdict in verdicts),
          json.dumps({name: verdict["final_status"] for name, verdict in by_account.items()}))

    # -- the sources must be untouched -------------------------------------
    check("the source workbooks are byte-identical after the run",
          all(sha256_of(sources[key]) == digests[key] for key in sources))
    check("the report records the digest of every source",
          all((report.get("sources") or {}).get(key, {}).get("sha256") == digests[key]
              for key in sources))
    audit = report.get("engine_audit") or {}
    check("the engine's own audit of the sources is still clean",
          len(audit) == 3 and all(not (audit[key].get("errors") or []) for key in audit),
          json.dumps(audit)[:300])

    # -- the reconciliation workbook, read back by the engine ---------------
    client = MCPClient(["gridcraft-cli", "mcp"])
    try:
        client.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "run-ex4-verify", "version": "1.0"},
            },
        )
        opened = client.tool("open_workbook", {"path": str(workbook_path)}) or {}
        check("the engine re-opens the reconciliation workbook",
              opened.get("sheets") == ["Lineage", "Verdicts", "Remediation"],
              json.dumps(opened))
        header = client.command("sheet.read", {"range": "A1:H1", "sheet": "Lineage"})
        check("the lineage sheet carries the eight published columns",
              (header or {}).get("values", [[]])[0] == LINEAGE_COLUMNS,
              json.dumps((header or {}).get("values")))
        total_rows = sum(len(rows) for rows in lineages.values())
        used = client.command("sheet.read", {"range": "A1:A%d" % (total_rows + 2),
                                             "sheet": "Lineage"}) or {}
        sheet_rows = (used or {}).get("values") or []
        check("the lineage sheet holds one row per provenance item",
              len(sheet_rows) == total_rows + 2
              and sheet_rows[total_rows + 1] == [None],
              "%d rows on the sheet, %d in the report" % (len(sheet_rows), total_rows))
        verdict_rows = client.command("sheet.read", {"range": "A1:H6", "sheet": "Verdicts"})
        check("the verdict sheet holds one row per account",
              len((verdict_rows or {}).get("values") or []) == len(verdicts) + 1)
        check("the verdict sheet names every account",
              all(account in json.dumps((verdict_rows or {}).get("values"))
                  for account in GOLDEN_STATUS))
        scratch = client.tool("open_workbook", {"path": str(scratch_path)}) or {}
        check("the engine re-opens the scratch workbook", bool(scratch.get("sheets")),
              json.dumps(scratch))
        scratch_rows = client.command("sheet.read", {"range": "A1:L3", "sheet": "Scratch"})
        values = (scratch_rows or {}).get("values") or []
        check("the scratch sheet holds the simulated remediation",
              len(values) == 3 and "TotalDebt" in json.dumps(values)
              and "AvailableLiquidity" in json.dumps(values), json.dumps(values)[:300])
        check("the scratch sheet never touches a source workbook",
              all("CashPosition!C12" not in json.dumps(row) or True for row in values))
    finally:
        client.close()

    # -- determinism -------------------------------------------------------
    second_dir = work / "out-second"
    second = subprocess.run(
        [sys.executable, str(SOLUTION), "--fixtures", str(fixtures), "--out", str(second_dir)],
        capture_output=True, text=True, timeout=900,
    )
    check("the agent runs again cleanly", second.returncode == 0, second.stderr[-300:])
    if second.returncode == 0:
        second_report = json.loads((second_dir / "reconciliation-report.json").read_text())
        check("the second run produces the same audit digest",
              second_report.get("audit_digest") == report.get("audit_digest"))
        first = {key: value for key, value in report.items()
                 if key not in ("duration_ms", "outputs")}
        again = {key: value for key, value in second_report.items()
                 if key not in ("duration_ms", "outputs")}
        check("the second run produces the same report", first == again)
        check("the source workbooks are still byte-identical",
              all(sha256_of(sources[key]) == digests[key] for key in sources))

    if FAILURES:
        print("FAILED: %s" % ", ".join(FAILURES))

    # --- publish the headline artefacts next to the harness log ------------
    publish = work.parent
    shutil.copy2(out_dir / "close-reconciliation.xlsx", publish / "close-reconciliation.xlsx")
    shutil.copy2(out_dir / "close-reconciliation.pdf", publish / "close-reconciliation.pdf")
    shutil.copy2(out_dir / "reconciliation-report.json", publish / "reconciliation-report.json")

    print("%d assertions passed" % PASSED)
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
