#!/usr/bin/env python3
"""
run_ex2.py -- acceptance harness for Chapter 5 Exercise 2.

Runs the worked authenticated control client against a protocol-faithful
loopback stub and keeps the evidence: the append-only ledger, the snapshots
before and after recovery, the recovered server history and a machine-readable
report under ../output/.
"""
from __future__ import annotations

import asyncio
import dataclasses
import hashlib
import importlib.util
import json
import os
import pathlib
import shutil
import sys

HERE = pathlib.Path(__file__).resolve().parent
OUT = HERE.parent / "output"
LEDGER_DIR = OUT / "ledger"
SESSION_DIR = OUT / "session"
RECON_DIR = OUT / "reconciliation"

for directory in (LEDGER_DIR, SESSION_DIR, RECON_DIR):
    shutil.rmtree(directory, ignore_errors=True)
    directory.mkdir(parents=True, exist_ok=True)

LEDGER_PATH = LEDGER_DIR / "ledger.jsonl"
sys.path.insert(0, str(HERE))

spec = importlib.util.spec_from_file_location(
    "exercise_2_solution",
    HERE / "02_an-authenticated-tcp-loopback-client-with-session-immutability-and-reconnection-semantics.py",
)
sol = importlib.util.module_from_spec(spec)
sys.modules["exercise_2_solution"] = sol
assert spec.loader
spec.loader.exec_module(sol)

from _stub_server import ControlServer, TOKEN  # noqa: E402

passed = 0
failed = 0
results: list[dict[str, object]] = []


async def check(name: str, fn) -> None:
    global passed, failed
    try:
        await fn()
        passed += 1
        results.append({"name": name, "ok": True})
        print(f"PASS {name}")
    except Exception as exc:  # noqa: BLE001
        failed += 1
        results.append({"name": name, "ok": False, "error": f"{type(exc).__name__}: {exc}"})
        print(f"FAIL {name}: {type(exc).__name__}: {exc}")


def snapshot_dict(snapshot: "sol.SessionSnapshot", *, redact: bool = False) -> dict[str, object]:
    data = dataclasses.asdict(snapshot)
    data["selection"] = list(data["selection"])
    if redact:
        token = str(data.pop("token"))
        data["token"] = "<redacted>"
        data["token_fingerprint"] = hashlib.sha256(token.encode()).hexdigest()[:16]
    return data


def read_ledger_lines() -> list[dict[str, object]]:
    if not LEDGER_PATH.exists():
        return []
    return [json.loads(line) for line in LEDGER_PATH.read_text().splitlines() if line.strip()]


