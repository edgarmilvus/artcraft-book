#!/usr/bin/env python3
"""
Acceptance harness for Exercise 3 — the multimodal colour-grading loop.

It builds a real raw fixture, drives LightCraft's real MCP stdio surface
through the reference solution, and checks the artefacts the solution
leaves behind against the engine's own reports (its command journal, its
develop settings, its keyword tree).

No network and no API key are involved: the vision model is injected as a
deterministic stand-in.

    python3 run_ex3.py
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional, Sequence

sys.dont_write_bytecode = True

HERE = Path(__file__).resolve().parent
WORK = HERE.parent / "output" / "work"
FIXTURE_DIR = WORK / "fixture"
LIBRARY_DIR = WORK / "library"
RENDER_DIR = WORK / "renders"
AUDIT_PATH = LIBRARY_DIR / "apex" / "grade-audit.jsonl"
SUMMARY_PATH = WORK / "grade-summary.json"
BINARY = os.environ.get("LIGHTCRAFT_CLI", "lightcraft-cli")

PASSED = 0


def check(label: str, condition: Any, detail: str = "") -> None:
    """One assertion; a failure stops the run with a readable reason."""
    global PASSED
    if not condition:
        print("FAIL %s — %s" % (label, detail or "the assertion did not hold"))
        raise SystemExit(1)
    PASSED += 1
    print("PASS %s" % label)


# ────────────────────────────────────────────────────────────────────────
# The solution under test.
# ────────────────────────────────────────────────────────────────────────
def load_solution() -> Any:
    """Import the reference solution next to this harness."""
    path = HERE / "03_multimodal-colour-grading-loop-with-lightcraft-tcp-auth-and-a-vision-llm.py"
    spec = importlib.util.spec_from_file_location("apex_grade_loop", path)
    if spec is None or spec.loader is None:
        raise SystemExit("cannot load %s" % path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


# ────────────────────────────────────────────────────────────────────────
# The injected vision reviewer.
# ────────────────────────────────────────────────────────────────────────
class StandInReviewer:
    """A deterministic stand-in for the vision model.

    It answers from a script keyed by photo id, but it never accepts a
    frame it has already seen: a verdict of `ok` is downgraded to a retry
    when the render it was handed is byte-identical to the previous one,
    which is the stand-in for "the grade did not move, so the frame cannot
    look better than it did".
    """

    def __init__(self, script: Dict[int, List[Dict[str, Any]]]) -> None:
        self.script = script
        self.calls: List[Dict[str, Any]] = []
        self._last_digest: Dict[int, str] = {}

    def __call__(self, jpeg: bytes, request: Dict[str, Any]) -> Dict[str, Any]:
        photo_id = int(request["photoId"])
        iteration = int(request["iteration"])
        digest = hashlib.md5(jpeg).hexdigest()
        previous = self._last_digest.get(photo_id)
        self._last_digest[photo_id] = digest
        self.calls.append(
            {
                "photoId": photo_id,
                "iteration": iteration,
                "md5": digest,
                "bytes": len(jpeg),
            }
        )
        steps = self.script.get(photo_id)
        if not steps:
            return {"status": "ok", "violations": []}
        verdict = json.loads(json.dumps(steps[min(iteration, len(steps)) - 1]))
        if verdict.get("status") == "ok" and previous is not None and previous == digest:
            verdict = {
                "status": "retry",
                "violations": ["other"],
                "fix": {"control": "light.contrast", "delta": 1.0},
            }
        return verdict


def retry_verdict(control: str, delta: float, violation: str) -> Dict[str, Any]:
    return {
        "status": "retry",
        "violations": [violation],
        "fix": {"control": control, "delta": delta},
    }


OK_VERDICT: Dict[str, Any] = {"status": "ok", "violations": []}

SCRIPT: Dict[int, List[Dict[str, Any]]] = {
    # Converges: three retries on `light.shadows` (the cooling rule then
    # widens the neighbourhood to `light.blacks`), then the model is happy.
    1: [
        retry_verdict("light.shadows", 10.0, "shadows"),
        retry_verdict("light.shadows", 10.0, "shadows"),
        retry_verdict("light.shadows", 10.0, "shadows"),
        OK_VERDICT,
    ],
    # Never converges: the model keeps asking for the contrast.
    2: [retry_verdict("light.contrast", 5.0, "contrast")],
    # Converges on the first look.
    3: [OK_VERDICT],
}


# ────────────────────────────────────────────────────────────────────────
# The engine session.
# ────────────────────────────────────────────────────────────────────────
class Session:
    """One LightCraft MCP process against the persistent library."""

    def __init__(self, module: Any, binary: str) -> None:
        self.module = module
        self.root = module.ApexRoot(WORK)
        self.client = module.McpStdioClient(
            [binary, "mcp", "--library", str(LIBRARY_DIR)],
            cwd=WORK,
            stderr_log=WORK / "lightcraft-mcp.log",
        )
        self.client.start()
        self.engine = module.LightCraft(self.client, self.root)

    def close(self) -> None:
        self.client.close()

    def __enter__(self) -> "Session":
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()


# ────────────────────────────────────────────────────────────────────────
# The fixture.
# ────────────────────────────────────────────────────────────────────────
def build_fixture(binary: str) -> List[Path]:
    """Write a real raw file the engine can open and develop."""
    if FIXTURE_DIR.exists():
        shutil.rmtree(FIXTURE_DIR)
    FIXTURE_DIR.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        [binary, "synth-merge", "hdr", "-o", str(FIXTURE_DIR)],
        cwd=str(WORK),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    if result.returncode != 0:
        raise SystemExit("synth-merge failed: %s" % result.stdout)
    return sorted(FIXTURE_DIR.glob("*.dng"))


# ────────────────────────────────────────────────────────────────────────
# The phases.
# ────────────────────────────────────────────────────────────────────────
def run_phase(
    module: Any,
    session: Session,
    reviewer: StandInReviewer,
    config: Any,
    summary_path: Path = SUMMARY_PATH,
    photo_ids: Optional[Sequence[int]] = None,
) -> Dict[str, Any]:
    """One pass of the grading loop over the library."""
    audit = module.AuditTrail(AUDIT_PATH)
    RENDER_DIR.mkdir(parents=True, exist_ok=True)
    summary = module.grade_library(
        session.engine, reviewer, config, audit, RENDER_DIR, photo_ids=photo_ids
    )
    module.write_summary(summary, summary_path)
    return summary


def journal_entries(session: Session, command: str) -> List[Dict[str, Any]]:
    return [
        entry
        for entry in session.engine.journal(limit=1000)
        if entry.get("command") == command
    ]


def commands_by_photo(journal: List[Dict[str, Any]], command: str) -> Dict[Any, int]:
    """How often `command` ran against each photo.

    The engine's journal records the active photo in every `library.select`
    entry, so walking the journal in order attributes each following
    command to the photo it acted on.
    """
    active: Any = None
    counts: Dict[Any, int] = {}
    for entry in journal:
        name = entry.get("command")
        params = entry.get("params") or {}
        if name == "library.select":
            ids = params.get("ids") or []
            active = params.get("active", ids[0] if ids else None)
        elif name == command and active is not None:
            counts[active] = counts.get(active, 0) + 1
    return counts


def load_jsonc(path: Path) -> Any:
    """Read a jsonc file: the `//` comment lines are dropped."""
    text = "\n".join(
        line
        for line in path.read_text(encoding="utf-8").splitlines()
        if not line.lstrip().startswith("//")
    )
    return json.loads(text)


def main() -> int:
    global PASSED
    binary = shutil.which(BINARY)
    check("the engine is on the PATH", binary is not None, "no %s" % BINARY)
    check("the engine is executable", os.access(str(binary), os.X_OK), str(binary))

    module = load_solution()
    check(
        "the solution exposes the loop contract",
        all(
            hasattr(module, name)
            for name in (
                "McpStdioClient",
                "LightCraft",
                "ApexRoot",
                "AuditTrail",
                "LoopConfig",
                "grade_photo",
                "grade_library",
                "validate_verdict",
            )
        ),
        "a public name is missing",
    )

    if WORK.exists():
        shutil.rmtree(WORK)
    WORK.mkdir(parents=True, exist_ok=True)

    check(
        "the voice-schema contract matches the solution",
        load_jsonc(HERE / "02_jsonc.jsonc") == module.VOICE_SCHEMA,
        "02_jsonc.jsonc and VOICE_SCHEMA disagree",
    )
    check(
        "the audit-line contract matches the solution",
        set(load_jsonc(HERE / "03_jsonc.jsonc")) == set(module.AUDIT_KEYS),
        "03_jsonc.jsonc and AUDIT_KEYS disagree",
    )
    check(
        "the audit-line contract names a real control",
        load_jsonc(HERE / "03_jsonc.jsonc")["control"] == "light.shadows",
        "03_jsonc.jsonc names a control that does not exist",
    )

    raws = build_fixture(str(binary))
    check("the fixture is a real raw file", len(raws) == 3, "found %d" % len(raws))
    check(
        "the fixture is a DNG the engine can develop",
        all(path.stat().st_size > 1_000_000 for path in raws),
        "a fixture file is too small to be a raw",
    )

    # ── phase 1: the loop over the whole library ──────────────────────
    reviewer = StandInReviewer(SCRIPT)
    with Session(module, str(binary)) as session:
        check(
            "the MCP handshake names the engine",
            session.client.server_info.get("name") == "lightcraft"
            and bool(session.client.server_info.get("version")),
            json.dumps(session.client.server_info),
        )

        imported = session.engine.import_paths(["fixture"])
        photo_ids = sorted(imported["imported"])
        check(
            "the library imported the fixture",
            photo_ids == [1, 2, 3],
            "imported %s" % photo_ids,
        )

        command_ids = session.engine.command_ids()
        check(
            "LightCraft has no light.*, color.* or mixer.* commands",
            not [
                cid
                for cid in command_ids
                if cid.startswith(("light.", "color.", "mixer."))
            ],
            "the control ids were mistaken for command ids",
        )
        check(
            "the develop commands the loop uses all exist",
            all(
                cid in command_ids
                for cid in (
                    "develop.set",
                    "develop.adjust",
                    "develop.controls",
                    "develop.get",
                    "photo.inspect",
                    "photo.setMeta",
                    "catalog.query",
                    "library.select",
                    "journal.list",
                )
            ),
            "a command id the loop uses is missing",
        )

        engine_controls = session.engine.control_state(1)
        used_controls = set(module.INITIAL_EDIT) | {
            control
            for controls in module.INVARIANT_CONTROLS.values()
            for control in controls
        }
        check(
            "every control the loop touches is a control the engine knows",
            used_controls <= set(engine_controls),
            "unknown: %s" % sorted(used_controls - set(engine_controls)),
        )
        check(
            "the control ids the loop uses are the real ones",
            "mixer.orange.sat" in engine_controls
            and "mixer.red.saturation" not in engine_controls
            and "wb.tint" in engine_controls
            and "color.temperature" not in engine_controls,
            "the mixer / white-balance control ids are wrong",
        )

        config = module.LoopConfig()
        summary = run_phase(module, session, reviewer, config)
        journal = session.engine.journal(limit=1000)

        check(
            "the summary names the photos that converged",
            sorted(summary["converged"]) == [1, 3],
            json.dumps(summary["converged"]),
        )
        check(
            "the summary names the photo that timed out",
            summary["timedOut"] == [2],
            json.dumps(summary["timedOut"]),
        )
        check(
            "the summary names the photos that were skipped",
            summary["skipped"] == [],
            json.dumps(summary["skipped"]),
        )
        check(
            "the summary is written next to the library",
            SUMMARY_PATH.exists() and json.loads(SUMMARY_PATH.read_text())["converged"] == summary["converged"],
            str(SUMMARY_PATH),
        )

        check(
            "the audit trail is where the contract says",
            AUDIT_PATH.exists(),
            "%s is missing" % AUDIT_PATH,
        )
        entries = module.AuditTrail(AUDIT_PATH).entries()
        check(
            "the audit trail holds one line per iteration",
            len(entries) == 13,
            "%d lines" % len(entries),
        )
        check(
            "every audit line carries exactly the contract keys",
            all(set(entry) == set(module.AUDIT_KEYS) for entry in entries),
            "a line carries extra or missing keys",
        )
        check(
            "every audit line names a control the engine knows",
            all(
                entry["control"] in engine_controls
                for entry in entries
                if entry["control"]
            ),
            "an audit line names a control that does not exist",
        )
        check(
            "every audit line carries a status the schema allows",
            all(entry["llmStatus"] in ("ok", "retry") for entry in entries),
            "an audit line carries an unknown status",
        )
        seen_digests = {call["md5"] for call in reviewer.calls}
        check(
            "every audit line's md5 is the md5 of a frame the model saw",
            all(entry["preRenderMd5"] in seen_digests for entry in entries),
            "an audit line carries an md5 no render produced",
        )
        check(
            "the number of audit lines matches the number of reviews",
            len(entries) == len(reviewer.calls),
            "%d lines, %d reviews" % (len(entries), len(reviewer.calls)),
        )
        check(
            "every frame shipped to the model fits the byte budget",
            max(call["bytes"] for call in reviewer.calls) <= config.max_jpeg_bytes,
            "a frame was %d bytes" % max(call["bytes"] for call in reviewer.calls),
        )
        check(
            "the iteration numbers of a photo are contiguous",
            all(
                [entry["iteration"] for entry in entries if entry["photoId"] == pid]
                == list(range(1, len([e for e in entries if e["photoId"] == pid]) + 1))
                for pid in photo_ids
            ),
            "the iterations of a photo are not contiguous",
        )

        check(
            "the converged photos carry the graded keyword",
            all(
                "NorthwindGraded" in session.engine.keywords_of(pid)
                for pid in summary["converged"]
            ),
            "a converged photo is not tagged",
        )
        check(
            "the photo that timed out carries no keyword",
            "NorthwindGraded" not in session.engine.keywords_of(2),
            "a timed-out photo was tagged",
        )
        keyword_tree = session.engine.keywords()
        check(
            "the library's keyword tree counts the delivered photos",
            any(
                entry["name"] == "NorthwindGraded" and entry["count"] == 2
                for entry in keyword_tree
            ),
            json.dumps(keyword_tree),
        )
        check(
            "the library filter finds exactly the delivered photos",
            sorted(
                photo["id"] for photo in session.engine.photos_with_keyword("NorthwindGraded")
            )
            == [1, 3],
            "the keyword filter returned another set",
        )

        # -- the engine's own reports ------------------------------------
        set_entries = journal_entries(session, "develop.set")
        adjust_entries = journal_entries(session, "develop.adjust")
        check(
            "the initial edit is one develop.set per graded photo",
            len(set_entries) == 3,
            "%d develop.set calls" % len(set_entries),
        )
        check(
            "the initial edit carries one value per invariant axis",
            all(
                set(entry["params"].get("values", {})) == set(module.INITIAL_EDIT)
                for entry in set_entries
            ),
            "a develop.set call does not carry the initial edit",
        )
        check(
            "every iteration nudged exactly one control",
            all(
                set(entry["params"]) == {"control", "delta"}
                for entry in adjust_entries
            ),
            "a develop.adjust call carried more than a control and a delta",
        )
        check(
            "the journal counts the nudges the audit trail records",
            len(adjust_entries)
            == len([entry for entry in entries if entry["llmStatus"] == "retry"]),
            "%d nudges, %d retries" % (
                len(adjust_entries),
                len([entry for entry in entries if entry["llmStatus"] == "retry"]),
            ),
        )
        check(
            "the cooling rule widened the neighbourhood",
            any(
                entry["params"]["control"] == "light.blacks"
                for entry in adjust_entries
            ),
            "no second control was tried",
        )
        check(
            "the journal attributes every nudge to the right photo",
            commands_by_photo(journal, "develop.adjust") == {1: 3, 2: 8},
            json.dumps(commands_by_photo(journal, "develop.adjust")),
        )
        check(
            "the journal records the initial edit's values",
            all(
                entry["params"].get("values")
                == {key: float(value) for key, value in module.INITIAL_EDIT.items()}
                for entry in set_entries
            ),
            json.dumps(set_entries),
        )
        check(
            "the engine's own develop values match the audit trail",
            session.engine.develop(1)["light"]["shadows"] == 32.0
            and session.engine.develop(1)["light"]["blacks"] == 10.0
            and session.engine.develop(1)["mixer"]["orange"]["sat"] == 4.0,
            json.dumps(session.engine.develop(1)["light"]),
        )
        check(
            "the photo that timed out stopped at the iteration ceiling",
            summary["iterations"]["2"] == config.max_iterations,
            json.dumps(summary["iterations"]),
        )
        check(
            "no control was pushed outside the range the engine reports",
            all(
                float(spec["min"]) <= float(value) <= float(spec["max"])
                for pid in photo_ids
                for control, value in _flatten_develop(session.engine.develop(pid)).items()
                for spec in [engine_controls.get(control)]
                if spec is not None
            ),
            "a value left the engine's range",
        )
        check(
            "the import stayed inside the apex tree",
            all(
                str(Path(entry["params"]["paths"][0]).resolve()).startswith(
                    str(WORK.resolve())
                )
                for entry in journal_entries(session, "library.import")
            ),
            "the engine resolved the import outside the tree",
        )
        history = session.engine.client.call(
            "command_run", {"id": "history.list", "params": {"id": 1}}
        )
        check(
            "the engine's own history records the nudges",
            len(history["history"]) >= 2,
            json.dumps(history),
        )

        journal_after_phase_1 = len(journal)
        adjusts_after_phase_1 = len(adjust_entries)
        entries_after_phase_1 = len(entries)

    # ── phase 2: a restart against the same library ────────────────────
    reviewer_2 = StandInReviewer(SCRIPT)
    with Session(module, str(binary)) as session:
        check(
            "the library survives the restart",
            sorted(photo["id"] for photo in session.engine.photos()) == [1, 2, 3],
            "the library lost photos",
        )
        summary_2 = run_phase(
            module,
            session,
            reviewer_2,
            config,
            summary_path=SUMMARY_PATH.with_name("grade-summary-restart.json"),
        )
        journal_2 = session.engine.journal(limit=1000)
        entries_2 = module.AuditTrail(AUDIT_PATH).entries()

        check(
            "a restarted run skips the photos a previous run delivered",
            sorted(summary_2["skipped"]) == [1, 3],
            json.dumps(summary_2["skipped"]),
        )
        check(
            "a restarted run does not touch a delivered photo",
            len(
                [
                    call
                    for call in reviewer_2.calls
                    if call["photoId"] in (1, 3)
                ]
            )
            == 0,
            "a delivered photo was reviewed again",
        )
        check(
            "a restarted run retries the photo that never converged",
            summary_2["timedOut"] == [2],
            json.dumps(summary_2["timedOut"]),
        )
        check(
            "the audit trail is appended to, never truncated",
            len(entries_2) > entries_after_phase_1
            and entries_2[:entries_after_phase_1] == entries,
            "%d lines, was %d" % (len(entries_2), entries_after_phase_1),
        )
        check(
            "the engine journal grew with the new run",
            len(journal_2) > 0
            and commands_by_photo(journal_2, "develop.adjust") == {2: 8},
            "%d entries, %s nudges"
            % (len(journal_2), json.dumps(commands_by_photo(journal_2, "develop.adjust"))),
        )
        check(
            "the restarted run never nudged a delivered photo",
            set(commands_by_photo(journal_2, "develop.adjust")) == {2},
            json.dumps(commands_by_photo(journal_2, "develop.adjust")),
        )

    # ── phase 3: the byte budget trims the render ─────────────────────
    tight = module.LoopConfig(max_jpeg_bytes=20 * 1024)
    reviewer_3 = StandInReviewer(SCRIPT)
    with Session(module, str(binary)) as session:
        summary_3 = run_phase(
            module,
            session,
            reviewer_3,
            tight,
            summary_path=SUMMARY_PATH.with_name("grade-summary-trim.json"),
            photo_ids=[2],
        )
        check(
            "a tight budget still drives the loop",
            summary_3["timedOut"] == [2],
            json.dumps(summary_3["timedOut"]),
        )
        check(
            "every frame fits the tight budget",
            all(call["bytes"] <= tight.max_jpeg_bytes for call in reviewer_3.calls),
            "a frame was %d bytes"
            % max(call["bytes"] for call in reviewer_3.calls),
        )
        check(
            "the tight budget really was smaller than the preview",
            max(call["bytes"] for call in reviewer_3.calls) < 250 * 1024,
            "the trim did not happen",
        )
        trimmed = sorted(RENDER_DIR.glob("photo-2-*.jpg"))
        check(
            "the trim wrote its files inside the apex tree",
            len(trimmed) > 0
            and all(
                str(path).startswith(str(WORK)) for path in trimmed
            ),
            "%d trimmed files" % len(trimmed),
        )
        check(
            "the trimmed files honour the budget",
            all(path.stat().st_size <= tight.max_jpeg_bytes for path in trimmed),
            "a trimmed file is over the budget",
        )

    # ── the sandbox ────────────────────────────────────────────────────
    guard = module.ApexRoot(WORK)
    check(
        "the guard refuses a path outside the apex tree",
        not guard.contains("/etc/hosts")
        and not guard.contains("../outside.jpg")
        and not guard.contains(str(WORK.parent / "outside.jpg")),
        "a path outside the tree was accepted",
    )
    check(
        "the guard accepts a path inside the apex tree",
        guard.contains("renders") and guard.contains(str(WORK / "library")),
        "a path inside the tree was refused",
    )
    try:
        guard.guard("/etc/hosts")
    except module.SandboxError:
        raised = True
    else:
        raised = False
    check("the guard raises on a path outside the tree", raised, "no error raised")

    # ── the artefacts ──────────────────────────────────────────────────
    check(
        "the artefacts stay under output/work",
        all(
            path.resolve().is_relative_to(WORK.resolve())
            for path in [AUDIT_PATH, SUMMARY_PATH, RENDER_DIR]
        ),
        "an artefact escaped output/work",
    )

    for cache in HERE.rglob("__pycache__"):
        shutil.rmtree(cache, ignore_errors=True)


    # --- publish the headline artefacts next to the harness log ------------
    publish = WORK.parent
    shutil.copy2(WORK / "grade-summary.json", publish / "grade-summary.json")
    shutil.copy2(WORK / "grade-summary-restart.json", publish / "grade-summary-restart.json")
    shutil.copy2(WORK / "grade-summary-trim.json", publish / "grade-summary-trim.json")
    shutil.copy2(WORK / "renders" / "photo-2-01.jpg", publish / "photo-2-01.jpg")
    shutil.copy2(WORK / "library" / "apex" / "grade-audit.jsonl", publish / "grade-audit.jsonl")

    print("%d assertions passed" % PASSED)
    return 0


def _flatten_develop(settings: Dict[str, Any]) -> Dict[str, float]:
    """The develop settings flattened into the engine's control ids."""
    flat: Dict[str, float] = {}
    for control in settings:
        if isinstance(settings[control], dict):
            for name, value in settings[control].items():
                if isinstance(value, (int, float)) and not isinstance(value, bool):
                    flat["%s.%s" % (control, name)] = float(value)
    return flat


if __name__ == "__main__":
    sys.exit(main())
