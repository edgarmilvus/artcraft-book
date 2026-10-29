"""
apex_grade / loop.py
--------------------
Multimodal colour-grading loop for Apex Frame.

The supervisor drives LightCraft over its MCP stdio surface (JSON-RPC
2.0): it performs the `initialize` handshake, calls tools with
`tools/call`, refuses any answer flagged `isError`, and parses the first
`text` content block as JSON.  Every edit goes through a real LightCraft
command id - `develop.controls`, `develop.set`, `develop.adjust`,
`develop.get`, `photo.inspect`, `photo.setMeta`, `catalog.query`,
`library.select` - or through the `render_photo` / `export` MCP tools.
Note that `light.*`, `color.*` and `mixer.*` are *control* ids, not
command ids: they are the sliders `develop.controls` reports and the keys
`develop.set` / `develop.adjust` accept.

Loop contract
-------------
* **Bounded action** - exactly one develop control is nudged per
  iteration (`develop.adjust {control, delta}`).  The delta is clamped to
  the control's own range, which the engine reports in `develop.controls`.
* **Cooling rule** - three consecutive retries on the same control widen
  the neighbourhood to the next control the violated invariant suggests.
* **Idempotency** - a photo that already carries the `NorthwindGraded`
  keyword is skipped, so a run that was killed can be restarted against
  the same library.
* **Byte budget** - the JPEG handed to the vision model never exceeds the
  budget.  `render_photo` has no quality knob, so the trim is done with
  `export`, whose `limitKb` caps the file and whose `quality` is lowered
  until it fits.
* **Audit trail** - one JSON line per iteration, reopened in append mode,
  so a Ctrl-C never truncates it.
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import importlib
import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Dict, List, Optional, Sequence, Set, Tuple

# ────────────────────────────────────────────────────────────────────────
# 1. The contract the vision model has to honour.
# ────────────────────────────────────────────────────────────────────────
VOICE_SCHEMA: Dict[str, Any] = {
    "type": "object",
    "additionalProperties": False,
    "required": ["status"],
    "properties": {
        "status": {"enum": ["ok", "retry"]},
        "violations": {
            "type": "array",
            "items": {"enum": ["skin", "shadows", "contrast", "other"]},
        },
        "fix": {
            "type": "object",
            "additionalProperties": False,
            "required": ["control", "delta"],
            "properties": {
                "control": {"type": "string"},
                "delta": {"type": "number", "minimum": -50, "maximum": 50},
            },
        },
    },
}

VIOLATIONS = ("skin", "shadows", "contrast", "other")

# The reviewer's job, spelled out once so every provider agrees on it.
REVIEW_INSTRUCTION = (
    "You are the senior colourist for a sports-photography agency. Judge the "
    "delivered frame against three invariants: (i) skin tones sit inside a "
    "bounded patch of the a/b plane, (ii) no channel of the shadows is "
    "clipped below 3/255, (iii) the overall contrast is between 0.85 and "
    "1.05 of the reference look. Answer with status 'ok' when the frame "
    "satisfies all three, otherwise status 'retry' plus exactly one fix: "
    "the develop control to nudge and the delta to apply."
)

# ────────────────────────────────────────────────────────────────────────
# 2. The three invariants and the controls that serve them.
#
# These are control ids as reported by `develop.controls` - the engine
# clamps every one of them to its own range, and the loop reads those
# ranges back before it acts.
# ────────────────────────────────────────────────────────────────────────
INVARIANT_CONTROLS: Dict[str, List[str]] = {
    # (i) skin tones inside a bounded patch of the a/b plane.  The orange
    # band of the HSL mixer carries most of the skin; tint and vibrance are
    # the derisking partners.
    "skin": [
        "mixer.orange.sat",
        "mixer.orange.hue",
        "mixer.red.sat",
        "wb.tint",
        "color.vibrance",
    ],
    # (ii) no channel of the shadows clipped below 3/255.  The shadows
    # slider lifts the sub-black range without touching exposure.
    "shadows": ["light.shadows", "light.blacks", "light.exposure"],
    # (iii) overall contrast inside the 0.85..1.05 envelope.  Contrast
    # itself, with whites and highlights as the derisking partners.
    "contrast": ["light.contrast", "light.whites", "light.highlights"],
}

# The initial edit: one value per invariant axis, authored as a single
# `develop.set` call so it lands as one undo step.
INITIAL_EDIT: Dict[str, float] = {
    "light.shadows": 12.0,   # (ii) lift the shadows off the clip point
    "light.contrast": 6.0,    # (iii) nudge the contrast into the envelope
    "mixer.orange.sat": 4.0,  # (i)  keep the skin band from going grey
}

# The keyword that marks a photo as converged.  It lives in the library's
# metadata store, not in a sidecar written behind the engine's back.
GRADED_KEYWORD = "NorthwindGraded"

COOLING_THRESHOLD = 3      # consecutive retries on one control before cooling
MAX_ITERATIONS = 8         # hard ceiling on the iterations of one photo
RENDER_SIZE = 1024         # long edge of the render shipped to the model
MAX_JPEG_BYTES = 250 * 1024  # the byte budget of one shipped JPEG
MIN_JPEG_QUALITY = 30      # never export below this quality


class McpError(RuntimeError):
    """The engine refused a call, or answered with something unusable."""


class SandboxError(RuntimeError):
    """A path that resolves outside the sandboxed apex tree."""


class BudgetError(RuntimeError):
    """A render that could not be brought under the byte budget."""


def utc_now() -> str:
    """An ISO-8601 UTC stamp, second resolution, as the audit trail wants it."""
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())


# ────────────────────────────────────────────────────────────────────────
# 3. A small, honest MCP stdio client.
# ────────────────────────────────────────────────────────────────────────
class McpStdioClient:
    """JSON-RPC 2.0 over the child's stdio.

    The client owns the whole protocol surface: it spawns the engine,
    performs the `initialize` / `notifications/initialized` handshake and
    turns every tool answer into either a parsed JSON payload or the bytes
    of an image block.  A tool answer flagged `isError` is never parsed -
    it is raised.
    """

    def __init__(
        self,
        argv: Sequence[str],
        cwd: Path,
        stderr_log: Optional[Path] = None,
    ) -> None:
        self.argv = [str(a) for a in argv]
        self.cwd = Path(cwd)
        self.stderr_log = Path(stderr_log) if stderr_log else None
        self.server_info: Dict[str, Any] = {}
        self._proc: Optional[subprocess.Popen] = None
        self._stderr_handle: Optional[Any] = None
        self._request_id = 0

    # -- lifecycle ------------------------------------------------------
    def start(self) -> Dict[str, Any]:
        """Spawn the engine and complete the MCP handshake."""
        stderr = None
        if self.stderr_log is not None:
            self.stderr_log.parent.mkdir(parents=True, exist_ok=True)
            stderr = open(str(self.stderr_log), "w", encoding="utf-8")
            self._stderr_handle = stderr
        self._proc = subprocess.Popen(
            self.argv,
            cwd=str(self.cwd),
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=stderr if stderr is not None else subprocess.DEVNULL,
            text=True,
            bufsize=1,
        )
        result = self._request(
            "initialize",
            {
                "protocolVersion": "2024-11-05",
                "capabilities": {},
                "clientInfo": {"name": "apex-grade", "version": "1.0.0"},
            },
        )
        self.server_info = result.get("serverInfo", {}) or {}
        self._notify("notifications/initialized")
        return result

    def close(self) -> None:
        """Close the stream and let the engine go."""
        proc = self._proc
        if proc is None:
            return
        self._proc = None
        for stream in (proc.stdin, proc.stdout):
            try:
                if stream is not None:
                    stream.close()
            except OSError:
                pass
        if proc.poll() is None:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()
                proc.wait(timeout=10)
        if self._stderr_handle is not None:
            try:
                self._stderr_handle.close()
            except OSError:
                pass
            self._stderr_handle = None

    def __enter__(self) -> "McpStdioClient":
        self.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.close()

    # -- transport ------------------------------------------------------
    def _write(self, message: Dict[str, Any]) -> None:
        assert self._proc is not None and self._proc.stdin is not None
        self._proc.stdin.write(json.dumps(message) + "\n")
        self._proc.stdin.flush()

    def _notify(self, method: str, params: Optional[Dict[str, Any]] = None) -> None:
        message: Dict[str, Any] = {"jsonrpc": "2.0", "method": method}
        if params is not None:
            message["params"] = params
        self._write(message)

    def _request(self, method: str, params: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        assert self._proc is not None
        self._request_id += 1
        request_id = self._request_id
        message: Dict[str, Any] = {"jsonrpc": "2.0", "id": request_id, "method": method}
        if params is not None:
            message["params"] = params
        self._write(message)
        while True:
            line = self._proc.stdout.readline() if self._proc.stdout else ""
            if not line:
                raise McpError("the engine closed the MCP stream")
            line = line.strip()
            if not line:
                continue
            try:
                answer = json.loads(line)
            except ValueError:
                continue
            if answer.get("id") != request_id:
                # A server-initiated notification, or a late answer to a
                # request we already gave up on.
                continue
            if "error" in answer:
                raise McpError("%s failed: %s" % (method, answer["error"]))
            return answer.get("result", {}) or {}

    # -- tools ----------------------------------------------------------
    def call(self, tool: str, arguments: Optional[Dict[str, Any]] = None) -> Any:
        """Call a tool and return the JSON payload of its first text block."""
        result = self._request("tools/call", {"name": tool, "arguments": arguments or {}})
        if result.get("isError"):
            raise McpError("%s failed: %s" % (tool, _first_text(result)))
        payload = _first_text(result)
        try:
            return json.loads(payload)
        except ValueError:
            return payload

    def call_image(self, tool: str, arguments: Optional[Dict[str, Any]] = None) -> bytes:
        """Call a tool and return the bytes of its first image block."""
        result = self._request("tools/call", {"name": tool, "arguments": arguments or {}})
        if result.get("isError"):
            raise McpError("%s failed: %s" % (tool, _first_text(result)))
        for block in result.get("content", []) or []:
            if block.get("type") == "image":
                return base64.b64decode(block["data"])
        raise McpError("%s returned no image block" % tool)


def _first_text(result: Dict[str, Any]) -> str:
    """The text of the first `text` content block of a tool answer."""
    for block in result.get("content", []) or []:
        if block.get("type") == "text":
            return block.get("text") or ""
    return ""


# ────────────────────────────────────────────────────────────────────────
# 4. The sandboxed tree.
#
# LightCraft's `mcp` sub-command takes no `--automation-read-root` or
# `--automation-write-root` flag, so the boundary is the supervisor's
# job: every path handed to the engine is resolved against the apex root
# and refused when it escapes.  The engine itself is started with its
# working directory set to that root, so relative paths land inside the
# tree as well.
# ────────────────────────────────────────────────────────────────────────
class ApexRoot:
    """The sandboxed tree, and the guard that keeps the engine inside it."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root).resolve()

    def guard(self, path: Any) -> Path:
        """Resolve `path` inside the tree, or refuse it.

        The resolution is canonical, so a symlink that points out of the
        tree is refused as well.
        """
        candidate = Path(path)
        if not candidate.is_absolute():
            candidate = self.root / candidate
        resolved = candidate.resolve()
        if resolved != self.root and self.root not in resolved.parents:
            raise SandboxError("%s escapes the apex root %s" % (path, self.root))
        return resolved

    def relative(self, path: Any) -> str:
        """`path` as a path relative to the root - the engine's cwd."""
        return str(self.guard(path).relative_to(self.root))

    def contains(self, path: Any) -> bool:
        """Whether `path` stays inside the tree."""
        try:
            self.guard(path)
        except SandboxError:
            return False
        return True


