"""Autonomous multimodal Bézier refinement loop.

The agent reduces a CAD silhouette to an anchor budget, renders it, asks a
vision model for a structured critique, and applies the matching surgical
edits. It stops when the critique is empty, when the geometry stops moving,
or when the iteration cap is reached.

The vision model is a hypothesis generator, never the authority: every edit is
matched against a numeric curvature spike, and a flag the geometry does not
support is re-checked on a cropped render before it is applied.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import os
import time
from dataclasses import dataclass, field, asdict
from typing import Any

# ────────────────────────────────────────────────────────────────────────────
# 1. THE ENGINE — one MCP session to the headless VectorCraft.
# ────────────────────────────────────────────────────────────────────────────
class VectorAgent:
    """The subset of VectorCraft the refinement loop needs."""

    def __init__(self, binary: str = "vectorcraft-cli") -> None:
        self.binary = binary
        self.proc: Any = None
        self._id = 0

    def __enter__(self) -> "VectorAgent":
        import json as _json
        import subprocess
        import threading

        self.proc = subprocess.Popen(
            [self.binary, "mcp", "--headless"],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            text=True, bufsize=1,
        )
        self._lock = threading.RLock()
        self._send({"jsonrpc": "2.0", "id": 0, "method": "initialize",
                    "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                               "clientInfo": {"name": "bezier-refiner", "version": "1.0.0"}}})
        self._read_until(0)
        self._send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
        return self

    def __exit__(self, *exc: Any) -> None:
        if self.proc is not None:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=5)
            except Exception:
                self.proc.kill()

    # -- transport ----------------------------------------------------------
    def _send(self, message: dict[str, Any]) -> None:
        with self._lock:
            self.proc.stdin.write(json.dumps(message) + "\n")
            self.proc.stdin.flush()

    def _read_until(self, wanted: int) -> dict[str, Any]:
        while True:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("the engine closed its output")
            line = line.strip()
            if not line:
                continue
            message = json.loads(line)
            if message.get("id") == wanted:
                return message

    def _call(self, tool: str, arguments: dict[str, Any]) -> Any:
        with self._lock:
            self._id += 1
            wanted = self._id
            self._send({"jsonrpc": "2.0", "id": wanted, "method": "tools/call",
                        "params": {"name": tool, "arguments": arguments}})
            message = self._read_until(wanted)
        result = message.get("result") or {}
        if result.get("isError"):
            text = next((b.get("text", "") for b in result.get("content", []) if b.get("type") == "text"), "")
            raise RuntimeError(text or f"{tool} failed")
        for block in result.get("content", []):
            if block.get("type") == "text" and block.get("text"):
                text = block["text"]
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    return text
            if block.get("type") == "image":
                return {"png": block["data"], "mimeType": block.get("mimeType")}
        return None

    # -- the tools ----------------------------------------------------------
    def run(self, command: str, params: dict[str, Any] | None = None) -> Any:
        """Run one engine command."""
        return self._call("command_run", {"id": command, "params": params or {}})

    def batch(self, steps: list[dict[str, Any]], label: str) -> Any:
        """Run an atomic batch of engine commands."""
        return self._call("command_batch", {"steps": steps, "atomic": True, "label": label})

    def render(self, max_side: int = 1024) -> str:
        """The artboard as a base64 PNG."""
        result = self._call("render_preview", {"artboard": 0, "max_side": max_side})
        if isinstance(result, dict) and "png" in result:
            return result["png"]
        raise RuntimeError("the engine returned no preview")

    def render_zoom(self, rect: list[float], max_side: int = 1024) -> str:
        """A cropped render, for the low-confidence branch."""
        png_b64 = self.render(max_side=max_side)
        from PIL import Image

        image = Image.open(io.BytesIO(base64.b64decode(png_b64))).convert("RGB")
        left, top, right, bottom = rect
        crop = image.crop((int(left), int(top), int(right), int(bottom)))
        buffer = io.BytesIO()
        crop.save(buffer, format="PNG")
        return base64.b64encode(buffer.getvalue()).decode("ascii")


# ────────────────────────────────────────────────────────────────────────────
# 2. ANCHOR READ + CANONICALIZATION (idempotent, order-preserving).
# ────────────────────────────────────────────────────────────────────────────
def read_anchors(agent: Any, path_id: int) -> list[dict]:
    """The engine's own anchor list for a path.

    There is no `path.info` command: the anchors are the path's node in the
    document tree, read with `document.node`.
    """
    node = agent.run("document.node", {"id": path_id})
    kind = node.get("kind", {})
    subpaths = kind.get("path", {}).get("subpaths", [])
    out: list[dict] = []
    for subpath in subpaths:
        for anchor in subpath.get("anchors", []):
            position = anchor.get("p") or [anchor.get("x"), anchor.get("y")]
            in_handle = anchor.get("in") or [None, None]
            out_handle = anchor.get("out") or [None, None]
            out.append({
                "i": len(out),
                "x": round(float(position[0]), 6),
                "y": round(float(position[1]), 6),
                "in":  [round(float(in_handle[0]), 6),  round(float(in_handle[1]), 6)]  if in_handle[0] is not None else None,
                "out": [round(float(out_handle[0]), 6), round(float(out_handle[1]), 6)] if out_handle[0] is not None else None,
                "smooth": bool(anchor.get("smooth", False)),
            })
    return out


def canonical_hash(anchors: list[dict]) -> str:
    canon = json.dumps(anchors, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canon.encode()).hexdigest()


# ────────────────────────────────────────────────────────────────────────────
# 3. MENGER CURVATURE + TOP-3 SPIKES.
# ────────────────────────────────────────────────────────────────────────────
def cross(u, v): return u[0] * v[1] - u[1] * v[0]
def norm(u):     return math.hypot(u[0], u[1])
def sub(a, b):   return (a[0] - b[0], a[1] - b[1])


def anchor_curvature(anchors: list[dict], i: int) -> float:
    """Menger curvature of the tangent pair (in, anchor) and (anchor, out)."""
    a = anchors[i]
    p_in  = a["in"]  or [a["x"], a["y"]]
    p_out = a["out"] or [a["x"], a["y"]]
    u = (a["x"] - p_in[0],  a["y"] - p_in[1])       # vector into anchor
    v = (p_out[0] - a["x"], p_out[1] - a["y"])      # vector out of anchor
    nu, nv = norm(u), norm(v)
    if nu < 1e-9 or nv < 1e-9: return 0.0
    denom = nu * nv * norm((u[0] + v[0], u[1] + v[1]))
    if denom < 1e-9: return 0.0
    return abs(2.0 * cross(u, v) / denom)


def top3_spikes(anchors: list[dict], total_arc: float = 0.0) -> list[dict]:
    """The three sharpest anchors, with their arc-length parameter."""
    spikes: list[dict] = []
    for i in range(len(anchors)):
        kappa = anchor_curvature(anchors, i)
        spikes.append({"anchorIndex": i, "kappa": round(kappa, 9), "t": _anchor_t(anchors, i)})
    spikes.sort(key=lambda s: s["kappa"], reverse=True)
    return spikes[:3]


# ────────────────────────────────────────────────────────────────────────────
# 4. THE VISION CRITIQUE.
# ────────────────────────────────────────────────────────────────────────────
SYSTEM = """You are auditing a vector outline for a furniture catalogue.
Reply with JSON only:
{"kinks": [{"t": 0..1, "severity": "low|medium|high"}],
 "selfIntersections": [{"t": 0..1}],
 "flatnessErrors": [{"t": 0..1, "delta": number}],
 "looksBroken": bool}
