#!/usr/bin/env python3
"""
run_ex2.py -- the acceptance harness for exercise 2.

It builds the exercise's fixtures, runs `06_helios_scenario.py` against the
real GridCraft engine, and then checks the artefacts the run left behind:
the workbook (re-opened by the engine itself), the dependency map, the race
report and the engine's own audit output.  Every check prints one
`PASS <label>` line; the run ends with the number of assertions that passed.

The harness needs the ArtCraft CLIs on PATH (it adds the repository's
`tools/craft-cli/bin` when they are there) and nothing else: no API key, no
network, no service to start.
"""
from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[3]
CLIS = REPO / "tools" / "craft-cli" / "bin"
SOLUTION = HERE / "02_scenario-toggle-architecture-with-cascading-assumption-cells.py"

EXPECTED_SHEETS = ["Assumptions", "Overrides", "Revenue", "Cost", "EBITDA", "BalanceSheet"]
ASSUMPTION_KEYS = [
    "headcount.sales.q1",
    "arr",
    "churn",
    "gm",
    "cac",
    "price.eur",
]
TOP_LINES = ["Revenue.TopLine", "Cost.TopLine", "EBITDA.TopLine", "BalanceSheet.TopLine"]
SCENARIO_INDEX = {"Bear": 1, "Base": 2, "Bull": 3, "Doom": 4}

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
def build_fixtures(work: Path) -> Dict[str, Any]:
    """The assumption table the model is built from.

    The numbers are index points (last year = 100) and the standing override
    is the controller's gross-margin sensitivity.
    """
    table = {
        "assumptions": {
            "headcount.sales.q1": {"Bear": 78.0, "Base": 100.0, "Bull": 121.0, "Doom": 63.0},
            "arr": {"Bear": 88.0, "Base": 100.0, "Bull": 118.0, "Doom": 71.0},
            "churn": {"Bear": 0.12, "Base": 0.08, "Bull": 0.05, "Doom": 0.18},
            "gm": {"Bear": 0.58, "Base": 0.64, "Bull": 0.70, "Doom": 0.50},
            "cac": {"Bear": 112.0, "Base": 100.0, "Bull": 91.0, "Doom": 134.0},
            "price.eur": {"Bear": 94.0, "Base": 100.0, "Bull": 107.0, "Doom": 88.0},
        },
        "overrides": {"gm": 0.66},
    }
    fixtures = work / "fixtures"
    fixtures.mkdir(parents=True, exist_ok=True)
    path = fixtures / "helios-scenario-table.json"
    path.write_text(json.dumps(table, indent=2))
    return table