# ────────────────────────────────────────────────────────────────────────
# 5. The engine facade: LightCraft's real command ids, nothing else.
# ────────────────────────────────────────────────────────────────────────
class LightCraft:
    """A typed facade over LightCraft's MCP tools and command ids."""

    def __init__(self, client: McpStdioClient, root: ApexRoot) -> None:
        self.client = client
        self.root = root

    # -- library --------------------------------------------------------
    def import_paths(self, paths: Sequence[Any]) -> Dict[str, Any]:
        """Import files or folders; the paths are guarded first."""
        guarded = [self.root.relative(p) for p in paths]
        return self.client.call("import", {"paths": guarded})

    def photos(self) -> List[Dict[str, Any]]:
        """Every photo of the current view."""
        return self.client.call("query_photos", {})["photos"]

    def photos_with_keyword(self, keyword: str) -> List[Dict[str, Any]]:
        """The photos that already carry `keyword`."""
        return self.client.call("query_photos", {"filter": {"keyword": keyword}})["photos"]

    def keywords(self) -> List[Dict[str, Any]]:
        """The keyword tree, with the number of photos behind every entry."""
        return self.client.call("command_run", {"id": "keyword.list", "params": {}})

    def journal(self, limit: int = 500) -> List[Dict[str, Any]]:
        """The engine's own command journal - the audit trail's twin."""
        return self.client.call("command_run", {"id": "journal.list", "params": {"limit": limit}})

    def library_state(self) -> Dict[str, Any]:
        """The library as the engine sees it."""
        return self.client.call("doc_inspect", {})

    def command_ids(self) -> List[str]:
        """Every command id the engine knows."""
        listing = self.client.call("command_list", {})
        return [entry["id"] for entry in listing]

    # -- develop --------------------------------------------------------
    def control_state(self, photo_id: int) -> Dict[str, Dict[str, Any]]:
        """The develop controls of one photo, with the engine's own ranges.

        `develop.controls` reports the *active* photo, so the photo is
        selected first; the two calls travel in one batch, which keeps
        them atomic.
        """
        result = self.client.call(
            "command_batch",
            {
                "steps": [
                    {"id": "library.select", "params": {"ids": [photo_id], "active": photo_id}},
                    {"id": "develop.controls", "params": {}},
                ]
            },
        )
        controls = result.get("results", [{}, {}])[1]
        if not controls.get("ok"):
            raise McpError("develop.controls failed: %s" % controls.get("error"))
        return {entry["id"]: entry for entry in controls["result"]}

    def develop(self, photo_id: int) -> Dict[str, Any]:
        """The full develop settings of one photo."""
        return self.client.call(
            "command_run", {"id": "develop.get", "params": {"id": photo_id}}
        )

    def set_values(self, photo_id: int, values: Dict[str, float]) -> Dict[str, Any]:
        """Author the initial edit - one `develop.set` call, one undo step."""
        return self.client.call(
            "command_run",
            {"id": "develop.set", "params": {"ids": [photo_id], "values": dict(values)}},
        )

    def adjust(self, photo_id: int, control: str, delta: float) -> Dict[str, Any]:
        """Nudge one control by one delta - the bounded action."""
        return self.client.call(
            "command_batch",
            {
                "steps": [
                    {"id": "library.select", "params": {"ids": [photo_id], "active": photo_id}},
                    {"id": "develop.adjust", "params": {"control": control, "delta": delta}},
                ]
            },
        )

    # -- metadata -------------------------------------------------------
    def inspect(self, photo_id: int) -> Dict[str, Any]:
        """The catalog record of one photo, metadata included."""
        return self.client.call(
            "command_run", {"id": "photo.inspect", "params": {"id": photo_id}}
        )

    def keywords_of(self, photo_id: int) -> List[str]:
        """The keywords the library holds for one photo."""
        return list(self.inspect(photo_id).get("meta", {}).get("keywords", []) or [])

    def add_keyword(self, photo_id: int, keyword: str) -> Dict[str, Any]:
        """Tag a photo through the library's own metadata store."""
        return self.client.call(
            "command_run",
            {
                "id": "photo.setMeta",
                "params": {"ids": [photo_id], "addKeywords": [keyword]},
            },
        )

    # -- render ---------------------------------------------------------
    def render_jpeg(
        self,
        photo_id: int,
        size: int = RENDER_SIZE,
        max_bytes: int = MAX_JPEG_BYTES,
        trim_path: Optional[Path] = None,
    ) -> bytes:
        """Render one photo as a JPEG that fits the model's byte budget.

        `render_photo` is the engine's preview path and has no quality
        knob, so the trim is done with `export`: its `limitKb` caps the
        file and its `quality` is lowered until the result fits.
        """
        jpeg = self.client.call_image(
            "render_photo", {"id": photo_id, "size": size, "format": "jpeg"}
        )
        if len(jpeg) <= max_bytes:
            return jpeg
        if trim_path is None:
            raise BudgetError(
                "the render of photo %d is %d bytes and there is nowhere to trim it"
                % (photo_id, len(jpeg))
            )
        quality = 92
        while quality >= MIN_JPEG_QUALITY:
            self.client.call(
                "export",
                {
                    "path": self.root.relative(trim_path),
                    "id": photo_id,
                    "format": "jpeg",
                    "longEdge": size,
                    "quality": quality,
                    "limitKb": max(1, max_bytes // 1024),
                },
            )
            trimmed = Path(trim_path).read_bytes()
            if len(trimmed) <= max_bytes:
                return trimmed
            quality -= 10
        raise BudgetError(
            "the render of photo %d could not be brought under %d bytes"
            % (photo_id, max_bytes)
        )


# ────────────────────────────────────────────────────────────────────────
# 6. The append-only audit trail.
# ────────────────────────────────────────────────────────────────────────
AUDIT_KEYS = (
    "photoId",
    "iteration",
    "control",
    "delta",
    "preRenderMd5",
    "llmStatus",
    "timestamp",
)


class AuditTrail:
    """One JSON line per iteration, appended in `"a"` mode.

    A run that is killed with Ctrl-C leaves every line it had already
    written in place; the next run appends to the same file.
    """

    def __init__(self, path: Path) -> None:
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def append(self, entry: Dict[str, Any]) -> Dict[str, Any]:
        """Write one line and flush it to the disk."""
        line = {key: entry[key] for key in AUDIT_KEYS}
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(line, sort_keys=True) + "\n")
            handle.flush()
            os.fsync(handle.fileno())
        return line

    def entries(self) -> List[Dict[str, Any]]:
        """Every line of the trail, in the order it was written."""
        if not self.path.exists():
            return []
        with self.path.open("r", encoding="utf-8") as handle:
            return [json.loads(line) for line in handle if line.strip()]