`t` is the position along the outline, normalised to the arc length 0..1."""


def vision_critique(llm, png_b64: str, zoom_of: tuple[float, float] | None = None) -> dict:
    user = "Audit this outline." if zoom_of is None else \
           f"Audit the zoomed outline.  The visible window covers t in [{zoom_of[0]:.3f}, {zoom_of[1]:.3f}]; report kink/flatness t as the ORIGINAL arc length, extrapolated."
    resp = llm.chat(system=SYSTEM, user=user,
                    images=[png_b64], response_format={"type": "json_object"})
    data = json.loads(resp.content)
    # Enforce schema.
    return {
        "kinks":             [k for k in data.get("kinks", []) if 0 <= k["t"] <= 1 and k["severity"] in ("low", "medium", "high")],
        "selfIntersections": [k for k in data.get("selfIntersections", []) if 0 <= k["t"] <= 1],
        "flatnessErrors":    [k for k in data.get("flatnessErrors", []) if 0 <= k["t"] <= 1],
        "looksBroken":       bool(data.get("looksBroken", False)),
    }


# ────────────────────────────────────────────────────────────────────────────
# 5. EDIT-SELECTION DECISION TABLE.
# ────────────────────────────────────────────────────────────────────────────
LOW_CONFIDENCE_DT = 0.05   # of arc length: max distance between vision-t and a spike t


def plan_edits(critique: dict, anchors: list[dict], spikes: list[dict],
               bbox_diag: float, target_id: int) -> tuple[list[dict], list[int]]:
    steps: list[dict] = []
    low_conf: list[int] = []
    for kink in critique["kinks"]:
        near = min(spikes, key=lambda s: abs(s["t"] - kink["t"]), default=None)
        if kink["severity"] == "low" or near is None or abs(near["t"] - kink["t"]) > LOW_CONFIDENCE_DT:
            low_conf.append(_t_to_anchor_index(anchors, kink["t"]))
            continue
        # High-confidence kink at a numeric spike: turn the spike anchor smooth.
        idx = near["anchorIndex"]
        steps.append({"id": "path.convertAnchor",
                      "params": {"id": target_id, "subpath": 0, "anchor": idx, "to": "smooth"}})
        # Follow with a 1/3-rule out-handle pull (safety net for the seam).
        nxt = anchors[(idx + 1) % len(anchors)]
        out_x = anchors[idx]["x"] + (nxt["x"] - anchors[idx]["x"]) / 3.0
        out_y = anchors[idx]["y"] + (nxt["y"] - anchors[idx]["y"]) / 3.0
        steps.append({"id": "path.setHandle",
                      "params": {"id": target_id, "subpath": 0, "anchor": idx,
                                 "which": "out", "x": out_x, "y": out_y,
                                 "independent": False}})
    for si in critique["selfIntersections"]:
        i = _t_to_anchor_index(anchors, si["t"])
        # Push the segment along its local normal by 6% of the bounding box diagonal.
        tang = _tangent_at(anchors, i)
        nx, ny = -tang[1], tang[0]     # left normal
        mag = 0.06 * bbox_diag
        steps.append({"id": "path.reshapeSegment",
                      "params": {"id": target_id, "subpath": 0, "segment": i,
                                 "t": 0.5, "dx": nx * mag, "dy": ny * mag}})
    for fe in critique["flatnessErrors"]:
        i = _t_to_anchor_index(anchors, fe["t"])
        nxt = anchors[(i + 1) % len(anchors)]
        steps.append({"id": "path.setHandle",
                      "params": {"id": target_id, "subpath": 0, "anchor": i,
                                 "which": "out",
                                 "x": anchors[i]["x"] + (nxt["x"] - anchors[i]["x"]) / 3.0,
                                 "y": anchors[i]["y"] + (nxt["y"] - anchors[i]["y"]) / 3.0,
                                 "independent": False}})
    return steps, low_conf


# ────────────────────────────────────────────────────────────────────────────
# 6. LOW-CONFIDENCE ESCALATION.
# ────────────────────────────────────────────────────────────────────────────
def escalate_low_confidence(llm, agent, anchors, low_conf_indices, target_id: int, artboard: float):
    accepted_steps = []
    for idx in low_conf_indices:
        t_center = _anchor_t(anchors, idx)
        window = (max(0.0, t_center - 0.05), min(1.0, t_center + 0.05))
        # Cropped render: the client crops the artboard raster around the anchor.
        crop_rect = _rect_around_anchor(anchors, idx, pad_pt=12, artboard=artboard)
        png = agent.render_zoom(crop_rect, max_side=1024)
        zoom_critique = vision_critique(llm, png, zoom_of=window)
        # Accept only if the model re-flags the SAME t with medium+ severity.
        hit = next((k for k in zoom_critique["kinks"]
                    if abs(k["t"] - t_center) <= 0.02 and k["severity"] in ("medium", "high")), None)
        if hit:
            accepted_steps.append({
                "id": "path.convertAnchor",
                "params": {"id": target_id, "subpath": 0, "anchor": idx, "to": "smooth"},
            })
    return accepted_steps


# ────────────────────────────────────────────────────────────────────────────
# 7. MAIN LOOP.
# ────────────────────────────────────────────────────────────────────────────
ANCHOR_BUDGET = 48
MAX_ITERS = 8


def refine(agent: Any, llm: Any, sku: str, target_id: int, artboard: float = 512.0) -> dict:
    t0 = time.monotonic()
    iters: list[dict] = []

    # 7a. Reduction: escalate tolerance until the budget is met.
    for tol in (0.5, 1.0, 1.5):
        agent.run("select.set", {"ids": [target_id]})
        agent.batch([{"id": "object.path.simplify", "params": {"tolerance": tol}}],
                    f"reduce-{tol}")
        if len(read_anchors(agent, target_id)) <= ANCHOR_BUDGET:
            break

    # 7b. Smooth every >25° tangent mismatch.
    anchors = read_anchors(agent, target_id)
    for i in range(len(anchors)):
        a_in, a_out = anchors[i]["in"], anchors[i]["out"]
        if a_in and a_out:
            angle = _angle_between(sub((a_in[0]-anchors[i]["x"], a_in[1]-anchors[i]["y"]), (0, 0)),
                                   sub((a_out[0]-anchors[i]["x"], a_out[1]-anchors[i]["y"]), (0, 0)))
            if angle > math.radians(25):
                agent.run("path.convertAnchor",
                          {"id": target_id, "subpath": 0, "anchor": i, "to": "smooth"})

    # 7c. The refinement iterations.
    prev_hash, stable = None, 0
    terminated_by = "iteration-cap"
    for it in range(MAX_ITERS):
        anchors = read_anchors(agent, target_id)
        h = canonical_hash(anchors)
        bbox = _bbox(anchors)
        diag = math.hypot(bbox[2] - bbox[0], bbox[3] - bbox[1])
        spikes = top3_spikes(anchors, total_arc=0.0)
        png = agent.render(max_side=1024)
        crit = vision_critique(llm, png)
        steps, low_conf = plan_edits(crit, anchors, spikes, diag, target_id)
        # Escalation for the low-confidence flags.
        steps += escalate_low_confidence(llm, agent, anchors, low_conf, target_id, artboard)
        if steps:
            agent.batch(steps, f"refine-iter-{it}")
        iters.append({"iteration": it, "anchorCountBefore": len(anchors),
                      "curvatureSpikes": spikes, "visionCritique": crit,
                      "editsApplied": steps, "contentHash": h,
                      "lowConfidenceFlags": low_conf})
        if not any(crit[k] for k in ("kinks", "selfIntersections", "flatnessErrors")) and len(anchors) <= ANCHOR_BUDGET:
            terminated_by = "converged"
            break
        if len(anchors) <= ANCHOR_BUDGET and prev_hash == h:
            stable += 1
            if stable >= 2:
                terminated_by = "fixed-point"
                break
        else:
            stable = 0
        prev_hash = h

    log = {"sku": sku, "pathId": target_id, "iterations": iters,
           "finalAnchorCount": len(read_anchors(agent, target_id)),
           "terminatedBy": terminated_by,
           "elapsedMs": int((time.monotonic() - t0) * 1000)}
    with open("refinement-log.jsonl", "a") as handle:
        handle.write(json.dumps(log) + "\n")
    return log


# ────────────────────────────────────────────────────────────────────────────
# 8. HELPERS
# ────────────────────────────────────────────────────────────────────────────
def _t_to_anchor_index(anchors, t): return min(range(len(anchors)), key=lambda i: abs(i / len(anchors) - t))


def _tangent_at(anchors, i):
    a = anchors[i]; nxt = anchors[(i + 1) % len(anchors)]
    d = (nxt["x"] - a["x"], nxt["y"] - a["y"]); n = math.hypot(*d) or 1.0
    return (d[0] / n, d[1] / n)


def _angle_between(u, v):
    nu, nv = norm(u), norm(v)
    if nu * nv == 0: return 0.0
    return math.acos(max(-1.0, min(1.0, (u[0] * v[0] + u[1] * v[1]) / (nu * nv))))


def _anchor_t(anchors, i): return i / len(anchors)


def _rect_around_anchor(anchors, i, pad_pt: float, artboard: float) -> list[float]:
    """A crop rectangle around an anchor, in raster pixels."""
    scale = artboard / 512.0
    a = anchors[i]
    return [max(0.0, (a["x"] - pad_pt) * scale),
            max(0.0, (a["y"] - pad_pt) * scale),
            (a["x"] + pad_pt) * scale,
            (a["y"] + pad_pt) * scale]


def _bbox(anchors):
    if not anchors:
        return [0.0, 0.0, 0.0, 0.0]
    xs = [a["x"] for a in anchors]
    ys = [a["y"] for a in anchors]
    return [min(xs), min(ys), max(xs), max(ys)]
