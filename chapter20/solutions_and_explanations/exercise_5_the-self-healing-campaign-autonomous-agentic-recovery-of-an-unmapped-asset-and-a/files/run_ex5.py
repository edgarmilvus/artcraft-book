#!/usr/bin/env python3
"""
run_ex5.py — the harness for "The Self-Healing Campaign".

The harness builds a real LightCraft library, a real campaign manifest and
a real analytics store, runs the agent for real with an injected reasoner
(a closure, so no API key and no network are involved), and then checks
the artefacts the agent left behind and the engines' own reports.

Five runs are exercised:

  repair    the agent finds a candidate, refines a copy of it and
            re-enters the publish gate
  degrade   no candidate clears the rubric, so the agent falls back to a
            variant that performed acceptably
  escalate  the agent gives up and pages creative-ops
  budget    the reasoner blows the token budget
  security  the reasoner plans to fetch a replacement from the internet

Every check prints one `PASS <label>` line; the run ends with the number
of assertions that passed.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
import shutil
import struct
import subprocess
import sys
import zlib
from pathlib import Path
from typing import Any, Callable, Dict, List, Tuple

sys.dont_write_bytecode = True

FILES = Path(__file__).resolve().parent
WORK = FILES.parent / "output" / "work"
PHOTOS = WORK / "photos"
STRICT_PHOTOS = WORK / "photos-strict"
LIBRARY = WORK / "library"
STRICT_LIBRARY = WORK / "library-strict"
ASSETS = WORK / "assets"
DERIVED = WORK / "derived"
CAMPAIGN = WORK / "campaign.json"
ANALYTICS = WORK / "analytics.json"
OUTBOX = WORK / "pages.jsonl"
SOLUTION = FILES / "05_the-self-healing-campaign-autonomous-agentic-recovery-of-an-unmapped-asset-and-a-re-entrant-publish-gate.py"

PASSED: List[str] = []
FAILED: List[Tuple[str, str]] = []


def check(label: str, condition: bool, detail: str = "") -> bool:
    if condition:
        PASSED.append(label)
        print("PASS %s" % label)
    else:
        FAILED.append((label, detail))
        print("FAIL %s %s" % (label, detail))
    return bool(condition)


# ---------------------------------------------------------------------------
# A minimal PNG writer, so the harness needs nothing outside the standard
# library.
# ---------------------------------------------------------------------------

def _png_chunk(tag: bytes, data: bytes) -> bytes:
    return (struct.pack(">I", len(data)) + tag + data
            + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF))


def write_png(path: Path, width: int, height: int, colour: Tuple[int, int, int]) -> None:
    red, green, blue = colour
    row = bytes((red, green, blue)) * width
    raw = b"".join(b"\x00" + row for _ in range(height))
    header = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + _png_chunk(b"IHDR", header)
        + _png_chunk(b"IDAT", zlib.compress(raw, 6))
        + _png_chunk(b"IEND", b""))


# ---------------------------------------------------------------------------
# The solution, loaded as a module
# ---------------------------------------------------------------------------

def load_solution():
    spec = importlib.util.spec_from_file_location("self_healing_agent", str(SOLUTION))
    if spec is None or spec.loader is None:
        raise SystemExit("cannot load %s" % SOLUTION)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


# ---------------------------------------------------------------------------
# A synchronous MCP client, for the engines' own reports
# ---------------------------------------------------------------------------

class Engine:
    def __init__(self, command: List[str]) -> None:
        self.proc = subprocess.Popen(
            command, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, text=True, bufsize=1)
        self._id = 0
        self._request("initialize", {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "run-ex5", "version": "1.0"}})
        self._notify("notifications/initialized", {})

    def _request(self, method: str, params: dict) -> Any:
        self._id += 1
        assert self.proc.stdin is not None and self.proc.stdout is not None
        self.proc.stdin.write(json.dumps(
            {"jsonrpc": "2.0", "id": self._id, "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()
        line = self.proc.stdout.readline()
        if not line:
            raise RuntimeError("the engine closed the pipe")
        response = json.loads(line)
        if "error" in response:
            raise RuntimeError(json.dumps(response["error"]))
        return response.get("result")

    def _notify(self, method: str, params: dict) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(
            {"jsonrpc": "2.0", "method": method, "params": params}) + "\n")
        self.proc.stdin.flush()

    def tool(self, name: str, arguments: dict) -> Any:
        result = self._request("tools/call", {"name": name, "arguments": arguments})
        if not isinstance(result, dict):
            return result
        if result.get("isError") is True:
            raise RuntimeError("%s: %s" % (name, json.dumps(result.get("content"))[:300]))
        for block in result.get("content") or []:
            if isinstance(block, dict) and block.get("type") == "text":
                text = block.get("text", "")
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    return text
        return result

    def close(self) -> None:
        try:
            if self.proc.stdin is not None:
                self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.wait(timeout=5)
        except Exception:
            self.proc.kill()


# ---------------------------------------------------------------------------
# The fixtures
# ---------------------------------------------------------------------------

SHOTS = [
    # name, width, height, temperature, rating, keywords
    ("window-01.png", 2000, 1500, 6000, 4, ["lifestyle", "windowsill"]),
    ("window-02.png", 800, 600, 5200, 4, ["lifestyle", "windowsill"]),
    ("window-03.png", 2400, 1800, 5800, 5, ["lifestyle", "windowsill"]),
    ("window-04.png", 2400, 400, 5200, 4, ["lifestyle", "windowsill"]),
    ("window-05.png", 2000, 1500, 5200, 4, ["lifestyle"]),
]

STRICT_SHOTS = [
    ("stale-01.png", 800, 600, 5200, 4, ["lifestyle", "windowsill"]),
    ("stale-02.png", 900, 700, 5200, 3, ["lifestyle", "windowsill"]),
]


def build_photos(directory: Path, shots: List[tuple]) -> None:
    directory.mkdir(parents=True, exist_ok=True)
    for index, (name, width, height, _temp, _rating, _keywords) in enumerate(shots):
        colour = (40 + index * 37, 90 + index * 21, 140 - index * 13)
        write_png(directory / name, width, height, colour)


def build_library(library: Path, photos: Path, shots: List[tuple]) -> None:
    """Import the photos and give them the metadata the campaign expects."""
    engine = Engine(["lightcraft-cli", "mcp", "--library", str(library), str(photos)])
    try:
        listing = engine.tool("query_photos", {})
        by_name = {photo.get("fileName"): photo for photo in listing.get("photos", [])}
        for name, _width, _height, temp, rating, keywords in shots:
            photo = by_name.get(name)
            if photo is None:
                raise SystemExit("the library did not import %s" % name)
            photo_id = int(photo["id"])
            engine.tool("cmd_photo_rate", {"ids": [photo_id], "rating": rating})
            engine.tool("cmd_photo_flag", {"ids": [photo_id], "flag": "pick"})
            engine.tool("cmd_photo_setMeta", {"ids": [photo_id], "addKeywords": keywords})
            engine.tool("set_develop", {"id": photo_id, "values": {"wb.temp": float(temp)}})
    finally:
        engine.close()


def build_campaign(manifest: dict) -> None:
    manifest = dict(manifest)
    manifest["roots"] = {
        "derived": str(DERIVED),
        "assets": str(ASSETS),
        "outbox": str(OUTBOX),
    }
    manifest.setdefault("library", {"libraryDir": str(LIBRARY), "photosDir": str(PHOTOS)})
    manifest["analyticsPath"] = str(ANALYTICS)
    manifest["missingAssetPath"] = str(ASSETS / "lifestyle" / "window-01.jpg")
    CAMPAIGN.write_text(json.dumps(manifest, indent=2), encoding="utf-8")


def base_campaign() -> Dict[str, Any]:
    return {
        "id": "cmp-windowsill",
        "name": "Windowsill launch",
        "assetRules": {
            "minWidth": 1600,
            "minHeight": 1200,
            "targetTempK": 5200,
            "tempToleranceK": 400,
            "cropAspect": [4, 3],
            "maxCropDiscardFraction": 0.15,
            "minRating": 3,
        },
        "scene": {"keyword": "windowsill", "keywords": ["lifestyle", "windowsill"]},
        "fallbackCampaignIds": ["var-b", "var-c"],
        "fallbackAssetPath": str(ASSETS / "fallback" / "variant-b.png"),
        "creative": {
            "headline": "Made for the windowsill",
            "cta": "See the range",
            "width": 1080,
            "height": 1350,
            "background": "#101820",
        },
    }


def write_analytics() -> None:
    ANALYTICS.write_text(json.dumps({
        "windowDays": 30,
        "variants": [
            {"id": "var-b", "ctr": 0.012, "impressions": 48120, "clicks": 577},
            {"id": "var-c", "ctr": 0.0085, "impressions": 39300, "clicks": 334},
            {"id": "var-d", "ctr": 0.0031, "impressions": 12000, "clicks": 37},
        ],
    }, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# The injected reasoners
# ---------------------------------------------------------------------------

def repair_reasoner(derived: Path) -> Callable:
    """A reasoner that searches, refines the closest candidate and exports it.

    It is the stand-in for the studio's language model: it sees the
    observation and the agent's memory, and it returns a plan.
    """
    def reason(observation: Dict[str, Any], state: Any) -> Dict[str, Any]:
        rules = state.campaign["assetRules"]
        target = float(rules["targetTempK"])
        tolerance = float(rules["tempToleranceK"])
        if not state.candidates:
            return {
                "plan": [{"tool": "query_photos", "arguments": {
                    "filter": {"flag": "pick", "rating": 3, "ratingOp": "atLeast",
                               "keyword": "windowsill"},
                    "limit": 20}}],
                "tokensIn": 412, "tokensOut": 38,
            }
        for candidate in state.candidates:
            if candidate.exported_path is not None:
                continue
            if candidate.copy_id is None:
                if candidate.failed_rules() != ["color-temp"]:
                    continue
                return {
                    "plan": [{"tool": "cmd_photo_virtualCopy",
                              "arguments": {"ids": [candidate.photo_id]}}],
                    "tokensIn": 520, "tokensOut": 44,
                }
            if abs(candidate.temp_kelvin() - target) > tolerance:
                return {
                    "plan": [{"tool": "set_develop", "arguments": {
                        "id": candidate.copy_id,
                        "values": {"wb.temp": target},
                        "label": "agent refinement"}}],
                    "tokensIn": 588, "tokensOut": 51,
                }
            return {
                "plan": [{"tool": "export", "arguments": {
                    "id": candidate.copy_id,
                    "path": str(derived / ("replacement-%d.jpg" % candidate.photo_id)),
                    "format": "jpeg", "quality": 90}}],
                "tokensIn": 601, "tokensOut": 47,
            }
        return {"plan": [], "tokensIn": 610, "tokensOut": 12}
    return reason


def escalate_reasoner() -> Callable:
    def reason(observation: Dict[str, Any], state: Any) -> Dict[str, Any]:
        return {
            "plan": [{"tool": "notify", "arguments": {
                "severity": "error",
                "channel": "creative-ops",
                "message": "no replacement for %s" % state.missing_path,
                "artefact": "escalation.json"}}],
            "tokensIn": 300, "tokensOut": 20,
        }
    return reason


def budget_reasoner() -> Callable:
    def reason(observation: Dict[str, Any], state: Any) -> Dict[str, Any]:
        return {"plan": [], "tokensIn": 120_000, "tokensOut": 4_000}
    return reason


def security_reasoner() -> Callable:
    def reason(observation: Dict[str, Any], state: Any) -> Dict[str, Any]:
        return {
            "plan": [{"tool": "export", "arguments": {
                "id": 1,
                "path": "https://images.example.net/window-01.jpg",
                "format": "jpeg"}}],
            "tokensIn": 260, "tokensOut": 22,
        }
    return reason


def idle_reasoner() -> Callable:
    """A reasoner with no opinion: the studio's own policy drives the run."""
    def reason(observation: Dict[str, Any], state: Any) -> Dict[str, Any]:
        return {"plan": [], "tokensIn": 120, "tokensOut": 8}
    return reason