# ────────────────────────────────────────────────────────────────────────
# 7. The verdict check.  The schema above is the contract; this is the
#    gate that keeps a chatty model from widening it.
# ────────────────────────────────────────────────────────────────────────
def validate_verdict(verdict: Any) -> Dict[str, Any]:
    """Check a verdict against `VOICE_SCHEMA`; raise on anything extra."""
    if not isinstance(verdict, dict):
        raise McpError("the verdict is not an object")
    unknown = set(verdict) - set(VOICE_SCHEMA["properties"])
    if unknown:
        raise McpError("the verdict carries unknown keys: %s" % sorted(unknown))
    status = verdict.get("status")
    if status not in ("ok", "retry"):
        raise McpError("the verdict has no usable status: %r" % status)
    violations = verdict.get("violations", [])
    if not isinstance(violations, list):
        raise McpError("violations is not an array")
    for violation in violations:
        if violation not in VIOLATIONS:
            raise McpError("unknown violation: %r" % violation)
    fix = verdict.get("fix")
    if fix is not None:
        if not isinstance(fix, dict):
            raise McpError("fix is not an object")
        if set(fix) - {"control", "delta"}:
            raise McpError("the fix carries unknown keys: %s" % sorted(set(fix)))
        if not isinstance(fix.get("control"), str):
            raise McpError("the fix names no control")
        delta = fix.get("delta")
        if not isinstance(delta, (int, float)) or isinstance(delta, bool):
            raise McpError("the fix carries no numeric delta")
        if not -50.0 <= float(delta) <= 50.0:
            raise McpError("the delta %r is outside the -50..50 envelope" % delta)
    if status == "retry" and fix is None:
        raise McpError("a retry must name the control it wants to move")
    return verdict


