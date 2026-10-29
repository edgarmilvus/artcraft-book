#!/usr/bin/env python3
"""
run_ex1.py -- the acceptance harness for exercise 1.

It builds the exercise's fixtures, runs `01_helios_consolidation.py` against
the real GridCraft engine, and then checks what the run left behind: the
workbook (re-opened by the engine itself), the proof payload, the engine's
own audit output and the engine's own file inspector.  Every check prints one
`PASS <label>` line; the run ends with the number of assertions that passed.

The harness also proves the two properties the exercise asks for:

  * idempotence -- the solution is run twice and the artefacts are compared;
  * fail-closed behaviour -- the fixtures are corrupted on purpose and the
    run has to stop with a structured error, never a stack trace.

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
SOLUTION = HERE / "01_helios_consolidation.py"

PERIOD = "2026-09"

ENTITIES: Tuple[Tuple[str, str], ...] = (
    ("Helios-US", "USD"),
    ("Helios-EU", "EUR"),
    ("Helios-APAC", "SGD"),
    ("Helios-LATAM", "BRL"),
)

#: The entity fixtures, exactly as a local controller would file them.
ENTITY_ROWS: Dict[str, List[Tuple[str, str, float, str]]] = {
    "Helios-US": [
        ("4000", "Net Revenue", 4250000.00, "USD"),
        ("RND-US", "Federal R&D Credit", 75000.00, "USD"),
        ("5000", "Cost of Goods Sold", -1180000.00, "USD"),
        ("6000", "Operating Expenses", -640000.00, "USD"),
    ],
    "Helios-EU": [
        ("4000", "Net Revenue", 3100000.00, "EUR"),
        ("IPBOX-EU", "IP Box Relief", 42000.00, "EUR"),
        ("5000", "Cost of Goods Sold", -860000.00, "EUR"),
        ("6000", "Operating Expenses", -470000.00, "EUR"),
    ],
    "Helios-APAC": [
        ("4000", "Net Revenue", 2240000.00, "SGD"),
        ("FTC-APAC", "FTC Grant Income", 18500.00, "SGD"),
        ("5000", "Cost of Goods Sold", -610000.00, "SGD"),
        ("6000", "Operating Expenses", -395000.00, "SGD"),
    ],
    "Helios-LATAM": [
        ("4000", "Net Revenue", 6800000.00, "BRL"),
        ("ICMS-LATAM", "ICMS Recovery", 260000.00, "BRL"),
        ("5000", "Cost of Goods Sold", -1950000.00, "BRL"),
        ("6000", "Operating Expenses", -1120000.00, "BRL"),
    ],
}

#: The month-end FX table: one rate per currency, against USD.
FX_ROWS: List[Tuple[str, str, str, float]] = [
    ("EUR", "USD", PERIOD, 1.0842),
    ("SGD", "USD", PERIOD, 0.7416),
    ("BRL", "USD", PERIOD, 0.1823),
]

#: The intercompany eliminations, already in USD.
ELIMINATION_ROWS: List[Tuple[str, str, str, float]] = [
    ("Helios-EU", "Helios-US", "4000", 240000.00),
    ("Helios-APAC", "Helios-US", "4000", 86000.00),
    ("Helios-LATAM", "Helios-US", "4000", 41000.00),
]

EXPECTED_SHEETS = [
    "Consolidated",
    "Helios-US",
    "Helios-EU",
    "Helios-APAC",
    "Helios-LATAM",
    "FX",
    "Eliminations",
]

#: The canonical accounts each entity reports.
ENTITY_ACCOUNTS: Dict[str, Tuple[str, ...]] = {
    "Helios-US": ("Rev_Net", "Rev_FederalRDCredit", "Cost_COGS", "Cost_OpEx"),
    "Helios-EU": ("Rev_Net", "Rev_IPBoxRelief", "Cost_COGS", "Cost_OpEx"),
    "Helios-APAC": ("Rev_Net", "Rev_FTCGrantIncome", "Cost_COGS", "Cost_OpEx"),
    "Helios-LATAM": ("Rev_Net", "Rev_ICMSRecovery", "Cost_COGS", "Cost_OpEx"),
}

EXPECTED_NAMES = sorted(
    ["FX.EUR.USD", "FX.SGD.USD", "FX.BRL.USD", "FX.Table"]
    + ["Eliminations.Rows", "Eliminations.TotalUSD"]
    + ["Consolidated.Lines", "Consolidated.Elimination", "Consolidated.Total"]
    + [
        "%s.Amount.%s" % (entity.replace("-", "_"), account)
        for entity, accounts in ENTITY_ACCOUNTS.items()
        for account in accounts
    ]
)

PASSED = 0
FAILURES: List[str] = []


# --------------------------------------------------------------------------
# The assertion helpers
# --------------------------------------------------------------------------
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


def close_to(left: float, right: float, tolerance: float = 1e-9) -> bool:
    return abs(float(left) - float(right)) <= tolerance * max(1.0, abs(float(right)))


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

    def command(self, command: str, params: Optional[Dict[str, Any]] = None) -> Any:
        return self.tool("execute_command", {"command": command, "params": params or {}})

    def initialize(self) -> None:
        self.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "run-ex1", "version": "1.0"},
            },
        )

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


# --------------------------------------------------------------------------
# The fixtures
# --------------------------------------------------------------------------
def write_csv(path: Path, header: Sequence[str], rows: Sequence[Sequence[Any]]) -> None:
    lines = [",".join(header)]
    for row in rows:
        lines.append(",".join(str(value) for value in row))
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def build_fixtures(work: Path) -> Path:
    """Write the six fixtures the solution reads."""
    fixtures = work / "fixtures"
    fixtures.mkdir(parents=True, exist_ok=True)
    for entity, _currency in ENTITIES:
        write_csv(
            fixtures / ("%s-%s.csv" % (entity.lower(), PERIOD)),
            ("account_code", "account_label", "amount_local", "currency", "period"),
            [row + (PERIOD,) for row in ENTITY_ROWS[entity]],
        )
    write_csv(
        fixtures / ("fx-%s.csv" % PERIOD),
        ("from", "to", "period", "rate"),
        FX_ROWS,
    )
    write_csv(
        fixtures / ("ic-elim-%s.csv" % PERIOD),
        ("from_entity", "to_entity", "account_code", "amount_usd"),
        ELIMINATION_ROWS,
    )
    return fixtures


def expected_totals() -> Tuple[Dict[str, float], float, float]:
    """Recompute the consolidation from the fixtures, independently."""
    rates = {currency: rate for currency, target, _period, rate in FX_ROWS if target == "USD"}
    entity_totals: Dict[str, float] = {}
    for entity, currency in ENTITIES:
        local = sum(amount for _code, _label, amount, _cur in ENTITY_ROWS[entity])
        rate = 1.0 if currency == "USD" else rates[currency]
        entity_totals[entity] = local * rate
    elimination_total = sum(amount for _f, _t, _c, amount in ELIMINATION_ROWS)
    consolidated = sum(entity_totals.values()) - elimination_total
    return entity_totals, elimination_total, consolidated


# --------------------------------------------------------------------------
# The runs
# --------------------------------------------------------------------------
def run_solution(fixtures: Path, out_dir: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [
            sys.executable,
            str(SOLUTION),
            "--fixtures-dir",
            str(fixtures),
            "--out-dir",
            str(out_dir),
        ],
        capture_output=True,
        text=True,
        timeout=600,
    )


def corrupt(source: Path, target: Path, entity: str, old: str, new: str) -> Path:
    """Copy the fixtures and damage one line of one entity sheet."""
    target.mkdir(parents=True, exist_ok=True)
    for fixture in sorted(source.iterdir()):
        shutil.copy(fixture, target / fixture.name)
    path = target / ("%s-%s.csv" % (entity.lower(), PERIOD))
    path.write_text(path.read_text(encoding="utf-8").replace(old, new), encoding="utf-8")
    return target


def formula_names(formula: str) -> List[str]:
    """The identifiers a formula reads, with the function names removed."""
    body = formula.lstrip("=")
    body = re.sub(r'"[^"]*"', "", body)
    body = re.sub(r"[A-Za-z_][A-Za-z0-9_.]*\s*\(", " ", body)
    return re.findall(r"[A-Za-z_][A-Za-z0-9_.]*", body)


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
    fixtures = build_fixtures(work)
    out_dir = work / "out"
    print("work directory: %s" % work, file=sys.stderr)

    # -- the run ----------------------------------------------------------
    completed = run_solution(fixtures, out_dir)
    check("the solution exits cleanly", completed.returncode == 0,
          "exit=%d %s" % (completed.returncode, completed.stderr[-400:]))
    check("the solution writes no stderr", completed.stderr.strip() == "",
          completed.stderr[-400:])
    try:
        printed = json.loads(completed.stdout)
        check("the solution prints the proof as JSON", printed.get("invariant_holds") is True)
    except json.JSONDecodeError:
        check("the solution prints the proof as JSON", False, completed.stdout[-200:])
        printed = {}

    proof_path = out_dir / "consolidation-proof.json"
    workbook_path = out_dir / "helios-consolidated.xlsx"
    if not check("the proof file exists", proof_path.is_file()):
        print("0 assertions passed")
        return 1
    if not check("the workbook exists", workbook_path.is_file()):
        print("0 assertions passed")
        return 1
    proof = json.loads(proof_path.read_text())
    payload = workbook_path.read_bytes()

    # -- the workbook ------------------------------------------------------
    check("the workbook is an xlsx container", zipfile.is_zipfile(workbook_path))
    check(
        "the proof records the workbook's digest",
        proof["workbook"]["sha256"] == hashlib.sha256(payload).hexdigest(),
    )
    check(
        "the proof records the workbook's size",
        proof["workbook"]["bytes"] == len(payload),
    )

    info = json.loads(
        subprocess.run(
            ["gridcraft-cli", "info", str(workbook_path), "--json"],
            capture_output=True, text=True, timeout=120,
        ).stdout
    )
    sheet_names = [sheet["name"] for sheet in info.get("sheets", [])]
    check("the workbook holds the seven model sheets", sheet_names == EXPECTED_SHEETS,
          str(sheet_names))
    engine_names = {entry["name"]: entry for entry in info.get("names", [])}
    check(
        "the engine's own inspector finds every model name",
        sorted(engine_names) == EXPECTED_NAMES,
        str(sorted(set(engine_names) ^ set(EXPECTED_NAMES))),
    )
    check(
        "the proof and the engine agree on the names",
        proof["named_ranges_registered"] == sorted(engine_names),
    )
    check(
        "no defined name contains a hyphen",
        all("-" not in name for name in engine_names),
        str([name for name in engine_names if "-" in name]),
    )
    check(
        "every defined name is fully absolute",
        all("$" in entry["refersTo"] for entry in engine_names.values()),
        "a name with a relative row would re-anchor to the cell that reads it",
    )
    check(
        "the FX rates are named per ISO currency",
        all("FX.%s.USD" % currency in engine_names for currency in ("EUR", "SGD", "BRL")),
    )
    check(
        "the eliminations are a named block",
        "Eliminations.Rows" in engine_names and "Eliminations.TotalUSD" in engine_names,
    )

    # -- the engine's own calculation oracle -------------------------------
    check(
        "the proof records the engine's command catalogue",
        proof["engine"]["commands_published"] > 300
        and "formulas.defineName" in proof["engine"]["verified_commands"],
        json.dumps(proof["engine"]),
    )
    check(
        "the proof records the tools the model calls",
        "save_workbook" in proof["engine"]["verified_tools"]
        and "open_workbook" in proof["engine"]["verified_tools"],
        json.dumps(proof["engine"]),
    )
    check_report = subprocess.run(
        ["gridcraft-cli", "check", str(workbook_path), "--json"],
        capture_output=True, text=True, timeout=300,
    )
    report = json.loads(check_report.stdout)
    totals = report.get("totals", {})
    check(
        "the engine's oracle recalculates every formula cell",
        totals.get("mismatched") == 0 and totals.get("matched") == totals.get("formulaCells"),
        json.dumps(totals),
    )
    check(
        "the saved workbook round-trips without a difference",
        totals.get("roundTripDiffering") == 0 and totals.get("roundTripFailed") == 0,
        json.dumps(totals),
    )
    check("the engine's oracle exits cleanly", check_report.returncode == 0)

    evaluated = subprocess.run(
        [
            "gridcraft-cli", "eval",
            "=SUM(Consolidated.Lines)+Consolidated.Elimination",
            "--in", str(workbook_path),
            "--sheet", "Consolidated",
            "--cell", "B10",
            "--json",
        ],
        capture_output=True, text=True, timeout=120,
    )
    try:
        oracle_total = float(evaluated.stdout.strip())
    except ValueError:
        oracle_total = float("nan")
    check(
        "the engine evaluates the total formula on the saved workbook",
        close_to(oracle_total, proof["consolidated_total"]),
        "%s != %s" % (oracle_total, proof["consolidated_total"]),
    )

    # -- the consolidated formulas ----------------------------------------
    formulas = proof["audit"]["consolidated_formulas"]
    check(
        "no consolidated formula crosses a sheet boundary",
        all("!" not in formula for formula in formulas),
        str([formula for formula in formulas if "!" in formula]),
    )
    read_names = set()
    for formula in formulas:
        read_names.update(formula_names(formula))
    check(
        "every consolidated formula reads defined names only",
        read_names and read_names <= set(engine_names),
        str(sorted(read_names - set(engine_names))),
    )
    check(
        "the consolidated formulas read the FX rates",
        {"FX.EUR.USD", "FX.SGD.USD", "FX.BRL.USD"} <= read_names,
        str(sorted(read_names)),
    )
    check(
        "the consolidated total reads the named elimination",
        "Consolidated.Elimination" in read_names,
        str(sorted(read_names)),
    )

    # -- the engine's own audit -------------------------------------------
    audit = proof["audit"]
    check(
        "the engine's audit found no circular reference",
        audit["error_checking"]["circular"] == [],
        str(audit["error_checking"]["circular"]),
    )
    check(
        "the engine's audit found no error cell",
        audit["error_checking"]["errors"] == [],
        str(audit["error_checking"]["errors"]),
    )
    check(
        "the tracer finds no raw precedent on the consolidated cells",
        all(trace == [] for trace in audit["trace_precedents"].values()),
        json.dumps(audit["trace_precedents"]),
    )

    # -- the arithmetic, recomputed from the fixtures ----------------------
    entity_totals, elimination_total, consolidated_total = expected_totals()
    for entity, _currency in ENTITIES:
        check(
            "%s consolidates to the fixture arithmetic" % entity,
            close_to(proof["entity_totals"][entity], entity_totals[entity]),
            "%s != %s" % (proof["entity_totals"][entity], entity_totals[entity]),
        )
    check(
        "the eliminations total matches the fixture",
        close_to(proof["elimination_total"], elimination_total),
        "%s != %s" % (proof["elimination_total"], elimination_total),
    )
    check(
        "the consolidated total is the entity sum less the eliminations",
        close_to(proof["consolidated_total"], consolidated_total),
        "%s != %s" % (proof["consolidated_total"], consolidated_total),
    )
    check("the invariant holds", proof["invariant_holds"] is True)
    for line in audit["line_checks"]:
        check(
            "the consolidated line %s matches the fixture arithmetic" % line["canonical_account"],
            line["matches"] is True,
            json.dumps(line),
        )
    for coverage in audit["entity_coverage"]:
        check(
            "the canonical chart covers every line of %s" % coverage["entity"],
            close_to(coverage["local_total"], coverage["usd_total"] / coverage["rate"]),
            json.dumps(coverage),
        )

    # -- the cold read -----------------------------------------------------
    cold = proof["cold_read"]
    check(
        "the re-opened workbook holds the same sheets",
        cold["sheets"] == EXPECTED_SHEETS,
        str(cold["sheets"]),
    )
    check(
        "the re-opened workbook keeps every defined name",
        cold["names"] == sorted(engine_names),
    )
    check(
        "the re-opened workbook reproduces the consolidated total",
        close_to(cold["values"][-1], proof["consolidated_total"]),
        "%s != %s" % (cold["values"][-1], proof["consolidated_total"]),
    )
    check(
        "the re-opened workbook recalculates to the same numbers",
        [float(value) for value in cold["recalculated"]] == [float(value) for value in cold["values"]],
        json.dumps(cold["recalculated"]),
    )
    check(
        "the re-opened workbook holds no error cell",
        cold["error_checking"]["circular"] == [] and cold["error_checking"]["errors"] == [],
        json.dumps(cold["error_checking"]),
    )

    # -- the formatting ----------------------------------------------------
    client = MCPClient(["gridcraft-cli", "mcp"])
    try:
        client.initialize()
        client.tool("open_workbook", {"path": str(workbook_path)})
        header = client.command("cell.get", {"sheet": "Helios-US", "cell": "A1"})
        check("the imported header row is bold", header["style"]["font"]["bold"] is True)
        amount = client.command("cell.get", {"sheet": "Helios-US", "cell": "C4"})
        check(
            "the imported amounts carry thousands separators and red negatives",
            amount["style"]["num_fmt"] == "#,##0.00;[Red]-#,##0.00",
            amount["style"]["num_fmt"],
        )
        display = client.tool(
            "read_range", {"sheet": "Helios-US", "range": "A2:C5", "formatted": True}
        )
        check(
            "the amounts are displayed with thousands separators",
            display["values"][2][2] == "-1,180,000.00",
            json.dumps(display["values"]),
        )
        total_cell = client.command("cell.get", {"sheet": "Consolidated", "cell": "B10"})
        check(
            "the consolidated total is a formula, not a constant",
            str(total_cell.get("formula", "")).startswith("="),
            json.dumps(total_cell.get("formula")),
        )
        check(
            "the consolidated total reads the named schema",
            "Consolidated.Lines" in str(total_cell.get("formula"))
            and "!" not in str(total_cell.get("formula")),
            json.dumps(total_cell.get("formula")),
        )
    finally:
        client.close()

    # -- idempotence -------------------------------------------------------
    out_dir_two = work / "out-two"
    second = run_solution(fixtures, out_dir_two)
    check("the second run exits cleanly", second.returncode == 0,
          "exit=%d %s" % (second.returncode, second.stderr[-400:]))
    workbook_two = out_dir_two / "helios-consolidated.xlsx"
    check("the second run saves the workbook", workbook_two.is_file())
    if workbook_two.is_file():
        check(
            "the saved workbook is byte-identical",
            hashlib.sha256(workbook_two.read_bytes()).hexdigest()
            == hashlib.sha256(payload).hexdigest(),
        )
    proof_two_path = out_dir_two / "consolidation-proof.json"
    if check("the second run writes the proof", proof_two_path.is_file()):
        proof_two = json.loads(proof_two_path.read_text())
        first = dict(proof)
        second_proof = dict(proof_two)
        first.pop("duration_ms", None)
        second_proof.pop("duration_ms", None)
        check("the two proofs are identical", first == second_proof,
              json.dumps({key: [first.get(key), second_proof.get(key)]
                          for key in sorted(set(first) | set(second_proof))
                          if first.get(key) != second_proof.get(key)}))
        check(
            "the two runs report the same consolidated total",
            close_to(proof_two["consolidated_total"], proof["consolidated_total"]),
        )

    # -- the fail-closed paths ---------------------------------------------
    label_drift = corrupt(fixtures, work / "fixtures-label", "Helios-EU",
                           "4000,Net Revenue,", "4000,Total Revenue,")
    drifted = run_solution(label_drift, work / "out-label")
    check("a renamed line fails the run closed", drifted.returncode == 2,
          "exit=%d" % drifted.returncode)
    check("the failure is a structured error, not a stack trace",
          "Traceback" not in drifted.stdout and "Traceback" not in drifted.stderr)
    try:
        drift = json.loads(drifted.stdout)
    except json.JSONDecodeError:
        drift = {}
    check("the failure names the drifted entity", drift.get("entity") == "Helios-EU",
          json.dumps(drift))
    check("the failure names the drifted account", drift.get("account") == "4000",
          json.dumps(drift))
    check("the failure names the defined name that could not be anchored",
          drift.get("named_range") == "Helios_EU.Amount.Rev_Net", json.dumps(drift))
    check("the failure is labelled as label drift", drift.get("error") == "label_drift",
          json.dumps(drift))
    error_file = work / "out-label" / "consolidation-error.json"
    check("the failure is written to disk", error_file.is_file())
    if error_file.is_file():
        stored = json.loads(error_file.read_text())
        check("the stored error is the same structured error",
              stored.get("error") == "label_drift" and stored.get("entity") == "Helios-EU")

    renumbered = corrupt(fixtures, work / "fixtures-code", "Helios-EU",
                          "4000,Net Revenue,", "4001,Net Revenue,")
    renumbered_run = run_solution(renumbered, work / "out-code")
    check("a renumbered account fails the run closed", renumbered_run.returncode == 2,
          "exit=%d" % renumbered_run.returncode)
    try:
        renumbered_error = json.loads(renumbered_run.stdout)
    except json.JSONDecodeError:
        renumbered_error = {}
    check("the renumbering names the missing defined name",
          renumbered_error.get("error") == "missing_account"
          and renumbered_error.get("named_range") == "Helios_EU.Amount.Rev_Net",
          json.dumps(renumbered_error))

    unknown = work / "fixtures-unknown"
    unknown.mkdir(parents=True, exist_ok=True)
    for fixture in sorted(fixtures.iterdir()):
        shutil.copy(fixture, unknown / fixture.name)
    extra = unknown / ("helios-us-%s.csv" % PERIOD)
    extra.write_text(
        extra.read_text(encoding="utf-8") + "7000,Marketing Expense,120000.00,USD,%s\n" % PERIOD,
        encoding="utf-8",
    )
    unknown_run = run_solution(unknown, work / "out-unknown")
    check("an account the parent does not know fails the run closed",
          unknown_run.returncode == 2, "exit=%d" % unknown_run.returncode)
    try:
        unknown_error = json.loads(unknown_run.stdout)
    except json.JSONDecodeError:
        unknown_error = {}
    check("the unknown account is named",
          unknown_error.get("error") == "unmapped_account"
          and unknown_error.get("account") == "7000"
          and unknown_error.get("entity") == "Helios-US",
          json.dumps(unknown_error))

    if FAILURES:
        print("FAILED: %s" % ", ".join(FAILURES))

    # --- publish the headline artefacts next to the harness log ------------
    publish = work.parent
    shutil.copy2(out_dir / "helios-consolidated.xlsx", publish / "helios-consolidated.xlsx")
    shutil.copy2(out_dir / "consolidation-proof.json", publish / "consolidation-proof.json")
    shutil.copy2(work / "out-code" / "consolidation-error.json", publish / "consolidation-error.json")

    print("%d assertions passed" % PASSED)
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