async def main() -> None:
    server = ControlServer()
    await server.start()
    led = sol.JsonlLedger(str(LEDGER_PATH))
    client = sol.ControlClient("127.0.0.1", server.port, TOKEN, led)

    state: dict[str, object] = {
        "initial": None,
        "recovered": None,
        "unacked_after_crash": None,
        "executions_before_recovery": None,
        "executions_after_recovery": None,
    }

    print("authenticated control channel\n")

    async def test_wrong_token():
        try:
            await sol.open_authenticated("127.0.0.1", server.port, "f" * 64, timeout=2)
        except sol.AuthError as exc:
            assert "unauthorized" in str(exc), str(exc)
            return
        raise AssertionError("wrong token was accepted")

    async def test_connect():
        snapshot = await client.connect()
        state["initial"] = snapshot
        assert snapshot.active_doc_index == 0, snapshot

    async def test_execute():
        result = await client.execute("layer.newLayer", {"name": "base"})
        assert result["applied"] is True, result
        assert len(led.iter_all()) == 1, led.iter_all()
        assert led.unacked() == [], led.unacked()

    async def test_lost_reply():
        server.drop_on = "paint.stroke"
        try:
            await client.execute("paint.stroke", {"x": 1, "y": 2})
        except ConnectionError:
            pass
        else:
            raise AssertionError("expected the dropped connection to raise")
        unacked = led.unacked()
        state["unacked_after_crash"] = len(unacked)
        assert len(unacked) == 1, unacked
        assert unacked[0].command_id == "paint.stroke"

    async def test_recover():
        before = server.executions.count("paint.stroke")
        prior = client._snapshot
        snapshot = await client.recover()
        state["recovered"] = snapshot
        state["executions_before_recovery"] = before
        state["executions_after_recovery"] = server.executions.count("paint.stroke")
        assert state["executions_after_recovery"] == before, "command replayed"
        assert led.unacked() == [], led.unacked()
        assert snapshot.epoch == prior.epoch + 1
        assert snapshot.active_doc_index == 0

    async def test_pure_recover():
        prior = client._snapshot
        before = snapshot_dict(prior)
        next_snap = sol.recover(prior, {"documents": [], "history_depth": 9}, led)
        after = snapshot_dict(prior)
        assert before == after, "prior mutated"
        assert next_snap.epoch == prior.epoch + 1
        assert next_snap.active_doc_index == -1, "closed document should deactivate"
        assert next_snap.history_depth == 9

    async def test_fsm():
        strict = ControlServer(token="b" * 64)
        await strict.start()
        bad = sol.ControlClient("127.0.0.1", strict.port, "a" * 64, sol.JsonlLedger(str(LEDGER_DIR / "bad-token.jsonl")))
        fsm = sol.ReconnectFSM(bad)
        try:
            await asyncio.wait_for(fsm.run(), timeout=10)
        except sol.TokenRotationRequired:
            await strict.stop()
            return
        raise AssertionError("FSM never escalated")

    async def test_ledger_replays():
        replay = sol.JsonlLedger(str(LEDGER_PATH))
        assert replay.unacked() == [], replay.unacked()
        records = read_ledger_lines()
        issues = [r for r in records if r["kind"] == "issue"]
        acks = [r for r in records if r["kind"] == "ack"]
        assert len(issues) == 2, issues
        assert len(acks) >= 2, acks
        assert any(r.get("command_id") == "paint.stroke" for r in issues)
        assert LEDGER_PATH.read_text().endswith("\n")

    await check("a wrong token fails closed", test_wrong_token)
    await check("connect() adopts the server's active document", test_connect)
    await check("execute() records an issue and an ack", test_execute)
    await check("a lost reply leaves the command unacked", test_lost_reply)
    await check("recover() acks from history instead of replaying", test_recover)
    await check("recover() is pure: the prior snapshot is untouched", test_pure_recover)
    await check("the FSM escalates after three auth rejections", test_fsm)
    await check("the JSONL ledger replays with every command acknowledged", test_ledger_replays)

    await server.stop()

    initial = state["initial"]
    recovered = state["recovered"]
    if initial is not None:
        (SESSION_DIR / "initial.json").write_text(
            json.dumps(snapshot_dict(initial, redact=True), indent=2) + "\n"
        )
    if recovered is not None:
        (SESSION_DIR / "recovered.json").write_text(
            json.dumps(snapshot_dict(recovered, redact=True), indent=2) + "\n"
        )
    (RECON_DIR / "history.json").write_text(
        json.dumps({"history": server.history, "executions": server.executions}, indent=2) + "\n"
    )
    records = read_ledger_lines()
    (RECON_DIR / "ledger-records.json").write_text(json.dumps(records, indent=2) + "\n")
    report = {
        "exercise": 2,
        "checks": passed + failed,
        "passed": passed,
        "failed": failed,
        "results": results,
        "initial_snapshot": snapshot_dict(initial, redact=True) if initial is not None else None,
        "recovered_snapshot": snapshot_dict(recovered, redact=True) if recovered is not None else None,
        "unacked_after_crash": state["unacked_after_crash"],
        "replayed": state["executions_before_recovery"] != state["executions_after_recovery"],
        "ledger_lines": len(records),
        "ledger_issues": sum(1 for r in records if r["kind"] == "issue"),
        "ledger_acks": sum(1 for r in records if r["kind"] == "ack"),
        "artifacts": [
            "ledger/ledger.jsonl",
            "session/initial.json",
            "session/recovered.json",
            "reconciliation/history.json",
            "reconciliation/ledger-records.json",
            "report.json",
        ],
    }
    (OUT / "report.json").write_text(json.dumps(report, indent=2) + "\n")
    print(f"\n{passed}/{passed + failed} checks passed")
    raise SystemExit(0 if failed == 0 else 1)


if __name__ == "__main__":
    asyncio.run(main())