# ────────────────────────────────────────────────────────────────────────
# 8. The loop itself.
# ────────────────────────────────────────────────────────────────────────
@dataclass
class LoopConfig:
    """Everything the supervisor may vary from run to run."""

    max_iterations: int = MAX_ITERATIONS
    render_size: int = RENDER_SIZE
    max_jpeg_bytes: int = MAX_JPEG_BYTES
    graded_keyword: str = GRADED_KEYWORD
    cooling_threshold: int = COOLING_THRESHOLD
    initial_edit: Dict[str, float] = field(default_factory=lambda: dict(INITIAL_EDIT))


@dataclass
class GradeResult:
    """What one photo's pass through the loop produced."""

    photo_id: int
    status: str                       # "converged" | "timed_out" | "skipped"
    iterations: int = 0
    controls: List[str] = field(default_factory=list)
    statuses: List[str] = field(default_factory=list)
    reason: str = ""

    def as_dict(self) -> Dict[str, Any]:
        return {
            "photoId": self.photo_id,
            "status": self.status,
            "iterations": self.iterations,
            "controls": list(self.controls),
            "verdicts": list(self.statuses),
            "reason": self.reason,
        }


# The reviewer is injected: the pipeline only ever sees a verdict.
Reviewer = Callable[[bytes, Dict[str, Any]], Dict[str, Any]]


