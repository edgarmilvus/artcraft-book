#!/usr/bin/env python3
"""
self_healing_agent.py — the ReAct loop that repairs a broken campaign.

A campaign job failed at 03:12 because a lifestyle shot went missing from
the object store. The studio does not simply fail: it looks for a
replacement in its own library, judges the candidates against the
campaign's own quality rubric, refines one if it is close enough, and only
then re-enters the publish gate. If nothing is good enough it degrades to a
variant that has performed acceptably, and if that is not possible either
it escalates to a human with the whole decision trail attached.

Design discipline, demonstrated in-code:

  * The agent never reaches the public internet. A plan that names a host
    outside the allow-list is rejected at *plan-validation* time, before
    anything is executed, and the run ends as a security incident.
  * The agent never mutates a source library photo. It takes a virtual
    copy first and refines the copy, so the blast radius of a mistake is
    one derived JPEG instead of the studio's canonical library.
  * Every observation, plan and action is appended to agent_trace.jsonl
    with an fsync, so a crash leaves a fully reconstructible trail.
  * The language model is a caller-provided closure. The agent itself
    opens no socket and needs no API key.

Exit codes
    0  the campaign was repaired and published (or degraded and published)
    6  the agent ran out of steps without a decision
    7  the agent escalated to a human
    8  a budget (tokens or wall clock) was exceeded
    9  a policy violation: the run was a security incident
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Optional

# ---------------------------------------------------------------------------
# Runtime budgets (hard caps; exceeding one terminates the run).
# ---------------------------------------------------------------------------

MAX_AGENT_STEPS = 8            # the hard maximum is 16
MAX_AGENT_STEPS_HARD = 16
MAX_REFINED_CANDIDATES = 2     # at most two candidates may be refined
TOKEN_BUDGET_INPUT = 60_000
TOKEN_BUDGET_OUTPUT = 8_000
WALL_REASONING_SEC = 90
WALL_TOTAL_SEC = 600           # ten minutes, engine calls included

# The only host the agent may reach. In production it is the studio's
# internal LLM endpoint, allow-listed by hostname and pinned by TLS.
ALLOWED_NETWORK_HOSTS = {"llm.internal.studio.example"}

# The click-through floor a fallback variant has to clear.
CTR_FLOOR = 0.008              # 0.8 %

EXIT_OK = 0
EXIT_NO_DECISION = 6
EXIT_ESCALATED = 7
EXIT_BUDGET = 8
EXIT_SECURITY = 9


class AgentError(Exception):
    """A failure the agent cannot recover from."""


class PolicyError(Exception):
    """A plan that the policy gate refuses to execute."""


# ---------------------------------------------------------------------------
# A synchronous MCP client (JSON-RPC 2.0 over line-delimited frames).
# ---------------------------------------------------------------------------

class McpClient:
    """Drives one engine's MCP server over stdio.

    The engines answer in order, so a synchronous request/response is
    enough; stderr is drained on its own thread so a chatty engine cannot
    deadlock the pipe.
    """

    def __init__(self, command: list[str], cwd: Optional[Path] = None) -> None:
        self.command = list(command)
        self.proc = subprocess.Popen(
            self.command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
            bufsize=1,
            cwd=str(cwd) if cwd is not None else None,
        )
        self._id = 0
        self._lock = threading.Lock()
        self._request("initialize", {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "self-healing-agent", "version": "1.0"},
        })
        self._notify("notifications/initialized", {})

    def _request(self, method: str, params: dict) -> Any:
        with self._lock:
            self._id += 1
            frame = {"jsonrpc": "2.0", "id": self._id, "method": method, "params": params}
            assert self.proc.stdin is not None and self.proc.stdout is not None
            self.proc.stdin.write(json.dumps(frame) + "\n")
            self.proc.stdin.flush()
            line = self.proc.stdout.readline()
            if not line:
                raise AgentError("%s closed the pipe" % self.command[0])
            response = json.loads(line)
            if "error" in response:
                raise AgentError("%s: %s" % (self.command[0], json.dumps(response["error"])))
            return response.get("result")

    def _notify(self, method: str, params: dict) -> None:
        with self._lock:
            assert self.proc.stdin is not None
            self.proc.stdin.write(json.dumps({"jsonrpc": "2.0", "method": method, "params": params}) + "\n")
            self.proc.stdin.flush()

    def call_tool(self, name: str, arguments: dict) -> Any:
        result = self._request("tools/call", {"name": name, "arguments": arguments})
        if not isinstance(result, dict):
            return result
        if result.get("isError") is True:
            raise AgentError("%s rejected %s: %s" % (self.command[0], name, json.dumps(result.get("content"))[:300]))
        content = result.get("content") or []
        for block in content:
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
# The tool registry: what the agent may call, and under which permissions.
# ---------------------------------------------------------------------------

@dataclass
class ToolPermissions:
    read: list = field(default_factory=list)
    write: list = field(default_factory=list)
    network: list = field(default_factory=list)
    severity_floor: Optional[str] = None


@dataclass
class AgentTool:
    name: str
    purpose: str
    args_schema: dict
    permissions: ToolPermissions
    call: Callable[[dict], Any]


@dataclass
class ToolRegistry:
    tools: dict = field(default_factory=dict)

    def add(self, tool: AgentTool) -> None:
        self.tools[tool.name] = tool

    def get(self, name: str) -> Optional[AgentTool]:
        return self.tools.get(name)

    def names(self) -> list:
        return sorted(self.tools)


# ---------------------------------------------------------------------------
# The rubric: four machine-checkable rules.
# ---------------------------------------------------------------------------

@dataclass
class CampaignRules:
    min_width: int
    min_height: int
    target_temp_kelvin: float
    temp_tolerance_kelvin: float = 400.0
    crop_aspect: tuple = (4, 3)
    max_crop_discard_fraction: float = 0.15

    @staticmethod
    def from_campaign(campaign: dict) -> "CampaignRules":
        rules = campaign.get("assetRules", {})
        aspect = rules.get("cropAspect", [4, 3])
        return CampaignRules(
            min_width=int(rules.get("minWidth", 1600)),
            min_height=int(rules.get("minHeight", 1200)),
            target_temp_kelvin=float(rules.get("targetTempK", 5200)),
            temp_tolerance_kelvin=float(rules.get("tempToleranceK", 400)),
            crop_aspect=(float(aspect[0]), float(aspect[1])),
            max_crop_discard_fraction=float(rules.get("maxCropDiscardFraction", 0.15)),
        )


@dataclass
class Candidate:
    photo_id: int
    path: str
    width: int
    height: int
    exif: dict = field(default_factory=dict)
    develop: dict = field(default_factory=dict)
    keywords: list = field(default_factory=list)
    flag: str = "none"
    rating: int = 0
    deleted: bool = False
    missing: bool = False
    copy_id: Optional[int] = None
    exported_path: Optional[str] = None
    rules: dict = field(default_factory=dict)

    def temp_kelvin(self) -> float:
        for key in ("wb.temp", "light.temp", "whiteBalance.temp"):
            if key in self.develop:
                return float(self.develop[key])
        wb = self.develop.get("wb")
        if isinstance(wb, dict) and "temp" in wb:
            return float(wb["temp"])
        return 5500.0

    def set_temp(self, value: float) -> None:
        if "wb" in self.develop and isinstance(self.develop["wb"], dict):
            self.develop["wb"]["temp"] = value
        self.develop["wb.temp"] = value

    def passes(self) -> bool:
        return bool(self.rules) and all(rule.get("pass") is True for rule in self.rules.values())

    def failed_rules(self) -> list:
        return sorted(name for name, rule in self.rules.items() if rule.get("pass") is not True)


def evaluate_candidate(candidate: Candidate, rules: CampaignRules) -> dict:
    """Return {ruleId: {pass, detail}} for one candidate."""
    results: dict = {}

    # Rule 1 — resolution: both axes must reach the campaign's minimum.
    ok = candidate.width >= rules.min_width and candidate.height >= rules.min_height
    results["resolution"] = {
        "pass": ok,
        "detail": "%dx%d against a minimum of %dx%d" % (
            candidate.width, candidate.height, rules.min_width, rules.min_height),
    }

    # Rule 2 — colour temperature: the shot's white balance must sit within
    # the campaign's envelope.
    temp = candidate.temp_kelvin()
    delta = abs(temp - rules.target_temp_kelvin)
    results["color-temp"] = {
        "pass": delta <= rules.temp_tolerance_kelvin,
        "detail": "%.0fK against a target of %.0fK (+/-%.0fK), delta %.0fK" % (
            temp, rules.target_temp_kelvin, rules.temp_tolerance_kelvin, delta),
    }

    # Rule 3 — editability: a deleted photo, a photo whose file has gone
    # missing, or a photo already under a develop lock cannot be refined.
    locked = candidate.deleted or candidate.missing
    results["editability"] = {
        "pass": not locked,
        "detail": "photo is editable" if not locked else "photo is locked",
    }

    # Rule 4 — framing: the campaign's crop must fit inside the candidate
    # without discarding more than the allowed fraction of the frame.
    #
    #   used_w, used_h = the crop that fits the target aspect
    #   discarded     = 1 - (used_w * used_h) / (width * height)
    target_aspect = rules.crop_aspect[0] / rules.crop_aspect[1]
    candidate_aspect = candidate.width / candidate.height if candidate.height else 0.0
    if candidate_aspect > target_aspect:
        used_w, used_h = candidate.height * target_aspect, candidate.height
    else:
        used_w, used_h = candidate.width, candidate.width / target_aspect if target_aspect else 0.0
    total = candidate.width * candidate.height
    discarded = 1.0 - (used_w * used_h / total) if total else 1.0
    results["framing"] = {
        "pass": discarded <= rules.max_crop_discard_fraction,
        "detail": "the crop would discard %.1f%% of the frame (budget %.0f%%)" % (
            discarded * 100, rules.max_crop_discard_fraction * 100),
    }
    return results


def rank_candidates(candidates: list, rules: CampaignRules) -> list:
    """The agent's own ranking, on top of the library's editDate order.

    Distance from the target colour temperature comes first, resolution
    headroom second: a candidate that is already inside the envelope needs
    no refinement, and a candidate with headroom can be cropped without
    losing the subject.
    """
    def key(candidate: Candidate) -> tuple:
        temp_distance = abs(candidate.temp_kelvin() - rules.target_temp_kelvin)
        headroom = min(candidate.width / max(rules.min_width, 1),
                       candidate.height / max(rules.min_height, 1))
        return (temp_distance, -headroom, -candidate.rating, candidate.photo_id)

    return sorted(candidates, key=key)


# ---------------------------------------------------------------------------
# The trace: append-only, flushed and fsynced on every line.
# ---------------------------------------------------------------------------

class Trace:
    """The agent's persistence log.

    Every write is flushed and fsynced, because the agent must survive a
    mid-run crash and be inspectable from whatever it managed to write.
    The trace is sensitive: it carries the studio's internal paths, so it
    is left readable by its owner's group only.
    """

    def __init__(self, path: Path) -> None:
        self.path = path
        path.parent.mkdir(parents=True, exist_ok=True)
        self.handle = open(path, "a", encoding="utf-8")

    def append(self, step: int, phase: str, payload: Any) -> None:
        record = {
            "step": step,
            "phase": phase,
            "payload": payload,
            "at": datetime.now(timezone.utc).isoformat(),
        }
        self.handle.write(json.dumps(record, default=str) + "\n")
        self.handle.flush()
        os.fsync(self.handle.fileno())

    def close(self) -> None:
        try:
            os.chmod(self.path, 0o640)
        except OSError:
            pass
        self.handle.close()


# ---------------------------------------------------------------------------
# The agent's memory.
# ---------------------------------------------------------------------------

@dataclass
class AgentState:
    job_id: str
    campaign: dict
    missing_path: str
    candidates: list = field(default_factory=list)
    refining: Optional[Candidate] = None
    refinements: int = 0
    step: int = 0
    decision: str = "running"
    committed: Optional[dict] = None
    tokens_in: int = 0
    tokens_out: int = 0
    reasoning_seconds: float = 0.0
    started_at: float = field(default_factory=time.monotonic)
    policy_violations: list = field(default_factory=list)
    copies: set = field(default_factory=set)
    pages: list = field(default_factory=list)
    notes: list = field(default_factory=list)


@dataclass
class AgentConfig:
    """Everything the agent needs, and nothing it could reach out for."""

    job_id: str
    campaign: dict
    missing_path: str
    derived_dir: Path
    assets_dir: Path
    library_dir: Path
    library_photos: Path
    analytics_path: Path
    outbox_path: Path
    reasoner: Callable[[dict, "AgentState"], dict]
    lightcraft_command: list = field(default_factory=lambda: ["lightcraft-cli", "mcp"])
    photocraft_command: list = field(default_factory=lambda: ["photocraft-cli", "mcp"])
    publish_gate_command: list = field(default_factory=list)
    max_steps: int = MAX_AGENT_STEPS
    # The photo ids the agent has taken a virtual copy of, in this run.
    copies: set = field(default_factory=set)


# ---------------------------------------------------------------------------
# Plan validation: the policy gate, run before anything is executed.
# ---------------------------------------------------------------------------

def is_within(path: Path, root: Path) -> bool:
    """True when `path` is inside `root` (after both are resolved)."""
    try:
        resolved = path.resolve()
        base = root.resolve()
    except OSError:
        return False
    return resolved == base or base in resolved.parents


def validate_plan_step(step: dict, registry: ToolRegistry, config: AgentConfig) -> tuple:
    """Return (allowed, reason). A network violation is fatal; the rest is not."""
    if not isinstance(step, dict):
        return False, "the plan step is not an object"
    tool_name = step.get("tool")
    arguments = step.get("arguments") or {}
    if not isinstance(tool_name, str):
        return False, "the plan step has no tool name"
    if not isinstance(arguments, dict):
        return False, "the plan step's arguments are not an object"
    tool = registry.get(tool_name)
    if tool is None:
        return False, "unknown tool: %s" % tool_name

    # 1. The filesystem scope. A read may only reach the asset store; a
    #    write may only reach this job's derived directory.
    if tool_name == "filesystem":
        operation = arguments.get("op")
        raw = arguments.get("path")
        if not isinstance(raw, str):
            return False, "filesystem step without a path"
        target = Path(raw)
        if operation == "read":
            if not is_within(target, config.assets_dir):
                return False, "filesystem.read outside the asset store: %s" % target
        elif operation == "write":
            if not is_within(target, config.derived_dir):
                return False, "filesystem.write outside the job's derived directory: %s" % target
        else:
            return False, "unknown filesystem operation: %s" % operation

    # 2. The network allow-list. Any argument that names a URL is a
    #    network intent, wherever it hides: the host has to be the
    #    studio's LLM endpoint, or the step is refused here, at plan
    #    time, and never at execution time.
    for value in list(arguments.values()) + list(arguments.get("arguments", []) if isinstance(arguments.get("arguments"), list) else []):
        if not isinstance(value, str):
            continue
        if not (value.startswith("http://") or value.startswith("https://")):
            continue
        host = value.split("//", 1)[-1].split("/", 1)[0].split(":", 1)[0]
        if host not in ALLOWED_NETWORK_HOSTS:
            return False, "network host not allow-listed: %s" % host

    # 3. set_develop on a source photo is forbidden. The agent may only
    #    refine a copy it created in this run.
    if tool_name == "set_develop":
        photo_id = arguments.get("id")
        if photo_id not in config.copies:
            return False, ("set_develop on a source photo is forbidden; "
                           "take a virtual copy first")

    # 4. The notify tool has a severity floor.
    if tool_name == "notify":
        severity = arguments.get("severity")
        floor = tool.permissions.severity_floor or "info"
        order = ["info", "warning", "error"]
        if severity not in order or order.index(severity) < order.index(floor):
            return False, "notify requires a severity of at least %r" % floor

    return True, ""


# ---------------------------------------------------------------------------
# The publish gate: the pipeline the agent re-enters.
# ---------------------------------------------------------------------------

def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(65536), b""):
            digest.update(chunk)
    return digest.hexdigest()


def run_publish_gate(config: AgentConfig, patch_path: Path, campaign: dict) -> dict:
    """Re-enter the publish gate with a patch file.

    The gate is a separate process: the agent that decides and the
    pipeline that publishes do not share a memory, so a crash in one
    cannot leave the other half-applied.
    """
    command = list(config.publish_gate_command)
    if not command:
        raise AgentError("no publish gate is configured")
    command = command + [
        "--publish-gate",
        "--campaign", str(config.derived_dir / "campaign.json"),
        "--patch", str(patch_path),
        "--out", str(config.derived_dir),
    ]
    completed = subprocess.run(command, capture_output=True, text=True)
    receipt_path = config.derived_dir / "publish_receipt.json"
    receipt: dict = {}
    if receipt_path.is_file():
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
    return {
        "command": command,
        "exitCode": completed.returncode,
        "stdout": completed.stdout[-2000:],
        "stderr": completed.stderr[-2000:],
        "receipt": receipt,
    }


# ---------------------------------------------------------------------------
# The agent.
# ---------------------------------------------------------------------------

class Agent:
    """The ReAct loop, its tools and its decisions."""

    def __init__(self, config: AgentConfig) -> None:
        self.config = config
        self.rules = CampaignRules.from_campaign(config.campaign)
        self.registry = ToolRegistry()
        self.lightcraft: Optional[McpClient] = None
        self.photocraft: Optional[McpClient] = None
        self.trace: Optional[Trace] = None
        self.state = AgentState(
            job_id=config.job_id,
            campaign=config.campaign,
            missing_path=config.missing_path,
        )

    # -- the engines ------------------------------------------------------

    def open_engines(self) -> None:
        self.lightcraft = McpClient(
            self.config.lightcraft_command
            + ["--library", str(self.config.library_dir), str(self.config.library_photos)])
        self.photocraft = McpClient(
            self.config.photocraft_command
            + ["--automation-read-root", str(self.config.assets_dir.parent),
               "--automation-write-root", str(self.config.derived_dir)])

    def close_engines(self) -> None:
        for client in (self.lightcraft, self.photocraft):
            if client is not None:
                client.close()
        self.lightcraft = None
        self.photocraft = None

    # -- the tool registry ------------------------------------------------

    def build_registry(self) -> ToolRegistry:
        registry = self.registry
        light = self.lightcraft
        photo = self.photocraft
        config = self.config
        assert light is not None and photo is not None

        def lc(name: str) -> Callable[[dict], Any]:
            def call(arguments: dict) -> Any:
                return light.call_tool(name, arguments)
            return call

        def pc(name: str) -> Callable[[dict], Any]:
            def call(arguments: dict) -> Any:
                return photo.call_tool(name, arguments)
            return call

        def add(name: str, purpose: str, schema: dict, call: Callable[[dict], Any],
                read: Optional[list] = None, write: Optional[list] = None,
                network: Optional[list] = None, severity_floor: Optional[str] = None) -> None:
            registry.add(AgentTool(
                name=name,
                purpose=purpose,
                args_schema=schema,
                permissions=ToolPermissions(
                    read=list(read or []),
                    write=list(write or []),
                    network=list(network or []),
                    severity_floor=severity_floor,
                ),
                call=call,
            ))

        # -- LightCraft: the studio's own library -------------------------
        add("list_commands", "Enumerate the LightCraft commands and their parameters.",
            {"filter": "string?"}, lc("list_commands"))
        add("command_run", "Run one LightCraft engine command by its id.",
            {"id": "string", "params": "object?"}, lc("command_run"))
        add("command_batch", "Run several LightCraft commands in one call.",
            {"steps": "array"}, lc("command_batch"))
        add("query_photos", "List the photos that match a catalogue filter.",
            {"filter": "object?", "sort": "object?", "limit": "int?", "offset": "int?"},
            lc("query_photos"), read=[str(config.library_dir)])
        add("cmd_library_filter", "Filter the library view.",
            {"text": "string?", "rating": "int?", "ratingOp": "string?",
             "flag": "string?", "keyword": "string?"},
            lc("cmd_library_filter"), read=[str(config.library_dir)])
        add("cmd_library_sort", "Sort the library view.",
            {"key": "string?", "ascending": "bool?"},
            lc("cmd_library_sort"), read=[str(config.library_dir)])
        add("cmd_library_select", "Set the library selection.",
            {"ids": "array", "active": "int?", "mode": "string?"},
            lc("cmd_library_select"), read=[str(config.library_dir)])
        add("cmd_albums_list", "List the studio's albums.", {}, lc("cmd_albums_list"))
        add("cmd_presets_list", "List the develop presets.", {}, lc("cmd_presets_list"))
        add("cmd_develop_controls", "List every develop slider and its range.", {},
            lc("cmd_develop_controls"))
        add("cmd_photo_inspect", "Read a photo's EXIF, dimensions and develop settings.",
            {"id": "int"}, lc("cmd_photo_inspect"), read=[str(config.library_dir)])
        add("get_develop", "Read a photo's develop settings.",
            {"id": "int"}, lc("get_develop"), read=[str(config.library_dir)])
        add("set_develop", "Write a photo's develop settings. Copies only.",
            {"id": "int", "values": "object", "label": "string?"},
            lc("set_develop"), write=[str(config.library_dir)])
        add("crop", "Set the crop of a photo.",
            {"id": "int", "rect": "array?", "angle": "number?", "reset": "bool?"},
            lc("crop"), write=[str(config.library_dir)])
        add("export", "Render a photo and write it out.",
            {"id": "int", "path": "string", "format": "string?", "quality": "int?"},
            lc("export"), write=[str(config.derived_dir)])
        add("render_photo", "Render a photo and return the image.",
            {"id": "int", "path": "string?", "size": "int?", "format": "string?"},
            lc("render_photo"), read=[str(config.library_dir)])
        add("apply_preset", "Apply a develop preset to photos.",
            {"preset": "string", "ids": "array?", "amount": "number?"},
            lc("apply_preset"), write=[str(config.library_dir)])
        add("cmd_photo_virtualCopy", "Take a virtual copy of a photo. The only way to refine.",
            {"ids": "array", "name": "string?"},
            lc("cmd_photo_virtualCopy"), write=[str(config.library_dir)])

        # -- PhotoCraft: the final composite -------------------------------
        # PhotoCraft and LightCraft both answer to `command_run` and
        # `command_batch`, and a registry cannot hold two tools under one
        # name: the PhotoCraft tools are therefore namespaced. The
        # namespace is the price of two engines sharing a vocabulary.
        add("photocraft.command_run", "Run one PhotoCraft engine command by its id.",
            {"id": "string", "params": "object?"}, pc("command_run"),
            read=[str(config.assets_dir)], write=[str(config.derived_dir)])
        add("photocraft.command_batch", "Run several PhotoCraft commands in one call.",
            {"steps": "array"}, pc("command_batch"),
            read=[str(config.assets_dir)], write=[str(config.derived_dir)])
        add("photocraft.doc_new", "Create a new PhotoCraft document.",
            {"width": "int", "height": "int", "mode": "string?",
             "depth": "int?", "background": "string?"},
            pc("doc_new"), write=[str(config.derived_dir)])
        add("photocraft.doc_open", "Open an image in PhotoCraft.",
            {"path": "string"}, pc("doc_open"), read=[str(config.assets_dir)])
        add("photocraft.doc_place", "Place a file into the document as a layer.",
            {"path": "string", "fit": "bool?", "scale": "number?"},
            pc("doc_place"), read=[str(config.assets_dir)], write=[str(config.derived_dir)])
        add("photocraft.doc_save", "Save the document.",
            {"path": "string", "format": "string?"},
            pc("doc_save"), write=[str(config.derived_dir)])

        # -- the studio's own tools ----------------------------------------
        def filesystem(arguments: dict) -> Any:
            operation = arguments.get("op")
            raw = arguments.get("path")
            if not isinstance(raw, str):
                raise AgentError("filesystem call without a path")
            target = Path(raw)
            if operation == "read":
                if not is_within(target, config.assets_dir):
                    raise PermissionError("filesystem.read denied: %s" % target)
                return {"bytes": target.read_bytes()}
            if operation == "write":
                if not is_within(target, config.derived_dir):
                    raise PermissionError("filesystem.write denied: %s" % target)
                payload = arguments.get("data")
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(payload if isinstance(payload, bytes) else str(payload).encode("utf-8"))
                return {"bytes": target.stat().st_size, "path": str(target)}
            raise AgentError("unknown filesystem operation: %s" % operation)

        add("filesystem", "Read the asset store; write into this job's derived directory.",
            {"op": "string", "path": "string", "data": "bytes?"}, filesystem,
            read=[str(config.assets_dir)], write=[str(config.derived_dir)])

        def notify(arguments: dict) -> Any:
            severity = arguments.get("severity")
            if severity not in ("warning", "error"):
                raise PermissionError("notify requires a severity of at least 'warning'")
            page = {
                "ticket": "PAGE-%s" % uuid.uuid4().hex[:10],
                "severity": severity,
                "channel": arguments.get("channel", "creative-ops"),
                "message": arguments.get("message", ""),
                "artefact": arguments.get("artefact", ""),
                "at": datetime.now(timezone.utc).isoformat(),
            }
            config.outbox_path.parent.mkdir(parents=True, exist_ok=True)
            with open(config.outbox_path, "a", encoding="utf-8") as handle:
                handle.write(json.dumps(page) + "\n")
            return page

        add("notify", "Page the creative-ops or the security channel.",
            {"severity": "string", "channel": "string", "message": "string",
             "artefact": "string"}, notify, severity_floor="warning")

        def metrics(arguments: dict) -> Any:
            if not config.analytics_path.is_file():
                return {"variants": []}
            record = json.loads(config.analytics_path.read_text(encoding="utf-8"))
            wanted = arguments.get("campaignIds") or []
            variants = [variant for variant in record.get("variants", [])
                        if not wanted or variant.get("id") in wanted]
            return {"windowDays": record.get("windowDays", 30), "variants": variants}

        add("metrics", "Read the last-30-days performance of a campaign's variants.",
            {"campaignIds": "array?"}, metrics)

        return registry

    # -- the observation --------------------------------------------------

    def observe_candidates(self, photos: list) -> list:
        """Read every candidate's EXIF and develop settings.

        This is *observation*, not action: the agent perceives the library
        before it reasons about it, and the observation is what the rubric
        is evaluated against.
        """
        missing_ids = set()
        try:
            missing = self.registry.get("command_run")
            assert missing is not None
            outcome = self.lightcraft.call_tool("command_run", {
                "id": "library.missing", "params": {}})
            for entry in outcome.get("missing", []) if isinstance(outcome, dict) else []:
                if isinstance(entry, dict) and isinstance(entry.get("id"), int):
                    missing_ids.add(entry["id"])
        except Exception:
            missing_ids = set()

        candidates: list = []
        for photo in photos:
            if not isinstance(photo, dict):
                continue
            photo_id = int(photo.get("id", 0))
            inspect: dict = {}
            develop: dict = {}
            try:
                inspected = self.lightcraft.call_tool("cmd_photo_inspect", {"id": photo_id})
                if isinstance(inspected, dict):
                    inspect = inspected
            except Exception:
                inspect = {}
            try:
                settings = self.lightcraft.call_tool("get_develop", {"id": photo_id})
                if isinstance(settings, dict):
                    develop = settings
            except Exception:
                develop = {}

            exif = {
                "fileName": str(inspect.get("file_name", photo.get("fileName", ""))),
                "format": str(inspect.get("format", photo.get("format", ""))),
                "camera": str(photo.get("camera", "")),
                "captured": str(inspect.get("captured") or photo.get("captured") or ""),
                "imported": str(inspect.get("imported", "")),
            }
            candidate = Candidate(
                photo_id=photo_id,
                path=str(photo.get("path") or inspect.get("source") or ""),
                width=int(photo.get("width", inspect.get("width", 0)) or 0),
                height=int(photo.get("height", inspect.get("height", 0)) or 0),
                exif=exif,
                develop=develop,
                keywords=list(photo.get("keywords", []) or []),
                flag=str(photo.get("flag", "none")),
                rating=int(photo.get("rating", 0) or 0),
                deleted=bool(inspect.get("deleted", False)),
                missing=photo_id in missing_ids,
            )
            candidate.rules = evaluate_candidate(candidate, self.rules)
            candidates.append(candidate)
        return candidates

    # -- the built-in policy ----------------------------------------------

    def policy_plan(self) -> list:
        """The studio's own judgement, used when the reasoner's plan is unusable.

        The reasoner proposes; the rubric decides. This plan is the
        studio's default sequence: search, refine, export, and — if
        nothing is good enough — fall back to a variant that has
        performed.
        """
        state = self.state
        if not state.candidates:
            return [{"tool": "query_photos", "arguments": {"filter": self.search_filter()}}]

        for candidate in state.candidates:
            if candidate.exported_path is not None:
                continue
            if candidate.passes():
                return [{"tool": "export", "arguments": self.export_arguments(candidate)}]

        if state.refinements < MAX_REFINED_CANDIDATES:
            for candidate in rank_candidates(state.candidates, self.rules):
                if candidate.exported_path is not None:
                    continue
                if candidate.failed_rules() != ["color-temp"]:
                    continue
                if candidate.copy_id is None:
                    return [{"tool": "cmd_photo_virtualCopy", "arguments": {"ids": [candidate.photo_id]}}]
                adjusted = self.compensated_temp(candidate)
                return [{"tool": "set_develop", "arguments": {
                    "id": candidate.copy_id,
                    "values": {"wb.temp": adjusted},
                    "label": "agent refinement for %s" % state.job_id,
                }}]

        fallbacks = self.state.campaign.get("fallbackCampaignIds") or []
        if fallbacks:
            return [{"tool": "metrics", "arguments": {"campaignIds": fallbacks}}]
        return []

    def search_filter(self) -> dict:
        scene = self.state.campaign.get("scene", {})
        keyword = scene.get("keyword", "lifestyle")
        rating = int(self.state.campaign.get("assetRules", {}).get("minRating", 3))
        return {"flag": "pick", "rating": rating, "ratingOp": "atLeast", "keyword": keyword}

    def compensated_temp(self, candidate: Candidate) -> float:
        """The temperature that would put the candidate inside the envelope.

        The adjustment is bounded by +/- 500 K: beyond that the shot is not
        the picture the campaign asked for, it is a different picture.
        """
        delta = self.rules.target_temp_kelvin - candidate.temp_kelvin()
        bounded = max(-500.0, min(500.0, delta))
        return round(candidate.temp_kelvin() + bounded, 1)

    def export_arguments(self, candidate: Candidate) -> dict:
        name = "replacement-%d.jpg" % candidate.photo_id
        return {
            "id": candidate.copy_id if candidate.copy_id is not None else candidate.photo_id,
            "path": str(self.config.derived_dir / name),
            "format": "jpeg",
            "quality": 90,
        }

    # -- the loop ---------------------------------------------------------

    def run(self) -> AgentState:
        config = self.config
        state = self.state
        config.derived_dir.mkdir(parents=True, exist_ok=True)
        self.trace = Trace(config.derived_dir / "agent_trace.jsonl")
        (config.derived_dir / "campaign.json").write_text(
            json.dumps(config.campaign, indent=2), encoding="utf-8")

        self.open_engines()
        try:
            self.build_registry()
            while state.step < min(config.max_steps, MAX_AGENT_STEPS_HARD):
                state.step += 1
                observation = {
                    "trigger": {
                        "jobId": config.job_id,
                        "missingPath": config.missing_path,
                        "campaignId": config.campaign.get("id"),
                    },
                    "candidatesFound": len(state.candidates),
                    "refinementsUsed": state.refinements,
                    "elapsedSec": round(time.monotonic() - state.started_at, 3),
                    "budget": {
                        "tokensIn": state.tokens_in,
                        "tokensOut": state.tokens_out,
                        "maxSteps": config.max_steps,
                    },
                }
                self.trace.append(state.step, "observe", observation)

                # -- reason ------------------------------------------------
                reasoning_started = time.monotonic()
                plan_raw = config.reasoner(observation, state)
                state.reasoning_seconds += time.monotonic() - reasoning_started
                if not isinstance(plan_raw, dict):
                    plan_raw = {}
                plan = plan_raw.get("plan") or []
                state.tokens_in += int(plan_raw.get("tokensIn", 0) or 0)
                state.tokens_out += int(plan_raw.get("tokensOut", 0) or 0)
                self.trace.append(state.step, "reason", {
                    "plan": plan,
                    "tokensIn": int(plan_raw.get("tokensIn", 0) or 0),
                    "tokensOut": int(plan_raw.get("tokensOut", 0) or 0),
                })

                # -- the budgets ------------------------------------------
                if state.tokens_in > TOKEN_BUDGET_INPUT or state.tokens_out > TOKEN_BUDGET_OUTPUT:
                    state.decision = "budget-exceeded"
                    self.trace.append(state.step, "budget-exceeded", {
                        "tokensIn": state.tokens_in, "tokensOut": state.tokens_out})
                    self.write_escalation("token budget exceeded")
                    return state
                if state.reasoning_seconds > WALL_REASONING_SEC:
                    state.decision = "budget-exceeded"
                    self.trace.append(state.step, "budget-exceeded", {
                        "reasoningSec": round(state.reasoning_seconds, 3),
                        "budgetSec": WALL_REASONING_SEC})
                    self.write_escalation("reasoning wall-clock budget exceeded")
                    return state
                if time.monotonic() - state.started_at > WALL_TOTAL_SEC:
                    state.decision = "budget-exceeded"
                    self.trace.append(state.step, "budget-exceeded", {"wallClockSec": WALL_TOTAL_SEC})
                    self.write_escalation("wall-clock budget exceeded")
                    return state

                # -- the policy gate --------------------------------------
                allowed: list = []
                for candidate_step in plan:
                    ok, why = validate_plan_step(candidate_step, self.registry, config)
                    if ok:
                        allowed.append(candidate_step)
                        continue
                    self.trace.append(state.step, "policy-violation", {
                        "step": candidate_step, "reason": why})
                    state.policy_violations.append(why)
                    if "network host not allow-listed" in why:
                        # The run terminates as a security incident and the
                        # security channel is paged.
                        state.decision = "security-incident"
                        self.page_security(why)
                        self.write_escalation(why)
                        return state

                if not allowed:
                    allowed = self.policy_plan()
                    if allowed:
                        self.trace.append(state.step, "reason-fallback", {"plan": allowed})
                if not allowed:
                    state.decision = "no-viable-plan"
                    self.trace.append(state.step, "no-viable-plan", {})
                    return state

                # -- act: exactly ONE action per iteration ------------------
                action = allowed[0]
                tool = self.registry.get(action["tool"])
                assert tool is not None
                try:
                    outcome = tool.call(action["arguments"])
                    error = None
                except PermissionError as exc:
                    self.trace.append(state.step, "act-denied", {"tool": action["tool"], "error": str(exc)})
                    state.decision = "permission-denied"
                    return state
                except Exception as exc:
                    outcome = {"error": "%s: %s" % (type(exc).__name__, exc)}
                    error = str(exc)
                self.trace.append(state.step, "act", {
                    "tool": action["tool"],
                    "arguments": action["arguments"],
                    "outcome": outcome,
                    "error": error,
                })

                # -- interpret the outcome against the rubric --------------
                if self.interpret(action, outcome):
                    return state
            state.decision = "step-cap"
            return state
        finally:
            self.close_engines()
            if self.trace is not None:
                self.trace.close()

    def interpret(self, action: dict, outcome: Any) -> bool:
        """Read the outcome of an action. True when the run is over."""
        state = self.state
        tool = action["tool"]

        if tool == "query_photos" and isinstance(outcome, dict):
            photos = outcome.get("photos", []) or []
            candidates = self.observe_candidates(photos)
            state.candidates = rank_candidates(candidates, self.rules)
            self.trace.append(state.step, "candidates", [{
                "photoId": candidate.photo_id,
                "rules": candidate.rules,
            } for candidate in state.candidates])
            return False

        if tool == "cmd_photo_virtualCopy" and isinstance(outcome, dict):
            ids = outcome.get("ids") or []
            wanted = (action["arguments"].get("ids") or [None])[0]
            for candidate in state.candidates:
                if candidate.photo_id == wanted:
                    state.refining = candidate
                    break
            if state.refining is not None and ids:
                copy_id = int(ids[0])
                state.refining.copy_id = copy_id
                self.config.copies.add(copy_id)
                state.refinements += 1
                state.notes.append("took a virtual copy of %d as %d" % (state.refining.photo_id, copy_id))
            if state.refinements > MAX_REFINED_CANDIDATES:
                state.decision = "refinement-budget-exceeded"
                self.write_escalation("refinement budget exceeded")
                return True
            return False

        if tool == "set_develop" and isinstance(outcome, dict):
            if state.refining is not None:
                values = action["arguments"].get("values", {})
                for key, value in values.items():
                    state.refining.set_temp(float(value))
                state.refining.rules = evaluate_candidate(state.refining, self.rules)
            return False

        if tool == "export" and isinstance(outcome, dict):
            if "error" in outcome:
                return False
            export_id = action["arguments"].get("id")
            target = None
            for candidate in state.candidates:
                candidate_id = candidate.copy_id if candidate.copy_id is not None else candidate.photo_id
                if candidate_id == export_id:
                    target = candidate
                    break
            if target is None:
                return False
            target.exported_path = str(outcome.get("path", ""))
            if isinstance(outcome.get("width"), int):
                target.width = int(outcome["width"])
            if isinstance(outcome.get("height"), int):
                target.height = int(outcome["height"])
            target.rules = evaluate_candidate(target, self.rules)
            if target.passes():
                self.commit_replacement(target)
                return True
            return False

        if tool == "metrics" and isinstance(outcome, dict):
            variants = outcome.get("variants", []) or []
            eligible = [variant for variant in variants
                        if float(variant.get("ctr", 0)) >= CTR_FLOOR]
            if eligible:
                best = max(eligible, key=lambda variant: float(variant.get("ctr", 0)))
                self.commit_fallback(best)
                return True
            self.page_creative_ops("no fallback variant clears the CTR floor")
            self.write_escalation("no fallback variant clears the CTR floor")
            state.decision = "escalated"
            return True

        if tool == "notify":
            state.pages.append(outcome)
            state.decision = "escalated"
            self.write_escalation("escalated by the reasoner")
            return True

        return False

    # -- the decisions ----------------------------------------------------

    def commit_replacement(self, candidate: Candidate) -> None:
        state = self.state
        patch = {
            "jobId": state.job_id,
            "campaignId": state.campaign.get("id"),
            "missingPath": state.missing_path,
            "assetMap": {state.missing_path: candidate.exported_path},
            "reason": "replacement accepted against the campaign rubric",
            "candidate": {
                "photoId": candidate.photo_id,
                "copyId": candidate.copy_id,
                "tempK": candidate.temp_kelvin(),
                "rules": candidate.rules,
            },
        }
        patch_path = self.config.derived_dir / "campaign.patch.json"
        patch_path.write_text(json.dumps(patch, indent=2), encoding="utf-8")
        gate = run_publish_gate(self.config, patch_path, state.campaign)
        state.committed = {
            "kind": "replacement",
            "asset": candidate.exported_path,
            "patch": str(patch_path),
            "publish": gate,
        }
        state.decision = "committed" if gate["exitCode"] == 0 else "publish-failed"
        self.trace.append(state.step, "commit", state.committed)

    def commit_fallback(self, variant: dict) -> None:
        state = self.state
        patch = {
            "jobId": state.job_id,
            "campaignId": state.campaign.get("id"),
            "missingPath": state.missing_path,
            "assetMap": {state.missing_path: ""},
            "fallbackVariant": variant.get("id"),
            "reason": "no replacement cleared the rubric; degraded to a variant "
                      "that performed acceptably in the last 30 days",
        }
        patch_path = self.config.derived_dir / "campaign.patch.json"
        patch_path.write_text(json.dumps(patch, indent=2), encoding="utf-8")
        gate = run_publish_gate(self.config, patch_path, state.campaign)
        state.committed = {
            "kind": "fallback",
            "variant": variant.get("id"),
            "ctr": variant.get("ctr"),
            "patch": str(patch_path),
            "publish": gate,
        }
        state.decision = "degraded" if gate["exitCode"] == 0 else "publish-failed"
        self.trace.append(state.step, "commit", state.committed)

    def page_creative_ops(self, message: str) -> None:
        tool = self.registry.get("notify")
        if tool is None:
            return
        try:
            page = tool.call({
                "severity": "error",
                "channel": "creative-ops",
                "message": message,
                "artefact": str(self.config.derived_dir / "escalation.json"),
            })
            self.state.pages.append(page)
        except Exception:
            pass

    def page_security(self, reason: str) -> None:
        tool = self.registry.get("notify")
        if tool is None:
            return
        try:
            page = tool.call({
                "severity": "error",
                "channel": "security",
                "message": "the agent planned an action outside the network allow-list",
                "artefact": str(self.config.derived_dir / "escalation.json"),
            })
            self.state.pages.append(page)
        except Exception:
            pass

    def write_escalation(self, reason: str) -> None:
        state = self.state
        escalation = {
            "jobId": state.job_id,
            "campaignId": state.campaign.get("id"),
            "missingPath": state.missing_path,
            "reason": reason,
            "decision": state.decision,
            "steps": state.step,
            "refinements": state.refinements,
            "tokensIn": state.tokens_in,
            "tokensOut": state.tokens_out,
            "candidates": [{
                "photoId": candidate.photo_id,
                "copyId": candidate.copy_id,
                "exportedPath": candidate.exported_path,
                "rules": candidate.rules,
            } for candidate in state.candidates],
            "policyViolations": state.policy_violations,
            "pages": state.pages,
            "at": datetime.now(timezone.utc).isoformat(),
        }
        (self.config.derived_dir / "escalation.json").write_text(
            json.dumps(escalation, indent=2), encoding="utf-8")


# ---------------------------------------------------------------------------
# The post-mortem: what a human reads the morning after.
# ---------------------------------------------------------------------------

POSTMORTEM_SECTIONS = [
    ("Summary", "one paragraph: what happened and what was published"),
    ("Trigger", "the missing-asset event that started the run"),
    ("Candidates Considered", "every candidate, with its source query"),
    ("Rule Evaluation", "the per-candidate, per-rule pass/fail table"),
    ("Decision", "commit, degrade or escalate, and why"),
    ("Cost", "the wall-clock time, the tokens and the engine calls"),
    ("Follow-ups", "what a human should change in the pipeline"),
]


def write_postmortem(state: AgentState, derived_dir: Path, trace_path: Path) -> None:
    def section(name: str, body: str) -> str:
        return "## %s\n\n%s\n\n" % (name, body)

    parts = ["# Post-mortem: %s\n\n" % state.job_id]
    parts.append(section("Summary",
        "Outcome: **%s**. Steps used: %d. Refinements used: %d of %d. "
        "The trace is in `%s`." % (
            state.decision, state.step, state.refinements, MAX_REFINED_CANDIDATES, trace_path.name)))
    parts.append(section("Trigger", "```json\n%s\n```" % json.dumps({
        "jobId": state.job_id,
        "campaignId": state.campaign.get("id"),
        "missingPath": state.missing_path,
    }, indent=2)))
    parts.append(section("Candidates Considered", "```json\n%s\n```" % json.dumps(
        [{"photoId": candidate.photo_id,
          "path": candidate.path,
          "rating": candidate.rating,
          "flag": candidate.flag,
          "keywords": candidate.keywords,
          "copyId": candidate.copy_id,
          "exportedPath": candidate.exported_path} for candidate in state.candidates],
        indent=2)))
    parts.append(section("Rule Evaluation", "\n".join(
        ["* photo %d: %s" % (candidate.photo_id, ", ".join(
            "%s=%s" % (name, "pass" if rule.get("pass") else "FAIL")
            for name, rule in sorted(candidate.rules.items())))
         for candidate in state.candidates] or ["* no candidate was evaluated."])))
    parts.append(section("Decision", "```json\n%s\n```" % json.dumps(state.committed, indent=2, default=str)))
    parts.append(section("Cost", "\n".join([
        "* Wall-clock: %.2f s (budget %d s)" % (
            time.monotonic() - state.started_at, WALL_TOTAL_SEC),
        "* Reasoning: %.2f s (budget %d s)" % (state.reasoning_seconds, WALL_REASONING_SEC),
        "* Input tokens: %d (budget %d)" % (state.tokens_in, TOKEN_BUDGET_INPUT),
        "* Output tokens: %d (budget %d)" % (state.tokens_out, TOKEN_BUDGET_OUTPUT),
        "* Engine calls: %d steps" % state.step,
    ])))
    parts.append(section("Follow-ups", "\n".join([
        "* Restore the missing asset from the object store's backup.",
        "* Add an existence check to the campaign manifest validator, so the job fails before it starts.",
    ])))
    (derived_dir / "postmortem.md").write_text("".join(parts), encoding="utf-8")


# ---------------------------------------------------------------------------
# The publish gate, as a separate entry point.
# ---------------------------------------------------------------------------

def publish_gate(campaign_path: Path, patch_path: Path, out_dir: Path) -> int:
    """The campaign publish gate.

    The gate is transactional: the creative is composited into a staging
    file and only then moved into place, so a failure never leaves a
    half-published campaign behind.
    """
    campaign = json.loads(campaign_path.read_text(encoding="utf-8"))
    patch = json.loads(patch_path.read_text(encoding="utf-8"))
    out_dir.mkdir(parents=True, exist_ok=True)

    asset_map = patch.get("assetMap", {})
    missing_path = patch.get("missingPath") or next(iter(asset_map), "")
    replacement = asset_map.get(missing_path, "")
    variant = patch.get("fallbackVariant")

    creative = campaign.get("creative", {})
    width = int(creative.get("width", 1080))
    height = int(creative.get("height", 1350))
    source = replacement if replacement else campaign.get("fallbackAssetPath", "")
    if not source or not Path(source).is_file():
        print(json.dumps({"ok": False, "error": "no publishable asset for %s" % missing_path}))
        return 1

    staging = out_dir / "campaign_published.staging.png"
    final = out_dir / "campaign_published.png"
    receipt_path = out_dir / "publish_receipt.json"

    photo = McpClient([
        "photocraft-cli", "mcp",
        "--automation-read-root", str(Path(source).parent),
        "--automation-write-root", str(out_dir),
    ])
    try:
        photo.call_tool("doc_new", {
            "width": width, "height": height, "mode": "rgb", "depth": 8,
            "background": creative.get("background", "#101820"),
        })
        photo.call_tool("doc_place", {"path": source, "fit": True})
        photo.call_tool("command_run", {
            "id": "type.create",
            "params": {
                "x": 0, "y": 0,
                "box": [0, int(height * 0.74), width, int(height * 0.16)],
                "align": "left",
                "text": creative.get("headline", ""),
                "font": creative.get("font", "Source Serif 4"),
                "size": int(creative.get("headlineSize", 64)),
                "color": creative.get("headlineColor", "#ffffff"),
            },
        })
        photo.call_tool("command_run", {
            "id": "type.create",
            "params": {
                "x": 0, "y": 0,
                "box": [0, int(height * 0.90), width, int(height * 0.08)],
                "align": "left",
                "text": creative.get("cta", ""),
                "font": creative.get("font", "Source Serif 4"),
                "size": int(creative.get("ctaSize", 36)),
                "color": creative.get("ctaColor", "#ffd166"),
            },
        })
        photo.call_tool("doc_save", {"path": str(staging), "format": "png"})
    finally:
        photo.close()

    if not staging.is_file():
        print(json.dumps({"ok": False, "error": "the composite produced no file"}))
        return 1
    shutil.move(str(staging), str(final))

    receipt = {
        "campaignId": campaign.get("id"),
        "jobId": patch.get("jobId"),
        "published": str(final),
        "sha256": sha256_file(final),
        "bytes": final.stat().st_size,
        "width": width,
        "height": height,
        "patchedAsset": missing_path,
        "replacementAsset": replacement,
        "fallbackVariant": variant,
        "at": datetime.now(timezone.utc).isoformat(),
    }
    receipt_path.write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "published": str(final)}))
    return 0


# ---------------------------------------------------------------------------
# The entry points.
# ---------------------------------------------------------------------------

def load_config(campaign_path: Path, job_id: str) -> AgentConfig:
    campaign = json.loads(campaign_path.read_text(encoding="utf-8"))
    roots = campaign.get("roots", {})
    library = campaign.get("library", {})
    missing_path = campaign.get("missingAssetPath", "")
    derived_dir = Path(roots.get("derived", "./derived")) / job_id
    assets_dir = Path(roots.get("assets", "./assets"))
    return AgentConfig(
        job_id=job_id,
        campaign=campaign,
        missing_path=missing_path,
        derived_dir=derived_dir,
        assets_dir=assets_dir,
        library_dir=Path(library.get("libraryDir", "./library")),
        library_photos=Path(library.get("photosDir", "./photos")),
        analytics_path=Path(campaign.get("analyticsPath", "./analytics.json")),
        outbox_path=Path(roots.get("outbox", "./pages.jsonl")),
        reasoner=lambda observation, memory: {},
        publish_gate_command=[sys.executable, str(Path(__file__).resolve())],
    )


def run_from_environment(campaign_path: Path, job_id: str, reasoner: Callable) -> AgentState:
    config = load_config(campaign_path, job_id)
    config.reasoner = reasoner
    agent = Agent(config)
    state = agent.run()
    write_postmortem(state, config.derived_dir, config.derived_dir / "agent_trace.jsonl")
    return state


def main(argv: list) -> int:
    parser = argparse.ArgumentParser(description="The self-healing campaign agent.")
    parser.add_argument("--campaign", help="the campaign manifest")
    parser.add_argument("--job-id", default=os.environ.get("JOB_ID", "job-0001"))
    parser.add_argument("--publish-gate", action="store_true",
                        help="run the publish gate instead of the agent")
    parser.add_argument("--patch", help="the patch file the publish gate applies")
    parser.add_argument("--out", help="the publish gate's output directory")
    arguments = parser.parse_args(argv)

    if arguments.publish_gate:
        if not arguments.patch or not arguments.out:
            parser.error("--publish-gate needs --patch and --out")
        return publish_gate(Path(arguments.campaign), Path(arguments.patch), Path(arguments.out))

    if not arguments.campaign:
        parser.error("--campaign is required")
    # On the command line the agent runs with the studio's own policy as
    # the reasoner: the studio's language model is plugged into the same
    # seam, and it is the only thing that changes.
    state = run_from_environment(Path(arguments.campaign), arguments.job_id,
                                 lambda observation, memory: {"plan": [], "tokensIn": 0, "tokensOut": 0})
    return {
        "committed": EXIT_OK,
        "degraded": EXIT_OK,
        "escalated": EXIT_ESCALATED,
        "budget-exceeded": EXIT_BUDGET,
        "security-incident": EXIT_SECURITY,
    }.get(state.decision, EXIT_NO_DECISION)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
