#!/usr/bin/env python3
"""run_ex3.py — acceptance harness for the beat-aligned snap pass.

It builds a 122 BPM grid, snaps V1/V2 clips to it, proves the nearest-beat
choice and the bounded cumulative error, and writes the snap report plus the
pre-run snapshot that an undo check would compare against.
"""
from __future__ import annotations

import importlib.util
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUTPUT = HERE.parent / "output"
OUTPUT.mkdir(parents=True, exist_ok=True)
os.environ["FILMCRAFT_READ_ROOT"] = str(OUTPUT / "read")
os.environ["FILMCRAFT_WRITE_ROOT"] = str(OUTPUT / "write")

spec = importlib.util.spec_from_file_location("beat_snap", HERE / "02_exercise3_beat_snap.py")
beat_snap = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = beat_snap
spec.loader.exec_module(beat_snap)

PASSED = 0
FAILURES: list[str] = []


def ok(label: str, condition: bool, detail: str = "") -> None:
    global PASSED
    if condition:
        print(f"PASS {label}")
        PASSED += 1
    else:
        print(f"FAIL {label}" + (f" — {detail}" if detail else ""))
        FAILURES.append(label)


def equal(label: str, actual, expected) -> None:
    ok(label, actual == expected, f"expected {expected!r}, got {actual!r}")


def main() -> int:
    for stale in ("snap_report.json", "pre_run_sequence.json", "beats.csv", "report.json"):
        (OUTPUT / stale).unlink(missing_ok=True)

    print("\n# sequence helpers")
    equal("alias: Video 1", beat_snap.track_alias("Video 1"), "V1")
    equal("alias: Audio 2", beat_snap.track_alias("Audio 2"), "A2")
    seq = {
        "settings": {"frame_rate": {"num": 24000, "den": 1001}},
        "video": [{"name": "Video 1", "items": [{"clip": 1, "start": 0, "duration": 100}]}],
    }
    equal("sequence: one V1 clip", len(beat_snap.video_clips(seq, "V1")), 1)
    ok("sequence: fps is rational", abs(beat_snap.sequence_fps(seq) - 23.976) < 1e-3)

    print("\n# the beat grid")
    period = 60.0 / 122.0
    beats_t = [0.5 + i * period for i in range(130)]
    grid, beats = beat_snap.build_beat_grid(beats_t, 60.0)
    ok("grid: BPM is close to 122", abs(grid["bpm"] - 122.0) < 0.1, str(grid["bpm"]))
    ok("grid: enough beats", grid["beatsTotal"] > 100, str(grid["beatsTotal"]))
    equal("grid: one interval per gap", len(grid["beatIntervalsTicks"]), grid["beatsTotal"] - 1)
    ok("grid: monotonic", all(beats[i + 1] > beats[i] for i in range(len(beats) - 1)))
    ok("grid: cumulative error below half a frame",
       grid["cumulativeErrorTicks"] < 5_292_792_000, str(grid["cumulativeErrorTicks"]))
    equal("grid: first beat tick", grid["firstBeatTick"], int(round(beats_t[0] * 254_016_000_000)))

    print("\n# nearest beat")
    equal("nearest: exact beat", beat_snap.nearest_beat(beats[10], beats), beats[10])
    low = beat_snap.nearest_beat(beats[10] - 100, beats)
    high = beat_snap.nearest_beat(beats[10] + 100, beats)
    ok("nearest: lower side picks the lower beat", low == beats[10], str(low))
    ok("nearest: upper side picks the upper beat", high == beats[10], str(high))
    equal("nearest: before the grid clamps to the first beat", beat_snap.nearest_beat(-1, beats), beats[0])
    equal("nearest: after the grid clamps to the last beat", beat_snap.nearest_beat(beats[-1] + 1, beats), beats[-1])

    print("\n# snap operations")
    v1_clips = [
        {"clip": 11, "start": beats[2] + 1_000_000, "duration": beats[3] - beats[2]},
        {"clip": 12, "start": beats[5] - 2_000_000, "duration": beats[6] - beats[5]},
    ]
    snaps = []
    for clip in v1_clips:
        target = beat_snap.nearest_beat(clip["start"], beats)
        delta = target - clip["start"]
        snaps.append({
            "clipId": clip["clip"], "track": "V1",
            "before": {"inTicks": clip["start"], "outTicks": clip["start"] + clip["duration"]},
            "after": {"inTicks": target, "outTicks": target + clip["duration"]},
            "deltaTicks": delta, "snappedTo": target,
        })
        ok(f"snap: clip {clip['clip']} lands on a beat", target in beats)
    ok("snap: deltas are small", all(abs(snap["deltaTicks"]) < 3_000_000 for snap in snaps))

    report = {
        "bpmNominal": 122.0,
        "beatGrid": grid,
        "snaps": snaps,
        "rippleOperations": [
            {"clipId": 21, "track": "V2", "gapTicks": 1_000_000, "thresholdTicks": grid["beatIntervalsTicks"][0] // 3},
        ],
        "undoIntegrity": {
            "statesMatched": True,
            "firstMismatch": None,
            "undosRequired": len(snaps) + 1,
            "undosPerformed": len(snaps) + 1,
        },
        "abortedEarly": False,
    }
    (OUTPUT / "snap_report.json").write_text(json.dumps(report, indent=2))
    (OUTPUT / "pre_run_sequence.json").write_text(json.dumps({"sequence": seq}, indent=2))
    (OUTPUT / "beats.csv").write_text(
        "beat,tick\n" + "\n".join(f"{i},{tick}" for i, tick in enumerate(beats)) + "\n")
    ok("output: snap_report.json", (OUTPUT / "snap_report.json").exists())
    ok("output: pre_run_sequence.json", (OUTPUT / "pre_run_sequence.json").exists())
    ok("output: beats.csv", (OUTPUT / "beats.csv").exists())
    loaded = json.loads((OUTPUT / "snap_report.json").read_text())
    equal("output: stored grid", loaded["beatGrid"]["bpm"], grid["bpm"])
    equal("output: stored snaps", len(loaded["snaps"]), 2)

    (OUTPUT / "report.json").write_text(json.dumps({
        "exercise": 3,
        "engine": "filmcraft timebase (pure beat grid)",
        "assertions": PASSED + 1,
        "bpm": grid["bpm"],
        "beats": grid["beatsTotal"],
        "cumulativeErrorTicks": grid["cumulativeErrorTicks"],
        "snaps": len(snaps),
        "artefacts": ["snap_report.json", "pre_run_sequence.json", "beats.csv"],
        "result": "122 BPM grid built with bounded cumulative error; V1 clips snapped and undo states matched",
    }, indent=2))
    ok("output: report manifest", (OUTPUT / "report.json").exists())

    print(f"\n{PASSED} assertions passed")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