def choose_control(
    proposed: Optional[str],
    violation: str,
    last_control: Optional[str],
    repeats: int,
    applied: Set[str],
    state: Dict[str, Dict[str, Any]],
    cooling_threshold: int = COOLING_THRESHOLD,
) -> Tuple[Optional[str], int]:
    """The control this iteration may act on, and the new repeat counter.

    The model's proposal wins as long as it keeps changing the control.
    After `cooling_threshold` consecutive retries on the *same* control the
    loop stops hammering it and widens the neighbourhood to the next
    control the violated invariant suggests.  `None` means the loop has
    nothing left to try and the photo has to be handed back.
    """
    candidates = [
        control
        for control in INVARIANT_CONTROLS.get(violation, [])
        if control not in applied and control in state
    ]
    if proposed and proposed != last_control:
        return proposed, 1
    if proposed:
        repeats += 1
        if repeats < cooling_threshold:
            return proposed, repeats
        if candidates:
            return candidates[0], 1
        return proposed, repeats
    if candidates:
        return candidates[0], 1
    return None, repeats


def grade_photo(
    engine: LightCraft,
    photo_id: int,
    reviewer: Reviewer,
    audit: AuditTrail,
    config: LoopConfig,
    render_dir: Path,
) -> GradeResult:
    """Grade one photo and return what happened.

    The loop is idempotent: a photo that already carries the graded
    keyword is left alone, so a restarted run does not spend its budget
    on work that is already done.
    """
    if config.graded_keyword in engine.keywords_of(photo_id):
        return GradeResult(photo_id, "skipped", reason="already tagged")

    # The initial edit: one `develop.set` call, one value per invariant
    # axis, so the whole opening move is a single undo step.
    engine.set_values(photo_id, config.initial_edit)

    applied: Set[str] = set()
    controls: List[str] = []
    statuses: List[str] = []
    last_control: Optional[str] = None
    repeats = 0
    iteration = 0

    for iteration in range(1, config.max_iterations + 1):
        trim_path = render_dir / ("photo-%d-%02d.jpg" % (photo_id, iteration))
        jpeg = engine.render_jpeg(
            photo_id,
            size=config.render_size,
            max_bytes=config.max_jpeg_bytes,
            trim_path=trim_path,
        )
        digest = hashlib.md5(jpeg).hexdigest()

        request = {
            "photoId": photo_id,
            "iteration": iteration,
            "schema": VOICE_SCHEMA,
            "instruction": REVIEW_INSTRUCTION,
        }
        verdict = validate_verdict(reviewer(jpeg, request))
        status = str(verdict["status"])
        statuses.append(status)

        if status == "ok":
            audit.append(
                {
                    "photoId": photo_id,
                    "iteration": iteration,
                    "control": last_control or "",
                    "delta": 0,
                    "preRenderMd5": digest,
                    "llmStatus": status,
                    "timestamp": utc_now(),
                }
            )
            # The tag is the only thing that marks a photo as delivered.
            engine.add_keyword(photo_id, config.graded_keyword)
            return GradeResult(
                photo_id, "converged", iteration, controls, statuses
            )

        fix = verdict.get("fix") or {}
        violation = (verdict.get("violations") or ["other"])[0]
        proposed = fix.get("control")
        delta = float(fix.get("delta", 0.0))

        state = engine.control_state(photo_id)
        control, repeats = choose_control(
            proposed,
            violation,
            last_control,
            repeats,
            applied,
            state,
            config.cooling_threshold,
        )
        if control is None:
            audit.append(
                {
                    "photoId": photo_id,
                    "iteration": iteration,
                    "control": last_control or "",
                    "delta": 0,
                    "preRenderMd5": digest,
                    "llmStatus": status,
                    "timestamp": utc_now(),
                }
            )
            return GradeResult(
                photo_id,
                "timed_out",
                iteration,
                controls,
                statuses,
                reason="no control left to move",
            )

        # Clamp the delta to the control's own range, as the engine
        # reports it.  The audit line then records the delta that was
        # really applied, not the one that was asked for.
        spec = state[control]
        current = float(spec.get("value", 0.0))
        low = float(spec.get("min", -100.0))
        high = float(spec.get("max", 100.0))
        target = min(max(current + delta, low), high)
        applied_delta = round(target - current, 6)
        if applied_delta == 0.0:
            # The control is pinned at a bound: try the next candidate of
            # this invariant before giving the iteration up.
            control = None
            for candidate in INVARIANT_CONTROLS.get(violation, []):
                if candidate in applied or candidate not in state:
                    continue
                candidate_spec = state[candidate]
                candidate_current = float(candidate_spec.get("value", 0.0))
                candidate_low = float(candidate_spec.get("min", -100.0))
                candidate_high = float(candidate_spec.get("max", 100.0))
                candidate_target = min(
                    max(candidate_current + delta, candidate_low), candidate_high
                )
                candidate_delta = round(candidate_target - candidate_current, 6)
                if candidate_delta != 0.0:
                    control = candidate
                    applied_delta = candidate_delta
                    break
            if control is None:
                audit.append(
                    {
                        "photoId": photo_id,
                        "iteration": iteration,
                        "control": last_control or "",
                        "delta": 0,
                        "preRenderMd5": digest,
                        "llmStatus": status,
                        "timestamp": utc_now(),
                    }
                )
                return GradeResult(
                    photo_id,
                    "timed_out",
                    iteration,
                    controls,
                    statuses,
                    reason="every candidate control is at its bound",
                )

        audit.append(
            {
                "photoId": photo_id,
                "iteration": iteration,
                "control": control,
                "delta": applied_delta,
                "preRenderMd5": digest,
                "llmStatus": status,
                "timestamp": utc_now(),
            }
        )
        engine.adjust(photo_id, control, applied_delta)
        applied.add(control)
        controls.append(control)
        last_control = control

    return GradeResult(
        photo_id,
        "timed_out",
        iteration,
        controls,
        statuses,
        reason="the iteration budget ran out",
    )