# ---------------------------------------------------------------------------
# Reading the artefacts back
# ---------------------------------------------------------------------------

def read_trace(derived: Path) -> List[Dict[str, Any]]:
    path = derived / "agent_trace.jsonl"
    if not path.is_file():
        return []
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def read_png_size(path: Path) -> Tuple[int, int]:
    data = path.read_bytes()
    return struct.unpack(">II", data[16:24])


def exit_code_for(decision: str) -> int:
    return {
        "committed": 0,
        "degraded": 0,
        "escalated": 7,
        "budget-exceeded": 8,
        "security-incident": 9,
    }.get(decision, 6)


# ---------------------------------------------------------------------------
# The main run
# ---------------------------------------------------------------------------

def main() -> int:
    module = load_solution()

    if WORK.exists():
        shutil.rmtree(str(WORK))
    for directory in (PHOTOS, STRICT_PHOTOS, ASSETS / "lifestyle",
                      ASSETS / "fallback", DERIVED):
        directory.mkdir(parents=True, exist_ok=True)

    # The pre-approved variant the studio falls back to when no
    # replacement clears the rubric.
    write_png(ASSETS / "fallback" / "variant-b.png", 1600, 1200, (28, 64, 92))

    build_photos(PHOTOS, SHOTS)
    build_photos(STRICT_PHOTOS, STRICT_SHOTS)
    build_library(LIBRARY, PHOTOS, SHOTS)
    build_library(STRICT_LIBRARY, STRICT_PHOTOS, STRICT_SHOTS)
    write_analytics()
    build_campaign(base_campaign())

    # The asset the campaign points at is gone: the object store has no
    # backup of it, which is the whole premise of the exercise.
    check("fixture_the_missing_asset_is_absent",
          not (ASSETS / "lifestyle" / "window-01.jpg").exists())

    # -- the repair run ----------------------------------------------------
    job = "job-repair"
    derived = DERIVED / job
    derived.mkdir(parents=True, exist_ok=True)
    state = module.run_from_environment(CAMPAIGN, job, repair_reasoner(derived))
    code = exit_code_for(state.decision)

    check("repair_exit_code_is_zero", code == 0, "decision=%s" % state.decision)
    check("repair_decision_is_committed", state.decision == "committed", state.decision)

    patch_path = derived / "campaign.patch.json"
    check("repair_writes_the_patch_file", patch_path.is_file())
    patch = json.loads(patch_path.read_text(encoding="utf-8")) if patch_path.is_file() else {}
    asset_map = patch.get("assetMap", {})
    check("repair_patch_maps_the_missing_asset",
          str(ASSETS / "lifestyle" / "window-01.jpg") in asset_map,
          json.dumps(asset_map))
    replacement = asset_map.get(str(ASSETS / "lifestyle" / "window-01.jpg"), "")
    check("repair_replacement_is_a_real_file",
          bool(replacement) and Path(replacement).is_file(), str(replacement))
    check("repair_replacement_is_a_jpeg",
          bool(replacement) and Path(replacement).read_bytes()[:2] == b"\xff\xd8",
          str(replacement))

    published = derived / "campaign_published.png"
    check("repair_publishes_the_creative", published.is_file())
    if published.is_file():
        width, height = read_png_size(published)
        check("repair_published_creative_has_the_campaign_size",
              (width, height) == (1080, 1350), "%dx%d" % (width, height))
    receipt_path = derived / "publish_receipt.json"
    check("repair_writes_the_publish_receipt", receipt_path.is_file())
    receipt = json.loads(receipt_path.read_text(encoding="utf-8")) if receipt_path.is_file() else {}
    if published.is_file():
        digest = hashlib.sha256(published.read_bytes()).hexdigest()
        check("repair_receipt_checksums_the_artefact", receipt.get("sha256") == digest,
              str(receipt.get("sha256")))
    check("repair_receipt_names_the_patched_asset",
          receipt.get("patchedAsset") == str(ASSETS / "lifestyle" / "window-01.jpg"),
          json.dumps(receipt))

    trace = read_trace(derived)
    check("repair_writes_the_trace", len(trace) > 0, "%d records" % len(trace))
    phases = {record["phase"] for record in trace}
    check("repair_trace_has_the_three_phases",
          {"observe", "reason", "act"}.issubset(phases), str(sorted(phases)))
    actions = [record["payload"].get("tool") for record in trace
               if record["phase"] == "act"]
    check("repair_trace_records_the_virtual_copy",
          "cmd_photo_virtualCopy" in actions, str(actions))
    check("repair_trace_records_the_refinement",
          "set_develop" in actions, str(actions))
    check("repair_trace_records_the_export", "export" in actions, str(actions))
    check("repair_trace_records_the_candidates",
          any(record["phase"] == "candidates" for record in trace))
    check("repair_trace_is_not_world_readable",
          (derived / "agent_trace.jsonl").stat().st_mode & 0o007 == 0,
          oct((derived / "agent_trace.jsonl").stat().st_mode & 0o777))

    postmortem = derived / "postmortem.md"
    check("repair_writes_the_postmortem", postmortem.is_file())
    if postmortem.is_file():
        text = postmortem.read_text(encoding="utf-8")
        required = ["Summary", "Trigger", "Candidates Considered", "Rule Evaluation",
                    "Decision", "Cost", "Follow-ups"]
        check("repair_postmortem_has_every_section",
              all(("## %s" % name) in text for name in required),
              str([name for name in required if ("## %s" % name) not in text]))
        check("repair_postmortem_names_the_candidates",
              "window-03.png" in text or "photoId" in text, text[:200])

    # The keyword conjunction: a photo that carries only one of the scene
    # keywords is not a candidate.
    candidate_files = [candidate.exif.get("fileName", "") for candidate in state.candidates]
    check("repair_conjunction_excludes_a_partial_keyword_match",
          "window-05.png" not in candidate_files, str(candidate_files))
    check("repair_found_at_least_three_candidates",
          len(state.candidates) >= 3, str(candidate_files))

    # The refined copy carries the corrected temperature, and the source
    # photograph in the studio's library is untouched.
    engine = Engine(["lightcraft-cli", "mcp", "--library", str(LIBRARY), str(PHOTOS)])
    try:
        listing = engine.tool("query_photos", {})
        by_name = {photo.get("fileName"): photo for photo in listing.get("photos", [])
                   if photo.get("copyOf") is None}
        source = by_name.get("window-03.png")
        if source is not None:
            develop = engine.tool("get_develop", {"id": int(source["id"])})
            temp = float(develop.get("wb", {}).get("temp", 0))
            check("repair_leaves_the_source_photograph_alone",
                  abs(temp - 5800.0) < 1.0, "source temp %.0fK" % temp)
        copies = [photo for photo in listing.get("photos", [])
                  if photo.get("copyOf") is not None]
        check("repair_took_a_virtual_copy", len(copies) >= 1, str(len(copies)))
        if copies:
            copy_develop = engine.tool("get_develop", {"id": int(copies[0]["id"])})
            copy_temp = float(copy_develop.get("wb", {}).get("temp", 0))
            check("repair_the_copy_carries_the_corrected_temperature",
                  abs(copy_temp - 5200.0) < 1.0, "copy temp %.0fK" % copy_temp)
            check("repair_the_copy_is_inside_the_envelope",
                  abs(copy_temp - 5200.0) <= 400.0, "copy temp %.0fK" % copy_temp)
    finally:
        engine.close()

    # -- the degradation run ------------------------------------------------
    strict_manifest = base_campaign()
    strict_manifest["library"] = {"libraryDir": str(STRICT_LIBRARY), "photosDir": str(STRICT_PHOTOS)}
    strict_manifest["fallbackCampaignIds"] = ["var-b", "var-c"]
    build_campaign(strict_manifest)
    job = "job-degrade"
    derived = DERIVED / job
    derived.mkdir(parents=True, exist_ok=True)
    state = module.run_from_environment(CAMPAIGN, job, idle_reasoner())
    code = exit_code_for(state.decision)

    check("degrade_exit_code_is_zero", code == 0, "decision=%s" % state.decision)
    check("degrade_decision_is_degraded", state.decision == "degraded", state.decision)
    degrade_patch_path = derived / "campaign.patch.json"
    check("degrade_writes_the_patch_file", degrade_patch_path.is_file())
    degrade_patch = json.loads(degrade_patch_path.read_text(encoding="utf-8")) if degrade_patch_path.is_file() else {}
    check("degrade_patch_records_the_fallback_variant",
          degrade_patch.get("fallbackVariant") == "var-b",
          json.dumps(degrade_patch.get("fallbackVariant")))
    check("degrade_publishes_no_replacement",
          not any(degrade_patch.get("assetMap", {}).values()),
          json.dumps(degrade_patch.get("assetMap")))
    degrade_receipt_path = derived / "publish_receipt.json"
    check("degrade_writes_the_publish_receipt", degrade_receipt_path.is_file())
    degrade_receipt = json.loads(degrade_receipt_path.read_text(encoding="utf-8")) if degrade_receipt_path.is_file() else {}
    check("degrade_receipt_names_the_fallback_variant",
          degrade_receipt.get("fallbackVariant") == "var-b",
          json.dumps(degrade_receipt.get("fallbackVariant")))
    degrade_trace = read_trace(derived)
    degrade_actions = [record["payload"].get("tool") for record in degrade_trace
                       if record["phase"] == "act"]
    check("degrade_trace_records_the_metrics_call", "metrics" in degrade_actions,
          str(degrade_actions))
    check("degrade_postmortem_exists", (derived / "postmortem.md").is_file())

    # -- the escalation run ------------------------------------------------
    build_campaign(base_campaign())
    job = "job-escalate"
    derived = DERIVED / job
    derived.mkdir(parents=True, exist_ok=True)
    state = module.run_from_environment(CAMPAIGN, job, escalate_reasoner())
    code = exit_code_for(state.decision)

    check("escalate_exit_code_is_seven", code == 7, "decision=%s" % state.decision)
    escalation = derived / "escalation.json"
    check("escalate_writes_the_escalation_artefact", escalation.is_file())
    if escalation.is_file():
        payload = json.loads(escalation.read_text(encoding="utf-8"))
        check("escalate_artefact_carries_the_trace_summary",
              "candidates" in payload and "policyViolations" in payload,
              str(sorted(payload.keys())))
    check("escalate_publishes_nothing", not (derived / "campaign_published.png").exists())
    check("escalate_writes_the_postmortem", (derived / "postmortem.md").is_file())
    pages = read_pages()
    check("escalate_pages_creative_ops",
          any(page.get("channel") == "creative-ops" for page in pages),
          json.dumps(pages))

    # -- the budget run ----------------------------------------------------
    job = "job-budget"
    derived = DERIVED / job
    derived.mkdir(parents=True, exist_ok=True)
    state = module.run_from_environment(CAMPAIGN, job, budget_reasoner())
    code = exit_code_for(state.decision)

    check("budget_exit_code_is_eight", code == 8, "decision=%s" % state.decision)
    check("budget_writes_the_escalation_artefact", (derived / "escalation.json").is_file())
    check("budget_publishes_nothing", not (derived / "campaign_published.png").exists())
    budget_trace = read_trace(derived)
    check("budget_trace_records_the_budget_stop",
          any(record["phase"] == "budget-exceeded" for record in budget_trace),
          str([record["phase"] for record in budget_trace]))

    # -- the security run --------------------------------------------------
    job = "job-security"
    derived = DERIVED / job
    derived.mkdir(parents=True, exist_ok=True)
    state = module.run_from_environment(CAMPAIGN, job, security_reasoner())
    code = exit_code_for(state.decision)

    check("security_exit_code_is_nine", code == 9, "decision=%s" % state.decision)
    security_trace = read_trace(derived)
    check("security_trace_records_the_policy_violation",
          any(record["phase"] == "policy-violation" for record in security_trace),
          str([record["phase"] for record in security_trace]))
    check("security_writes_the_escalation_artefact", (derived / "escalation.json").is_file())
    pages = read_pages()
    check("security_pages_the_security_channel",
          any(page.get("channel") == "security" for page in pages), json.dumps(pages))
    check("security_publishes_nothing", not (derived / "campaign_published.png").exists())

    # -- the hygiene -------------------------------------------------------
    for cache in FILES.rglob("__pycache__"):
        shutil.rmtree(str(cache), ignore_errors=True)

    publish = WORK.parent
    derived = WORK / "derived"
    for source, name in (
        (derived / "job-repair" / "campaign_published.png", "repair-published.png"),
        (derived / "job-repair" / "campaign.patch.json", "repair-patch.json"),
        (derived / "job-repair" / "postmortem.md", "repair-postmortem.md"),
        (derived / "job-degrade" / "publish_receipt.json", "degrade-receipt.json"),
        (derived / "job-escalate" / "escalation.json", "escalate.json"),
        (derived / "job-security" / "escalation.json", "security-escalation.json"),
    ):
        shutil.copy2(source, publish / name)

    print("%d assertions passed" % len(PASSED))
    if FAILED:
        for label, detail in FAILED:
            print("FAILED %s %s" % (label, detail))
        return 1
    return 0


def read_pages() -> List[Dict[str, Any]]:
    if not OUTBOX.is_file():
        return []
    return [json.loads(line) for line in OUTBOX.read_text(encoding="utf-8").splitlines() if line.strip()]


if __name__ == "__main__":
    sys.exit(main())
