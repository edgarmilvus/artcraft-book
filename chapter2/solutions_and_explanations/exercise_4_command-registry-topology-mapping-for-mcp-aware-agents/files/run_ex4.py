#!/usr/bin/env python3
"""
run_ex4.py -- acceptance harness for Chapter 2, Exercise 4.

Runs the registry topology mapper against the real DesignCraft MCP server,
persists the inline report, then opens a second MCP session and recomputes
every bucket, example, escape command and domain histogram from the live
registry. A failure exits non-zero.
"""
from __future__ import annotations

import importlib.util
import json
import os
import shutil
import subprocess
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent / "output"
CLIS = HERE.parents[3] / "tools" / "craft-cli" / "bin"
SOLUTION = HERE / "04_command-registry-topology-mapping-for-mcp-aware-agents.py"
BUCKET_ORDER = ["ALWAYS_ENABLED", "NEEDS_DOCUMENT", "NEEDS_SELECTION",
                "NEEDS_TEXT_CARET", "NEEDS_FRAME_OR_STORY", "NEEDS_STATE"]

checks = 0
failures: list[str] = []
quirks: list[str] = []
lines: list[str] = []


def say(line: str = "") -> None:
    lines.append(line)
    print(line)


def check(label: str, condition: bool, detail: str = "") -> None:
    global checks
    checks += 1
    if not condition:
        failures.append(label)
    say(f"{' ok ' if condition else 'FAIL'} {label:<58}{detail}")


def equal(label: str, actual: object, expected: object, detail: str = "") -> None:
    check(label, actual == expected, detail or f"expected {expected!r}, got {actual!r}")