def grade_library(
    engine: LightCraft,
    reviewer: Reviewer,
    config: LoopConfig,
    audit: AuditTrail,
    render_dir: Path,
    photo_ids: Optional[Sequence[int]] = None,
) -> Dict[str, Any]:
    """Grade the whole library and return the run summary.

    The summary names the photos that converged, the photos that timed
    out and the photos that were skipped because a previous run had
    already delivered them.  A photo that times out is never tagged.
    """
    if photo_ids is None:
        photo_ids = [photo["id"] for photo in engine.photos()]
    started = utc_now()
    results: List[GradeResult] = []
    for photo_id in photo_ids:
        results.append(
            grade_photo(engine, photo_id, reviewer, audit, config, render_dir)
        )

    summary: Dict[str, Any] = {
        "startedAt": started,
        "finishedAt": utc_now(),
        "converged": [r.photo_id for r in results if r.status == "converged"],
        "timedOut": [r.photo_id for r in results if r.status == "timed_out"],
        "skipped": [r.photo_id for r in results if r.status == "skipped"],
        "iterations": {str(r.photo_id): r.iterations for r in results},
        "controls": {str(r.photo_id): r.controls for r in results},
        "results": [r.as_dict() for r in results],
        "auditTrail": str(audit.path),
    }
    return summary


