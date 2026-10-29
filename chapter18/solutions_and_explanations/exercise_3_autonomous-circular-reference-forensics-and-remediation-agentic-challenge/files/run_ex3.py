#!/usr/bin/env python3
"""
run_ex3.py -- the acceptance harness for exercise 3.

It builds the exercise's fixtures with the real GridCraft engine (including a
workbook that really does contain circular references), runs
`04_circular_forensics.py` against that workbook, and then checks the
artefacts the run left behind: the remediated workbook (re-opened by the
engine itself), the JSON and Markdown reports, the preview renders, and the
engine's own audit of the model before and after the run.

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
SOLUTION = HERE / "03_autonomous-circular-reference-forensics-and-remediation-agentic-challenge.py"
CONTRACT_TS = HERE / "01_typescript.ts"
CONTRACT_JSON = HERE / "02_json.json"

WORKBOOK_NAME = "legacy-plan-grid.xlsx"

# The model the legacy workbook carries: six sheets, five cycles, of which
# four are in scope and one is an intentional iterative block.
SEED_CLUSTERS: List[Dict[str, Any]] = [
    {
        "kind": "true",
        "members": [
            "Cash Flow!B12", "Debt Schedule!B12", "Debt Schedule!B13",
            "Debt Schedule!B14", "Interest!B12", "Interest!B13",
        ],
    },
    {
        "kind": "true",
        "members": [
            "Cash Flow!C12", "Debt Schedule!C12", "Debt Schedule!C13",
            "Debt Schedule!C14", "Interest!C12", "Interest!C13",
        ],
    },
    {"kind": "named-mutual", "members": ["Interest.Charge", "Interest.Expense"]},
    {"kind": "iterative", "members": ["Iterative Block!B11", "Iterative Block!B12"]},
    {"kind": "self", "members": ["Rollforward!C13"]},
]

SHEETS: List[Tuple[str, List[Tuple[str, Any]]]] = [
    ("Assumptions", [
        ("A1", "Helios legacy plan - assumptions"),
        ("A3", "Interest rate (average debt)"), ("B3", 0.06),
        ("A4", "Opening debt FY24"), ("B4", 1000),
        ("A5", "Scheduled repayment FY24"), ("B5", -250),
        ("A6", "EBITDA FY24"), ("B6", 400),
        ("A7", "EBITDA FY25"), ("B7", 430),
    ]),
    ("Debt Schedule", [
        ("A1", "Helios legacy plan - debt schedule"),
        ("A10", "Debt roll-forward"), ("B10", "FY24"), ("C10", "FY25"),
        ("A11", "Beginning Debt Balance"), ("B11", "=Assumptions!B4"), ("C11", "=B14"),
        ("A12", "Interest Expense"), ("B12", "=Interest!B13"), ("C12", "=Interest!C13"),
        ("A13", "Free Cash Sweep"), ("B13", "=-'Cash Flow'!B12"), ("C13", "=-'Cash Flow'!C12"),
        ("A14", "Ending Debt Balance"), ("B14", "=B11+B12+B13"), ("C14", "=C11+C12+C13"),
    ]),
    ("Interest", [
        ("A1", "Helios legacy plan - interest"),
        ("A10", "Interest schedule"), ("B10", "FY24"), ("C10", "FY25"),
        ("A11", "Interest rate"), ("B11", "=Assumptions!$B$3"), ("C11", "=B11"),
        ("A12", "Average Debt Balance"),
        ("B12", "=('Debt Schedule'!B11+'Debt Schedule'!B14)/2"),
        ("C12", "=('Debt Schedule'!C11+'Debt Schedule'!C14)/2"),
        ("A13", "Interest Expense"), ("B13", "=B12*B11"), ("C13", "=C12*C11"),
    ]),
    ("Cash Flow", [
        ("A1", "Helios legacy plan - cash flow"),
        ("A10", "Cash flow statement"), ("B10", "FY24"), ("C10", "FY25"),
        ("A11", "EBITDA"), ("B11", "=Assumptions!B6"), ("C11", "=Assumptions!B7"),
        ("A12", "Free Cash Flow"), ("B12", "=B11-'Interest'!B13"), ("C12", "=C11-'Interest'!C13"),
        ("A14", "Total interest (named)"), ("B14", "=Interest.Charge"),
    ]),
    ("Rollforward", [
        ("A1", "Helios legacy plan - cash roll-forward"),
        ("A10", "Rolling cash balance"), ("B10", "FY24"), ("C10", "FY25"),
        ("A11", "Opening Balance"), ("B11", 1000), ("C11", "=B13"),
        ("A12", "Net Movement"), ("B12", -120), ("C12", -80),
        ("A13", "Closing Balance"), ("B13", "=SUM(B11:B12)"), ("C13", "=SUM(C11:C13)"),
    ]),
    ("Iterative Block", [
        ("A1", "Helios legacy plan - iterative block"),
        ("A10", "Converging balance"), ("B10", "FY24"),
        ("A11", "Converging balance"), ("B11", "=B12/2"),
        ("A12", "Converging balance"), ("B12", "=B11+100"),
    ]),
]

ITERATIVE_NOTE = ("ITERATIVE CALC: the model solves this block by iteration; enable iterative "
                  "calculation in Formulas > Calculation Options")

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
def build_fixture(path: Path) -> Dict[str, Any]:
    """Write the inherited workbook with the engine itself.

    The model it writes really does contain circular references: the engine's
    own auditor reports them once the file has been built.
    """
    path.parent.mkdir(parents=True, exist_ok=True)
    client = MCPClient(["gridcraft-cli", "mcp"])
    try:
        client.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "run-ex3-fixture", "version": "1.0"},
            },
        )
        client.tool("new_workbook", {})
        client.command("sheet.rename", {"sheet": "Sheet1", "name": SHEETS[0][0]})
        for name, _cells in SHEETS[1:]:
            client.command("home.insertSheet", {"name": name})
        for sheet, cells in SHEETS:
            for address, value in cells:
                client.command("cell.set", {"sheet": sheet, "cell": address, "input": value})
        client.command("formulas.defineName", {"name": "Interest.Expense", "refersTo": "=Interest.Charge"})
        client.command("formulas.defineName", {"name": "Interest.Charge", "refersTo": "=Interest.Expense"})
        client.command("review.newNote", {"cell": "Iterative Block!B11", "text": ITERATIVE_NOTE,
                                          "author": "legacy model"})
        client.command("formulas.calculateNow", {})
        audit = client.command("formulas.errorChecking", {}) or {}
        names = client.command("formulas.nameManager", {}) or []
        client.tool("save_workbook", {"path": str(path)})
    finally:
        client.close()
    return {"audit": audit, "names": names}


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
    fixture_path = work / "fixtures" / WORKBOOK_NAME
    out_dir = work / "out"

    # -- the fixture ------------------------------------------------------
    fixture = build_fixture(fixture_path)
    fixture_audit = fixture["audit"]
    fixture_circ = fixture_audit.get("circular") or []
    fixture_errors = fixture_audit.get("errors") or []
    circular_cells = {
        "%s!%s" % (entry["sheet"], entry["cell"])
        for entry in fixture_errors if entry.get("error") == "#CIRC!"
    }
    check("the fixture is a real xlsx workbook", zipfile.is_zipfile(fixture_path))
    check("the engine finds circular references in the fixture",
          len(fixture_circ) >= 4, str(fixture_circ))
    check("the fixture carries the seeded circular cells",
          {"Debt Schedule!B14", "Interest!B12", "Cash Flow!B12", "Rollforward!C13",
           "Iterative Block!B11"} <= circular_cells,
          str(sorted(circular_cells)))
    check("the fixture's defined names are mutually recursive",
          all(isinstance(entry.get("value"), dict) for entry in fixture["names"])
          and len(fixture["names"]) == 2,
          json.dumps(fixture["names"]))
    fixture_sha = sha256_of(fixture_path)

    # -- the agent --------------------------------------------------------
    completed = subprocess.run(
        [sys.executable, str(SOLUTION), "--workbook", str(fixture_path), "--out-dir", str(out_dir)],
        capture_output=True,
        text=True,
        timeout=600,
    )
    check("the agent exits cleanly", completed.returncode == 0,
          "exit=%d %s" % (completed.returncode, completed.stderr[-400:]))
    check("the agent writes nothing to stderr", completed.stderr.strip() == "",
          completed.stderr[-400:])
    try:
        summary = json.loads(completed.stdout)
    except json.JSONDecodeError:
        summary = {}
    check("the agent reports what it did", summary.get("breaks_applied") == 4
          and summary.get("residual_cycles") == [], completed.stdout[-300:])

    report_path = out_dir / "remediation-report.json"
    markdown_path = out_dir / "remediation-report.md"
    workbook_path = out_dir / "legacy-plan-grid-remediated.xlsx"
    if not check("the remediation report exists", report_path.is_file()):
        print("0 assertions passed")
        return 1
    report = json.loads(report_path.read_text())
    check("the human-readable report exists", markdown_path.is_file()
          and markdown_path.stat().st_size > 0)
    check("the remediated workbook exists", workbook_path.is_file())
    check("the remediated workbook is an xlsx container", zipfile.is_zipfile(workbook_path))

    # -- the inherited file must be untouched -----------------------------
    check("the inherited workbook is byte-identical", sha256_of(fixture_path) == fixture_sha)
    check("the report records the inherited digest",
          report.get("input_sha256") == fixture_sha)
    check("the report records the remediated digest",
          report.get("output_sha256") == sha256_of(workbook_path))

    # -- the published contract -------------------------------------------
    contract_text = CONTRACT_TS.read_text()
    for interface, payload in (("RemediationReport", report),
                                ("CycleReport", (report.get("cycles_found") or [{}])[0]),
                                ("BreakCandidate", ((report.get("remediations") or [{}])[0] or {}).get("chosen", {})),
                                ("RemediationEntry", (report.get("remediations") or [{}])[0])):
        fields = contract_fields(contract_text, interface)
        check("the report carries every field of %s" % interface,
              bool(fields) and all(field in payload for field in fields),
              str([field for field in fields if field not in payload]))
    break_payload = json.loads(CONTRACT_JSON.read_text())
    published_steps = break_payload.get("steps") or []
    applied_steps = []
    for entry in report.get("remediations") or []:
        if entry.get("chosen", {}).get("edge", {}).get("from") == break_payload.get("cell"):
            applied_steps = entry.get("steps") or []
    check("the agent sends the published break payload",
          len(published_steps) == len(applied_steps) >= 2
          and [step.get("command") for step in published_steps]
          == [step.get("command") for step in applied_steps],
          json.dumps(applied_steps)[:400])
    published_params = [step.get("params") for step in published_steps]
    applied_params = [{key: value for key, value in step.items() if key != "command"}
                      for step in applied_steps]
    check("the published break payload is exactly what the agent sent",
          published_params == applied_params, json.dumps(applied_params)[:400])
    check("the published break payload names real commands",
          all(step.get("command") in ("cell.set", "review.newNote", "formulas.defineName")
              for step in published_steps))

    # -- the cycles the agent found ---------------------------------------
    cycles = report.get("cycles_found") or []
    check("the agent found every seeded cycle", len(cycles) == len(SEED_CLUSTERS),
          str(len(cycles)))
    seeded = {frozenset(cluster["members"]): cluster["kind"] for cluster in SEED_CLUSTERS}
    found = {frozenset(cluster["members"]): cluster["classification"] for cluster in cycles}
    check("the agent classified every cycle", found == seeded,
          json.dumps({" | ".join(sorted(key)): value for key, value in found.items()}))
    check("the cycle ids are stable and ordered",
          [cluster["id"] for cluster in cycles] == ["cycle-%03d" % index
                                                   for index in range(1, len(cycles) + 1)],
          str([cluster["id"] for cluster in cycles]))
    check("the agent's cycle members agree with the engine's circular cells",
          all(member in circular_cells
              for cluster in cycles for member in cluster["members"] if "!" in member),
          str(sorted(circular_cells)))
    cross_check = report.get("graph_cross_check") or {}
    check("the engine's own tracer agrees with the parsed dependency graph",
          cross_check.get("mismatches") == [] and cross_check.get("checked", 0) >= 10,
          json.dumps(cross_check)[:300])

    # -- the dependency graph the agent worked from -----------------------
    graph_path = out_dir / "dependency-graph.json"
    check("the dependency graph is written as an artefact", graph_path.is_file())
    graph = json.loads(graph_path.read_text()) if graph_path.is_file() else {}
    nodes = graph.get("nodes") or []
    edges = graph.get("edges") or []
    node_keys = {node["key"] for node in nodes}
    check("the graph has nodes and edges", len(nodes) > 20 and len(edges) > 20,
          "%d nodes, %d edges" % (len(nodes), len(edges)))
    check("every edge joins two nodes of the graph",
          all(edge["from"] in node_keys and edge["to"] in node_keys for edge in edges))
    check("the graph carries the model's defined names",
          {"Interest.Expense", "Interest.Charge"} <= node_keys
          and all(node.get("is_name") for node in nodes if node["key"].startswith("Interest.")),
          str(sorted(node_keys)[:20]))
    check("the graph carries the formula cells of the cycles",
          all(member in node_keys for cluster in cycles for member in cluster["members"]
              if "!" in member))
    check("the remediated graph is acyclic outside the deferred cycle",
          graph.get("acyclic_outside_deferred") is True
          and graph.get("remaining_cycles") == [],
          json.dumps(graph.get("remaining_cycles")))
    check("the report points at the dependency graph",
          Path(str((report.get("dependency_graph") or {}).get("path"))).resolve()
          == graph_path.resolve(),
          json.dumps(report.get("dependency_graph")))

    # -- what was done ----------------------------------------------------
    remediations = report.get("remediations") or []
    applied = [entry for entry in remediations if entry.get("status") == "applied"]
    check("one break per in-scope cycle", len(applied) == 4, str(len(applied)))
    check("no cycle is left broken", report.get("residual_cycles") == [],
          json.dumps(report.get("residual_cycles")))
    check("the iterative cycle is deferred, not remediated",
          len(report.get("deferred_cycles") or []) == 1
          and not any(entry["cycle_id"] in (report.get("deferred_cycles") or [])
                      for entry in applied),
          json.dumps(report.get("deferred_cycles")))
    check("every applied break is verified acyclic",
          all(entry.get("verified_acyclic") is True for entry in applied))
    check("every break records the formula it replaced",
          all(entry.get("pre_formula") and entry.get("post_formula")
              and entry["pre_formula"] != entry["post_formula"] for entry in applied))
    check("every break is scored on the three published axes",
          all(isinstance(entry["chosen"].get("semantic_plausibility"), int)
              and isinstance(entry["chosen"].get("blast_radius"), int)
              and isinstance(entry["chosen"].get("formula_complexity"), int)
              and isinstance(entry["chosen"].get("total_score"), (int, float))
              for entry in applied))
    check("every break carries a rationale a reviewer can argue with",
          all(len(entry["chosen"].get("rationale", "")) > 120 for entry in applied))
    check("the alternatives are ranked and explained",
          all(all(alternative.get("rewrite_explanation")
                  for alternative in entry.get("alternatives") or [])
              and [alternative["total_score"] for alternative in entry.get("alternatives") or []]
              == sorted((alternative["total_score"]
                         for alternative in entry.get("alternatives") or []), reverse=True)
              for entry in applied))
    check("the agent says how it weighted the three axes",
          set(report.get("method", {}).get("scoring_weights", {}))
          == {"semantic_plausibility", "formula_complexity", "blast_radius"})

    by_edge = {entry["chosen"]["edge"]["from"]: entry for entry in applied}
    fy24 = by_edge.get("Interest!B12")
    check("the first cycle is broken at the closing-balance reference",
          fy24 is not None and fy24["chosen"]["edge"]["to"] == "Debt Schedule!B14"
          and fy24["chosen"]["rewrite_kind"] == "lag-opening-balance")
    check("the first break reads the opening balance afterwards",
          fy24 is not None and "'Debt Schedule'!B11" in fy24["post_formula"]
          and "B14" not in fy24["post_formula"], str(fy24 and fy24["post_formula"]))
    check("the first break keeps the roll-forward arithmetic",
          fy24 is not None and fy24["post_formula"].startswith("=(")
          and "+" in fy24["post_formula"] and "/2" in fy24["post_formula"],
          str(fy24 and fy24["post_formula"]))
    check("the self-reference is broken by trimming the window",
          by_edge.get("Rollforward!C13") is not None
          and by_edge["Rollforward!C13"]["post_formula"] == "=SUM(C11:C12)")
    check("the self-reference is ranked as an aggregate rewrite",
          by_edge.get("Rollforward!C13") is not None
          and by_edge["Rollforward!C13"]["chosen"]["formula_complexity"] >= 4)
    check("the name cycle is broken by re-pointing a name",
          by_edge.get("Interest.Expense") is not None
          and by_edge["Interest.Expense"]["chosen"]["rewrite_kind"] == "repoint-defined-name"
          and by_edge["Interest.Expense"]["post_formula"].startswith("="))
    check("the re-pointed name is fully absolute",
          by_edge.get("Interest.Expense") is not None
          and "$" in by_edge["Interest.Expense"]["post_formula"],
          str(by_edge.get("Interest.Expense") and by_edge["Interest.Expense"]["post_formula"]))
    check("the agent warns about the iterative block",
          any("iterative" in warning.lower() for warning in report.get("warnings") or []))

    # -- the engine's own view of the remediated model ---------------------
    client = MCPClient(["gridcraft-cli", "mcp"])
    try:
        client.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "run-ex3-verify", "version": "1.0"},
            },
        )
        client.tool("open_workbook", {"path": str(workbook_path)})
        audit = client.command("formulas.errorChecking", {}) or {}
        errors = audit.get("errors") or []
        remaining = {"%s!%s" % (entry["sheet"], entry["cell"])
                     for entry in errors if entry.get("error") == "#CIRC!"}
        check("the engine re-opens the remediated workbook", bool(client.command(
            "sheet.read", {"range": "A1:A1", "sheet": "Assumptions"})))
        check("only the iterative block is still circular",
              remaining == {"Iterative Block!B11", "Iterative Block!B12"},
              str(sorted(remaining)))
        check("no cell is left in a calculation error",
              not [entry for entry in errors if entry.get("error") not in ("#CIRC!",)],
              json.dumps(errors)[:300])
        names = {entry["name"]: entry for entry in client.command("formulas.nameManager", {}) or []}
        check("the defined names still exist", set(names) == {"Interest.Expense", "Interest.Charge"},
              str(sorted(names)))
        check("the re-pointed name resolves to the cell that computes the interest",
              not isinstance(names.get("Interest.Expense", {}).get("value"), dict)
              and abs(float(names["Interest.Expense"]["value"]) - 60.0) < 1e-6,
              json.dumps(names.get("Interest.Expense")))
        check("the name that pointed at it resolves too",
              not isinstance(names.get("Interest.Charge", {}).get("value"), dict),
              json.dumps(names.get("Interest.Charge")))
        check("the cell that reads the names holds a number",
              abs(float(client.command("sheet.read",
                                       {"range": "B14", "sheet": "Cash Flow"})["values"][0][0]) - 60.0) < 1e-6)
        interest = client.command("sheet.read", {"range": "B13", "sheet": "Interest"})["values"][0][0]
        check("the interest expense is now the opening balance times the rate",
              abs(float(interest) - 60.0) < 1e-6, str(interest))
        tagged = client.tool("get_cell", {"cell": "Interest!B12"}) or {}
        check("the audit tag survived the save on the broken cell",
              "AUDIT-BREAK" in ((tagged.get("comment") or {}).get("text") or ""),
              json.dumps(tagged.get("comment")))
        check("the audit tag names the cycle it broke",
              "cycle-" in ((tagged.get("comment") or {}).get("text") or ""))
        tagged_self = client.tool("get_cell", {"cell": "Rollforward!C13"}) or {}
        check("the self-referencing cell carries its tag too",
              "AUDIT-BREAK" in ((tagged_self.get("comment") or {}).get("text") or ""))
    finally:
        client.close()

    # -- the previews -----------------------------------------------------
    previews = report.get("rendered_previews") or []
    check("the report lists one preview per corrected sheet", len(previews) == 4,
          json.dumps(previews))
    check("every preview is a PNG on disk",
          all(Path(preview).is_file()
              and Path(preview).read_bytes()[:8] == b"\x89PNG\r\n\x1a\n" for preview in previews),
          json.dumps(previews))
    check("the previews cover the sheets the breaks touched",
          {"Interest", "Rollforward"} <= {Path(preview).stem.replace("sheet-", "")
                                          for preview in previews},
          json.dumps(previews))

    # -- the markdown report ----------------------------------------------
    markdown = markdown_path.read_text()
    check("the markdown report names every cycle", all(cluster["id"] in markdown
                                                       for cluster in cycles))
    check("the markdown report shows the formulas before and after",
          all(entry["post_formula"] in markdown for entry in applied))
    check("the markdown report separates proposals from applied changes",
          "Alternatives considered" in markdown and "Justification" in markdown)

    # -- determinism ------------------------------------------------------
    second_dir = work / "out-second"
    second = subprocess.run(
        [sys.executable, str(SOLUTION), "--workbook", str(fixture_path), "--out-dir", str(second_dir)],
        capture_output=True,
        text=True,
        timeout=600,
    )
    check("the agent runs again cleanly", second.returncode == 0, second.stderr[-300:])
    if second.returncode == 0:
        second_report = json.loads((second_dir / "remediation-report.json").read_text())
        check("the second run finds the same cycles",
              second_report.get("cycles_found") == report.get("cycles_found"))
        check("the second run applies the same breaks",
              second_report.get("remediations") == report.get("remediations"))
        check("the second run leaves no residual cycle",
              second_report.get("residual_cycles") == [])

    if FAILURES:
        print("FAILED: %s" % ", ".join(FAILURES))

    # --- publish the headline artefacts next to the harness log ------------
    publish = work.parent
    shutil.copy2(out_dir / "legacy-plan-grid-remediated.xlsx", publish / "legacy-plan-grid-remediated.xlsx")
    shutil.copy2(out_dir / "remediation-report.md", publish / "remediation-report.md")
    shutil.copy2(out_dir / "remediation-report.json", publish / "remediation-report.json")
    shutil.copy2(out_dir / "dependency-graph.json", publish / "dependency-graph.json")
    shutil.copy2(out_dir / "previews" / "sheet-Interest.png", publish / "sheet-Interest.png")

    print("%d assertions passed" % PASSED)
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