def expected_outputs(table: Dict[str, Any], scenario: str) -> Dict[str, float]:
    """Recompute the model's top lines from the fixture, independently."""
    assumptions = table["assumptions"]
    overrides = table["overrides"]

    def effective(key: str) -> float:
        if key in overrides:
            return float(overrides[key])
        return float(assumptions[key][scenario])

    revenue = effective("arr") * (1.0 - effective("churn")) * effective("price.eur")
    cost = effective("headcount.sales.q1") * effective("cac") * (1.0 - effective("gm"))
    return {
        "Revenue.TopLine": revenue,
        "Cost.TopLine": cost,
        "EBITDA.TopLine": revenue - cost,
        "BalanceSheet.TopLine": revenue - cost,
        "Effective.arr": effective("arr"),
    }


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
    table = build_fixtures(work)
    out_dir = work / "out"
    fixture_path = work / "fixtures" / "helios-scenario-table.json"
    print("work directory: %s" % work, file=sys.stderr)

    completed = subprocess.run(
        [
            sys.executable,
            str(SOLUTION),
            "--out-dir",
            str(out_dir),
            "--scenario-table",
            str(fixture_path),
            "--duration",
            "10",
        ],
        capture_output=True,
        text=True,
        timeout=600,
    )
    check("solution exits cleanly", completed.returncode == 0, "exit=%d %s" % (completed.returncode, completed.stderr[-400:]))
    check("solution writes no stderr", completed.stderr.strip() == "", completed.stderr[-400:])
    check("solution reports the artefacts", "report" in completed.stdout)

    report_path = out_dir / "scenario-race-report.json"
    map_path = out_dir / "dependency-map.json"
    workbook_path = out_dir / "helios-scenario-model.xlsx"
    if not check("the race report exists", report_path.is_file()):
        print("0 assertions passed")
        return 1
    report = json.loads(report_path.read_text())
    check("the dependency map exists", map_path.is_file())
    check("the workbook exists", workbook_path.is_file())
    if not workbook_path.is_file():
        print("0 assertions passed")
        return 1

    # -- the workbook is a real workbook --------------------------------
    check("the workbook is an xlsx container", zipfile.is_zipfile(workbook_path))
    info = json.loads(
        subprocess.run(
            ["gridcraft-cli", "info", str(workbook_path), "--json"],
            capture_output=True,
            text=True,
            timeout=120,
        ).stdout
    )
    sheet_names = [sheet["name"] for sheet in info.get("sheets", [])]
    check("the workbook has the six model sheets", sheet_names == EXPECTED_SHEETS, str(sheet_names))
    names = {entry["name"]: entry for entry in info.get("names", [])}
    expected_names = (
        ["Scenario.Active"]
        + ["Scenario.Value.%s" % key for key in ASSUMPTION_KEYS]
        + ["Overrides.Value.%s" % key for key in ASSUMPTION_KEYS]
        + ["Effective.%s" % key for key in ASSUMPTION_KEYS]
        + TOP_LINES
    )
    check(
        "the workbook defines every model name",
        all(name in names for name in expected_names),
        "%d names" % len(names),
    )
    extra = sorted(set(names) - set(expected_names))
    check(
        "the only other name is the engine's own scenario store",
        extra == ["_sc_scenarios"],
        str(extra),
    )
    check(
        "every defined name is fully absolute",
        all("$" in names[name]["refersTo"] for name in expected_names),
        "a name with a relative row would re-anchor to the cell that reads it",
    )
    check(
        "the report's workbook digest matches the file on disk",
        report["artifacts"]["workbook_sha256"]
        == hashlib.sha256(workbook_path.read_bytes()).hexdigest(),
    )

    # -- the dependency map ---------------------------------------------
    graph = report["dependency_map"]
    check("the dependency map is a DAG", graph["acyclic"] is True)
    check("the dependency map has 23 nodes", len(graph["nodes"]) == len(expected_names))
    check("the dependency map has 27 edges", len(graph["edges"]) == 27, str(len(graph["edges"])))
    check(
        "every edge joins two nodes of the map",
        all(edge["from"] in graph["nodes"] and edge["to"] in graph["nodes"] for edge in graph["edges"]),
    )
    check("the map's depth is five", graph["depth_max"] == 5, str(graph["depth_max"]))
    check("the map was computed under the base scenario", graph["computed_under_scenario"] == 2)
    check(
        "the engine's own audit found no circular reference",
        graph["engine_audit"]["circular"] == [],
        str(graph["engine_audit"]["circular"]),
    )
    check(
        "the engine's own audit found no error cell",
        graph["engine_audit"]["errors"] == [],
        str(graph["engine_audit"]["errors"]),
    )
    check(
        "the tracer agrees with the parsed references",
        graph["trace_cross_check"]["mismatches"] == [],
        str(graph["trace_cross_check"]["mismatches"]),
    )
    check(
        "the map was cross-checked on every formula cell",
        graph["trace_cross_check"]["checked"] == 16,
        str(graph["trace_cross_check"]["checked"]),
    )
    check(
        "the map's edges follow the Effective layer",
        {"from": "Effective.arr", "to": "Revenue.TopLine"} in graph["edges"]
        and {"from": "Scenario.Active", "to": "Scenario.Value.arr"} in graph["edges"]
        and {"from": "Overrides.Value.gm", "to": "Effective.gm"} in graph["edges"],
    )

    # -- the model arithmetic, recomputed from the fixture ---------------
    base = expected_outputs(table, "Base")
    bear = expected_outputs(table, "Bear")
    bull = expected_outputs(table, "Bull")
    outputs = report["named_outputs"]
    for name in TOP_LINES:
        check(
            "%s matches the fixture arithmetic" % name,
            close_to(outputs[name], base[name]),
            "%s != %s" % (outputs[name], base[name]),
        )
    check(
        "the override wins over the scenario column",
        close_to(report["effective_assumptions"][3]["effective_value"], 0.66)
        and close_to(report["effective_assumptions"][3]["scenario_value"], 0.64),
    )
    check(
        "the assumption audit names every assumption",
        [entry["name"] for entry in report["effective_assumptions"]] == ASSUMPTION_KEYS,
    )
    check(
        "the assumption audit reports the dependents",
        report["effective_assumptions"][1]["used_by"] == ["Revenue.TopLine"],
    )
    check(
        "the legal scenario values match the fixture arithmetic",
        close_to(report["race"]["legal_values"][0], bear["Effective.arr"])
        and close_to(report["race"]["legal_values"][1], bull["Effective.arr"]),
        str(report["race"]["legal_values"]),
    )
    scenario_outputs = report["scenario_outputs"]
    check(
        "every scenario resolves",
        sorted(scenario_outputs) == ["Base", "Bear", "Bull", "Doom"]
        and all(len(values) == len(TOP_LINES) for values in scenario_outputs.values()),
        str(sorted(scenario_outputs)),
    )
    check(
        "the four scenarios produce four different top lines",
        len({values["Revenue.TopLine"] for values in scenario_outputs.values()}) == 4,
        json.dumps(scenario_outputs),
    )
    for scenario in ("Bear", "Base", "Bull"):
        check(
            "the %s scenario matches the fixture arithmetic" % scenario,
            close_to(scenario_outputs[scenario]["Revenue.TopLine"], expected_outputs(table, scenario)["Revenue.TopLine"])
            and close_to(scenario_outputs[scenario]["EBITDA.TopLine"], expected_outputs(table, scenario)["EBITDA.TopLine"]),
            json.dumps(scenario_outputs[scenario]),
        )

    # -- the race --------------------------------------------------------
    race = report["race"]
    check("the race ran for ten seconds", race["duration_s"] == 10.0, str(race["duration_s"]))
    check("the scheduler toggled at least a hundred times", race["toggles"] >= 100, str(race["toggles"]))
    check("the reader completed at least a hundred reads", race["reads"] >= 100, str(race["reads"]))
    check("no read fell outside the two legal values", race["illegal_reads"] == 0, str(race["illegal_reads"]))
    check("the reader saw both scenarios", race["both_scenarios_seen"] is True)
    check(
        "the observed values are exactly the legal values",
        sorted(race["distinct_values_observed"]) == sorted(race["legal_values"]),
        str(race["distinct_values_observed"]),
    )
    check(
        "the read latency is reported",
        0.0 < race["max_read_latency_ms"] < 5000.0,
        str(race["max_read_latency_ms"]),
    )
    check(
        "the control channel's counters match the children",
        race["control_channel_counters"]["toggles_applied"] == race["scheduler"]["toggles"]
        and race["control_channel_counters"]["reads_served"] == race["reader"]["reads"],
        json.dumps(race["control_channel_counters"]),
    )
    check("the scheduler saw no error", race["scheduler"]["errors"] == [])

    # -- fail closed ------------------------------------------------------
    fail_closed = report["fail_closed"]
    control = fail_closed["control_channel"]
    check("the control channel rejected index five", control["rejected"] is True)
    check(
        "the rejection is a structured error",
        control["error"]["code"] == "illegal_scenario_index"
        and control["error"]["legal_indexes"] == [1, 2, 3, 4],
        json.dumps(control["error"]),
    )
    check("the previous scenario stayed in effect", control["state_held"] is True)
    check("no write was persisted by the rejected frame", control["workbook_unchanged"] is True)
    model_level = fail_closed["model"]
    check(
        "an illegal index in the sheet fails the model closed",
        model_level["effective_value"] == {"error": "#VALUE!"},
        json.dumps(model_level["effective_value"]),
    )
    check(
        "the engine's audit names the failing cells",
        len(model_level["engine_audit"]["errors"]) >= 6
        and all("error" in item for item in model_level["engine_audit"]["errors"]),
    )
    check("the model was restored", model_level["restored"] is True)

    # -- idempotence -------------------------------------------------------
    idempotence = report["idempotence"]
    check("the toggle was applied twice to the same index", idempotence["scenario_index"] == 2)
    check("every named output was compared", idempotence["names_compared"] == len(expected_names))
    check("the named outputs are bit-identical", idempotence["outputs_identical"] is True)
    check("the saved workbook is byte-identical", idempotence["workbook_bytes_identical"] is True)

    # -- the engine re-opens the artefact ---------------------------------
    client = MCPClient(["gridcraft-cli", "mcp"])
    try:
        client.request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "run-ex2", "version": "1.0"},
            },
        )
        client.tool("open_workbook", {"path": str(workbook_path)})
        reopened = {entry["name"]: entry for entry in client.tool("execute_command", {"command": "formulas.nameManager", "params": {}})}
        check("the engine re-opens the workbook with every name", sorted(reopened) == sorted(expected_names))
        check(
            "the re-opened workbook keeps the base scenario",
            close_to(reopened["Scenario.Active"]["value"], 2),
            str(reopened["Scenario.Active"]["value"]),
        )
        check(
            "the re-opened workbook keeps the effective assumption",
            close_to(reopened["Effective.arr"]["value"], base["Effective.arr"]),
            str(reopened["Effective.arr"]["value"]),
        )
        check(
            "the re-opened workbook keeps the revenue top line",
            close_to(reopened["Revenue.TopLine"]["value"], base["Revenue.TopLine"]),
            str(reopened["Revenue.TopLine"]["value"]),
        )
        check(
            "the re-opened workbook keeps the override",
            close_to(reopened["Effective.gm"]["value"], 0.66),
            str(reopened["Effective.gm"]["value"]),
        )
    finally:
        client.close()

    # -- the published frame contracts ------------------------------------
    auth_contract = load_jsonc((HERE / "01_json.json").read_text())[0]
    frames_contract = load_jsonc((HERE / "02_json.json").read_text())
    protocol = report["control_protocol"]
    check(
        "the auth frame matches the protocol the server speaks",
        auth_contract["method"] == protocol["auth_frame"]["method"]
        and auth_contract["id"] == protocol["auth_frame"]["id"]
        and sorted(auth_contract["params"]) == sorted(protocol["auth_frame"]["params"]),
        json.dumps(auth_contract),
    )
    check(
        "the request frames match the protocol the server speaks",
        len(frames_contract) == len(protocol["frames"])
        and all(
            frame["method"] == published["method"] and frame["params"] == published["params"]
            for frame, published in zip(frames_contract, protocol["frames"])
        ),
        json.dumps(frames_contract),
    )

    if FAILURES:
        print("FAILED: %s" % ", ".join(FAILURES))

    # --- publish the headline artefacts next to the harness log ------------
    publish = work.parent
    shutil.copy2(out_dir / "helios-scenario-model.xlsx", publish / "helios-scenario-model.xlsx")
    shutil.copy2(out_dir / "scenario-race-report.json", publish / "scenario-race-report.json")
    shutil.copy2(out_dir / "dependency-map.json", publish / "dependency-map.json")

    print("%d assertions passed" % PASSED)
    return 1 if FAILURES else 0


def strip_jsonc(text: str) -> str:
    """Remove the `//` comments of a JSONC file (comments in strings survive)."""
    out: List[str] = []
    in_string = False
    escaped = False
    index = 0
    while index < len(text):
        character = text[index]
        if in_string:
            out.append(character)
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            index += 1
            continue
        if character == '"':
            in_string = True
            out.append(character)
            index += 1
            continue
        if character == "/" and text[index : index + 2] == "//":
            while index < len(text) and text[index] != "\n":
                index += 1
            continue
        out.append(character)
        index += 1
    return "".join(out)


def load_jsonc(text: str) -> List[Any]:
    """Read the JSON objects of a JSONC file (one or more, any layout)."""
    decoder = json.JSONDecoder()
    stripped = strip_jsonc(text)
    objects: List[Any] = []
    index = 0
    while index < len(stripped):
        while index < len(stripped) and stripped[index].isspace():
            index += 1
        if index >= len(stripped):
            break
        value, index = decoder.raw_decode(stripped, index)
        objects.append(value)
    return objects


if __name__ == "__main__":
    sys.exit(main())