def load_solution():
    spec = importlib.util.spec_from_file_location("registry_topology_solution", SOLUTION)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    for stale in ("registry_topology.json", "run-log.json", "run_ex4.log"):
        target = OUT / stale
        if target.exists():
            target.unlink()

    env = dict(os.environ)
    env["PATH"] = f"{CLIS}:{env.get('PATH', '')}"

    run = subprocess.run([sys.executable, SOLUTION.name], cwd=HERE, env=env,
                         capture_output=True, text=True, timeout=180)
    (OUT / "mapper.log").write_text(run.stdout + run.stderr, encoding="utf-8")
    equal("registry mapper exits cleanly", run.returncode, 0)
    check("mapper printed no traceback", "Traceback (most recent call last)" not in run.stderr)
    check("mapper emits JSON on stdout", run.stdout.strip().startswith("{"))
    check("stdout is one JSON document", run.stdout.strip().startswith("{") and run.stdout.strip().endswith("}"))

    raw = run.stdout.strip()
    report = json.loads(raw)
    (OUT / "registry_topology.json").write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    check("report persists at the contract path", (OUT / "registry_topology.json").exists(),
          f"{(OUT / 'registry_topology.json').stat().st_size} bytes")

    # ── report shape ───────────────────────────────────────────────────────
    equal("app is designcraft", report.get("app"), "designcraft")
    equal("audit declares no mutation", report.get("mutated"), False)
    check("timestamp parses", isinstance(report.get("generated_at"), str)
          and report["generated_at"].endswith("Z"))
    snapshots = report.get("snapshots") or {}
    equal("enabled-only snapshot count", snapshots.get("enabled_only_count"), 269)
    equal("full registry count", snapshots.get("all_count"), 444)
    check("enabled commands are a subset of all commands",
          snapshots.get("enabled_only_count", 0) <= snapshots.get("all_count", 0))

    buckets = report.get("buckets") or []
    equal("six buckets", len(buckets), 6)
    equal("bucket order is the precedence order", [b.get("name") for b in buckets], BUCKET_ORDER)
    equal("bucket counts partition the registry", sum(b.get("count", 0) for b in buckets),
          snapshots.get("all_count"))
    equal("ALWAYS_ENABLED is the enabled snapshot", buckets[0].get("count"),
          snapshots.get("enabled_only_count"))
    check("every bucket carries a count and an example",
          all(isinstance(b.get("count"), int) and b["count"] >= 0 for b in buckets)
          and all((b.get("example") is None) == (b.get("count") == 0) for b in buckets))
    check("disabled buckets carry a reason sample",
          all(b.get("reason_sample") for b in buckets[1:]))
    equal("ALWAYS_ENABLED has no reason sample", buckets[0].get("reason_sample"), None)
    equal("ALWAYS_ENABLED has no escape", buckets[0].get("escape"), None)
    check("every disabled bucket resolves an escape",
          all(isinstance(b.get("escape"), str) and b["escape"] for b in buckets[1:]),
          str([b.get("escape") for b in buckets[1:]]))

    domains = report.get("domains") or []
    equal("top-ten domain histogram", len(domains), 10)
    check("domain counts are descending",
          all(domains[i]["count"] >= domains[i + 1]["count"] for i in range(len(domains) - 1)),
          str([d["count"] for d in domains]))
    check("domain prefixes are unique",
          len({d["prefix"] for d in domains}) == len(domains))
    check("every domain has central commands",
          all(isinstance(d.get("central"), list) and d["central"] for d in domains))
    check("domain budget stays under the registry size",
          sum(d["count"] for d in domains) <= snapshots.get("all_count", 0),
          f"{sum(d['count'] for d in domains)} of {snapshots.get('all_count')} (top 10 only)")

    notes = " ".join(report.get("notes") or [])
    equal("report carries three notes", len(report.get("notes") or []), 3)
    check("notes name the `list_commands` divergence", "list_commands" in notes and "command_list" in notes)
    check("notes explain the inline return", "INLINE" in notes)
    check("notes state the audit is read-only", "never calls execute" in notes)

    # ── independent second session: recompute from the live registry ──────
    module = load_solution()
    server = module.MCPServer([str(CLIS / "designcraft-cli"), "mcp"])
    server.initialize()
    try:
        enabled_raw = server.tool("list_commands", enabledOnly=True)
        all_raw = server.tool("list_commands")
        enabled_list = list(enabled_raw) if isinstance(enabled_raw, list) else enabled_raw.get("commands", [])
        all_list = list(all_raw) if isinstance(all_raw, list) else all_raw.get("commands", [])
        enabled_ids = {c.get("id", "") for c in enabled_list if c.get("id")}

        equal("live enabled count matches the report", len(enabled_list), snapshots.get("enabled_only_count"))
        equal("live registry count matches the report", len(all_list), snapshots.get("all_count"))

        counts = Counter(module.bucket_for(c) for c in all_list)
        for bucket in buckets:
            name = bucket["name"]
            equal(f"{name} count matches the live registry", bucket["count"], counts.get(name, 0))
            members = [c for c in all_list if module.bucket_for(c) == name]
            if members:
                equal(f"{name} example is the first live member", bucket["example"], members[0].get("id"))
                equal(f"{name} reason sample is the live reason", bucket["reason_sample"],
                      module.reason_of(members[0]) if name != "ALWAYS_ENABLED" else None)
            if name != "ALWAYS_ENABLED":
                equal(f"{name} escape is a live enabled command", bucket["escape"],
                      module.resolve_escape(name, enabled_ids))
                check(f"{name} escape is actually enabled", bucket["escape"] in enabled_ids)

        equal("escapes resolve from the enabled set, not the full set",
              all(b["escape"] in enabled_ids for b in buckets[1:] if b.get("escape")), True)

        domain_counter = Counter(module.domain_of(c["id"]) for c in all_list if c.get("id"))
        equal("live domain prefixes match the report",
              [d["prefix"] for d in domains], [d for d, _ in domain_counter.most_common(10)])
        for domain in domains:
            prefix = domain["prefix"]
            equal(f"{prefix} domain count matches the live registry", domain["count"],
                  domain_counter[prefix])
            expected_central = module.central_commands_for_domain(prefix, all_list,
                                                                  {b["name"]: b["escape"] for b in buckets[1:]})
            equal(f"{prefix} central commands match the live registry", domain["central"],
                  expected_central)

        # The sibling suites expose `command_list`; DesignCraft must not alias it.
        alias_reply = server._rpc("tools/call", {"name": "command_list", "arguments": {}})
        alias_text = " ".join(block.get("text", "") for block in alias_reply.get("content", []))
        check("`command_list` is not aliased on DesignCraft",
              alias_reply.get("isError") is True and "unknown tool" in alias_text, alias_text[:90])
        quirks.append("DesignCraft names the registry tool `list_commands`, while the sibling suites expose `command_list`")

    finally:
        server.close()

    equal("persisted report round-trips", json.loads((OUT / "registry_topology.json").read_text())["buckets"],
          report["buckets"])

    say()
    say(f"{checks} checks, {len(failures)} failing; {len(quirks)} engine quirk(s); artefacts in {OUT}")
    (OUT / "run-log.json").write_text(json.dumps({
        "checks": checks,
        "failures": failures,
        "quirks": quirks,
        "snapshots": snapshots,
        "buckets": [{"name": b["name"], "count": b["count"], "escape": b["escape"]} for b in buckets],
    }, indent=2), encoding="utf-8")
    (OUT / "run_ex4.log").write_text("\n".join(lines) + "\n", encoding="utf-8")
    return 1 if failures else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as error:  # noqa: BLE001 - the harness must fail loudly
        say(f"FAIL harness crashed: {error}")
        (OUT / "run_ex4.log").write_text("\n".join(lines) + "\n", encoding="utf-8")
        raise