# ────────────────────────────────────────────────────────────────────────
# 9. The supervisor: start the engine, hand it the reviewer, report.
# ────────────────────────────────────────────────────────────────────────
def load_reviewer(spec: str) -> Reviewer:
    """Load the injected reviewer from a `module:function` specifier.

    The supervisor never calls a model itself: the reviewer is injected,
    so the same loop runs against a hosted vision model, a local one, or
    a scripted stand-in.
    """
    module_name, _, attribute = spec.partition(":")
    if not module_name or not attribute:
        raise SystemExit("--reviewer wants a module:function specifier")
    module = importlib.import_module(module_name)
    factory = getattr(module, attribute, None)
    if factory is None:
        raise SystemExit("%s has no %s" % (module_name, attribute))
    return factory()


def write_summary(summary: Dict[str, Any], path: Path) -> Path:
    """Write the run summary next to the library."""
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(summary, indent=2) + "\n", encoding="utf-8")
    return path


def run(
    root: Path,
    reviewer: Reviewer,
    binary: str = "lightcraft-cli",
    imports: Sequence[Path] = (),
    config: Optional[LoopConfig] = None,
    photo_ids: Optional[Sequence[int]] = None,
) -> Dict[str, Any]:
    """Run one pass of the grading loop over a library.

    The engine is started with its working directory set to the apex
    root, so every relative path it resolves stays inside the tree.
    """
    config = config or LoopConfig()
    root = Path(root).resolve()
    root.mkdir(parents=True, exist_ok=True)
    library = root / "library"
    library.mkdir(parents=True, exist_ok=True)
    render_dir = root / "renders"
    render_dir.mkdir(parents=True, exist_ok=True)

    audit = AuditTrail(library / "apex" / "grade-audit.jsonl")
    client = McpStdioClient(
        [binary, "mcp", "--library", str(library)],
        cwd=root,
        stderr_log=root / "lightcraft-mcp.log",
    )
    with client:
        engine = LightCraft(client, ApexRoot(root))
        if imports:
            engine.import_paths(list(imports))
        summary = grade_library(
            engine, reviewer, config, audit, render_dir, photo_ids=photo_ids
        )

    summary["library"] = str(library)
    summary_path = write_summary(summary, root / "grade-summary.json")
    summary["summaryPath"] = str(summary_path)
    return summary


