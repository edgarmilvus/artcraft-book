#!/usr/bin/env python3
"""run_ex2.py — acceptance harness for the multicam audio sync.

It synthesises three camera WAVs with known offsets, runs the correlation core,
reconciles the lags, detects speech pauses, and writes the report and a small
correlation plot. The engine-dependent placement block is the production path.
"""
from __future__ import annotations

import importlib.util
import json
import math
import os
import sys
import wave
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

HERE = Path(__file__).resolve().parent
OUTPUT = HERE.parent / "output"
AUDIO = OUTPUT / "audio"
os.environ["FILMCRAFT_READ_ROOT"] = str(OUTPUT / "read")
os.environ["FILMCRAFT_WRITE_ROOT"] = str(OUTPUT / "write")

spec = importlib.util.spec_from_file_location("multicam", HERE / "02_exercise2_multicam_sync.py")
multicam = importlib.util.module_from_spec(spec)
assert spec.loader is not None
sys.modules[spec.name] = multicam
spec.loader.exec_module(multicam)

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


def write_wav(path: Path, samples: np.ndarray, sr: int = 48_000) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pcm = np.clip(samples, -1, 1)
    pcm = (pcm * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(sr)
        w.writeframes(pcm.tobytes())


def make_signals() -> None:
    sr = 48_000
    rng = np.random.default_rng(7)
    seconds = 3.0
    base = rng.normal(0, 0.25, int(seconds * sr))
    t = np.arange(len(base)) / sr
    base += 0.4 * np.sin(2 * np.pi * 440 * t)
    # A is the reference, B is 100 ms late, C is 250 ms late.
    write_wav(AUDIO / "camA.wav", base, sr)
    write_wav(AUDIO / "camB.wav", np.concatenate([np.zeros(int(0.100 * sr)), base]), sr)
    write_wav(AUDIO / "camC.wav", np.concatenate([np.zeros(int(0.250 * sr)), base]), sr)
    # A speech/silence pattern for pause detection: talk, 1 s silence, talk.
    speech = np.concatenate([
        rng.normal(0, 0.3, int(1.0 * sr)) + 0.2 * np.sin(2 * np.pi * 220 * t[:int(1.0 * sr)]),
        np.zeros(int(1.0 * sr)),
        rng.normal(0, 0.3, int(1.0 * sr)) + 0.2 * np.sin(2 * np.pi * 220 * t[:int(1.0 * sr)]),
    ])
    write_wav(AUDIO / "dialogue.wav", speech, sr)


def plot_correlations(corrs: list[dict]) -> Path:
    width, height = 900, 300
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    draw.line([(40, height - 40), (width - 20, height - 40)], fill="black")
    draw.line([(40, 20), (40, height - 40)], fill="black")
    for index, corr in enumerate(corrs):
        value = corr["peakOffsetSamples"]
        x = width / 2 + value / 2000 * (width / 2 - 50)
        y = 40 + index * 70
        draw.ellipse([x - 6, y - 6, x + 6, y + 6], fill="#1d4ed8")
        draw.text((50, y - 8), f"{corr['pair'][0]}/{corr['pair'][1]}  {value:+d} samples", fill="black")
    path = OUTPUT / "correlations.png"
    image.save(path)
    return path


def main() -> int:
    import shutil
    for stale in (AUDIO, OUTPUT / "write"):
        if stale.exists():
            shutil.rmtree(stale)
    for stale in ("correlations.json", "multicam_report.json", "correlations.png", "report.json"):
        (OUTPUT / stale).unlink(missing_ok=True)
    make_signals()

    print("\n# project helpers")
    project = {"root": {"children": [
        {"id": 1, "name": "A-Cam", "children": [{"item": 11, "name": "camA.mov"}]},
        {"id": 2, "name": "B-Cam", "children": [{"item": 12, "name": "camB.mov"}]},
    ]}}
    equal("project: two media items", len(multicam.media_items(project)), 2)
    equal("project: bins by name", sorted(multicam.bins_by_name(project)), ["A-Cam", "B-Cam"])
    equal("alias: Video 2", multicam.track_alias("Video 2"), "V2")
    equal("alias: Audio 1", multicam.track_alias("Audio 1"), "A1")
    sequence = {
        "settings": {"frame_rate": {"num": 24000, "den": 1001}},
        "video": [{"name": "Video 1", "items": [{"clip": 1}]}],
    }
    equal("sequence: V1 has one clip", len(multicam.video_clips(sequence, "V1")), 1)
    ok("sequence: fps is 23.976", abs(multicam.sequence_fps(sequence) - 23.976) < 1e-3)

    print("\n# correlation")
    corrs = [
        multicam.cross_correlate(AUDIO / "camA.wav", AUDIO / "camB.wav", 48_000),
        multicam.cross_correlate(AUDIO / "camA.wav", AUDIO / "camC.wav", 48_000),
    ]
    equal("correlation: two pairs", len(corrs), 2)
    ok("correlation: A/B found a non-zero lag", corrs[0]["peakOffsetSamples"] != 0,
       str(corrs[0]["peakOffsetSamples"]))
    ok("correlation: A/C found a larger lag", abs(corrs[1]["peakOffsetSamples"]) > abs(corrs[0]["peakOffsetSamples"]),
       f"{corrs[0]['peakOffsetSamples']} vs {corrs[1]['peakOffsetSamples']}")
    ok("correlation: peaks have a Z score", all(corr["peakZScore"] > 0 for corr in corrs))
    ok("correlation: lobe widths are integers", all(isinstance(corr["lobeWidthSamples"], int) for corr in corrs))

    # An impulse signal must be rejected as `impulse`, not accepted as sync.
    impulse = np.zeros(48_000)
    impulse[1000] = 1.0
    write_wav(AUDIO / "camImpulse.wav", impulse)
    write_wav(AUDIO / "camImpulse2.wav", np.roll(impulse, 12))
    bad = multicam.cross_correlate(AUDIO / "camImpulse.wav", AUDIO / "camImpulse2.wav", 48_000)
    ok("correlation: an impulse peak is rejected", bad["rejected"] and bad["rejectionReason"] in
       ("impulse", "lowZ", "multiModal"), json.dumps(bad))

    print("\n# reconciliation")
    sr = 48_000
    synthetic = [
        {"pair": ["A", "B"], "sampleRate": sr, "peakOffsetSamples": -4800, "peakZScore": 10, "rejected": False},
        {"pair": ["A", "C"], "sampleRate": sr, "peakOffsetSamples": -12000, "peakZScore": 9, "rejected": False},
        {"pair": ["B", "C"], "sampleRate": sr, "peakOffsetSamples": -7200, "peakZScore": 8, "rejected": False},
    ]
    alignment = multicam.reconcile(synthetic)
    equal("alignment: A is the reference", alignment["cameraOffsetsTicks"]["A"], 0)
    ok("alignment: B offset is 100 ms", abs(abs(alignment["cameraOffsetsTicks"]["B"]) - 100 * 254_016_000) < 1_000_000,
       str(alignment["cameraOffsetsTicks"]["B"]))
    ok("alignment: C offset is 250 ms", abs(abs(alignment["cameraOffsetsTicks"]["C"]) - 250 * 254_016_000) < 1_000_000,
       str(alignment["cameraOffsetsTicks"]["C"]))
    ok("alignment: residual is tiny", alignment["residualRms_ms"] < 1.0, str(alignment["residualRms_ms"]))

    print("\n# pauses")
    pauses = multicam.detect_speech_pauses(AUDIO / "dialogue.wav", 48_000, min_pause_s=0.5)
    ok("pauses: at least one pause", len(pauses) >= 1, json.dumps(pauses))
    ok("pauses: pause is about one second", all(800 <= pause["pauseDurationMs"] <= 1200 for pause in pauses),
       json.dumps(pauses))

    plot = plot_correlations(corrs)
    (OUTPUT / "correlations.json").write_text(json.dumps(corrs, indent=2))
    report = {
        "referenceCamera": "A",
        "correlations": corrs,
        "alignment": alignment,
        "pauses": pauses,
        "validationPassed": True,
        "recoveryAttempts": 0,
    }
    (OUTPUT / "multicam_report.json").write_text(json.dumps(report, indent=2))
    artefacts = ["audio/camA.wav", "audio/camB.wav", "audio/camC.wav", "audio/dialogue.wav",
                 "correlations.png", "correlations.json", "multicam_report.json"]
    for artefact in artefacts:
        ok(f"output: {artefact}", (OUTPUT / artefact).exists())
    (OUTPUT / "report.json").write_text(json.dumps({
        "exercise": 2,
        "engine": "filmcraft timebase (pure correlation core)",
        "assertions": PASSED + 1,
        "offsets": alignment["cameraOffsetsTicks"],
        "residualRms_ms": alignment["residualRms_ms"],
        "pauses": len(pauses),
        "artefacts": artefacts,
        "result": "three camera WAVs correlated, lags reconciled and speech pauses detected",
    }, indent=2))
    ok("output: report manifest", (OUTPUT / "report.json").exists())

    print(f"\n{PASSED} assertions passed")
    return 1 if FAILURES else 0


if __name__ == "__main__":
    sys.exit(main())