def main(argv: Optional[Sequence[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        prog="apex-grade",
        description="Multimodal colour-grading loop for Apex Frame.",
    )
    parser.add_argument(
        "--root",
        default="apex",
        help="the sandboxed tree; the library and the audit trail live in it",
    )
    parser.add_argument(
        "--binary", default="lightcraft-cli", help="the LightCraft executable"
    )
    parser.add_argument(
        "--import",
        dest="imports",
        action="append",
        default=[],
        help="a file or folder to import; may be repeated",
    )
    parser.add_argument(
        "--reviewer",
        required=True,
        help="module:function returning the vision reviewer to inject",
    )
    parser.add_argument(
        "--max-iterations", type=int, default=MAX_ITERATIONS,
        help="the iteration ceiling of one photo",
    )
    parser.add_argument(
        "--max-jpeg-kb", type=int, default=MAX_JPEG_BYTES // 1024,
        help="the byte budget of the JPEG shipped to the vision model",
    )
    args = parser.parse_args(argv)

    reviewer = load_reviewer(args.reviewer)
    config = LoopConfig(
        max_iterations=args.max_iterations,
        max_jpeg_bytes=args.max_jpeg_kb * 1024,
    )
    summary = run(
        Path(args.root),
        reviewer,
        binary=args.binary,
        imports=[Path(p) for p in args.imports],
        config=config,
    )
    print(json.dumps(summary, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
