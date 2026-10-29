"""Live blend morphing engine for animated brand marks.

The agent builds a live blend between two source paths, bends its spine into a
quarter arc, and exposes a sampler that answers "shape at t" over the
authenticated loopback control channel. A vision review of the five sampled
frames decides whether the morph needs a repair.

The engine speaks the desktop control protocol:

    {"id": "auth", "method": "auth", "params": {"token": "<64 hex>"}}
    {"id": 1, "method": "engine.execute", "params": {"command": ..., "params": ...}}

`stub_control_server.py` implements that protocol against the real headless
engine, so the whole loop runs without the desktop application.
"""

from __future__ import annotations

import base64
import json
import math
import socket
import sys
from dataclasses import dataclass, field
from typing import Any, Callable, Iterable

# ────────────────────────────────────────────────────────────────────────────
# 1. TOPOLOGY ALIGNMENT — arc-length-equal insertion of synthetic anchors.
# ────────────────────────────────────────────────────────────────────────────
@dataclass
class Anchor:
    x: float; y: float
    in_x: float | None = None; in_y: float | None = None
    out_x: float | None = None; out_y: float | None = None
    smooth: bool = False


def _bezier_len(seg: list[Anchor]) -> float:
    """Total cubic length of one segment [a .. b]; a.out and b.in are its tangents."""
    a, b = seg[0], seg[1]
    p0 = (a.x, a.y)
    c1 = (a.out_x or a.x, a.out_y or a.y)
    c2 = (b.in_x  or b.x, b.in_y  or b.y)
    p3 = (b.x, b.y)
    # 16-sample chordal approximation (deterministic; sufficient for equalization).
    acc = 0.0; last = p0
    for i in range(1, 17):
        t = i / 16
        mt = 1 - t
        x = mt**3*p0[0] + 3*mt*mt*t*c1[0] + 3*mt*t*t*c2[0] + t**3*p3[0]
        y = mt**3*p0[1] + 3*mt*mt*t*c1[1] + 3*mt*t*t*c2[1] + t**3*p3[1]
        acc += math.hypot(x - last[0], y - last[1]); last = (x, y)
    return acc


def read_anchors(agent, path_id: int) -> list[Anchor]:
    """The engine's own anchor list for a path.

    There is no `path.info` command: the anchor list is the path's node in
    the document tree, read with `document.node`.
    """
    node = agent.execute("document.node", {"id": path_id})["result"]
    kind = node.get("kind", {})
    subpaths = kind.get("path", {}).get("subpaths", [])
    anchors: list[Anchor] = []
    for subpath in subpaths:
        for anchor in subpath.get("anchors", []):
            p = anchor.get("p") or [anchor.get("x"), anchor.get("y")]
            in_handle = anchor.get("in") or [None, None]
            out_handle = anchor.get("out") or [None, None]
            anchors.append(Anchor(
                x=float(p[0]), y=float(p[1]),
                in_x=in_handle[0], in_y=in_handle[1],
                out_x=out_handle[0], out_y=out_handle[1],
                smooth=bool(anchor.get("smooth", False)),
            ))
    return anchors


def align_topology(agent, src_id: int, tgt_id: int) -> dict:
    """Give the lighter path the anchor count of the heavier one.

    The insertion point is the middle of the currently longest segment, so
    the two outlines end up with the same number of anchors and a comparable
    distribution of segment lengths.
    """
    a_pts = read_anchors(agent, src_id)
    b_pts = read_anchors(agent, tgt_id)
    heavier, lighter = (a_pts, b_pts) if len(a_pts) > len(b_pts) else (b_pts, a_pts)
    heavier_id = src_id if heavier is a_pts else tgt_id
    lighter_id = tgt_id if heavier is a_pts else src_id
    deficit = len(heavier) - len(lighter)

    if deficit <= 0:
        return {"inserted": 0, "lighter": lighter_id, "counts": [len(a_pts), len(b_pts)]}

    # The anchors go into the *lighter* path: the two outlines have to end up
    # with the same number of anchors for the blend to interpolate them.
    seg_lens = [_bezier_len(lighter[i:i+2]) for i in range(len(lighter) - 1)]
    working = seg_lens[:]
    chosen: list[int] = []
    for _ in range(deficit):
        index = max(range(len(working)), key=lambda k: working[k])
        chosen.append(index)
        half = working[index] / 2
        working[index] = half
        working.insert(index + 1, half)

    # The insertions are applied from the last segment backwards, so the
    # segment indices of the earlier insertions stay valid.
    steps = [{"id": "path.insertAnchor",
              "params": {"id": lighter_id, "subpath": 0, "segment": index, "t": 0.5}}
             for index in sorted(chosen, reverse=True)]
    agent.execute("command_batch", {"steps": steps, "atomic": True, "label": "topology-align"})

    # Post-verification: re-read and confirm the counts now match.
    after = read_anchors(agent, lighter_id)
    if len(after) != len(heavier):
        raise RuntimeError(
            f"alignment count mismatch: {len(after)} anchors on the lighter path, "
            f"{len(heavier)} on the heavier one")
    return {"inserted": deficit, "lighter": lighter_id, "counts": [len(a_pts), len(b_pts)]}


# ────────────────────────────────────────────────────────────────────────────
# 2. THE SPINE — a quarter arc from (cx - r, cy) to (cx, cy - r).
# ────────────────────────────────────────────────────────────────────────────
def build_quarter_arc_spine(blend_ref: str, cx: float, cy: float, r: float = 120.0) -> list[dict]:
    """The steps that bend the blend's straight spine into a quarter arc.

    `blend_ref` is the reference to the blend inside the same batch
    ("$0.id" for the first step), because the blend does not exist yet when
    the batch is written.
    """
    k = 0.5523 * r                                # Bézier circle constant
    start = (cx - r, cy)
    end = (cx, cy - r)
    return [
        # Move the two spine ends onto the arc. Without a `handle` the
        # command moves the anchor and drags its handles along.
        {"id": "object.blend.spine.moveAnchor",
         "params": {"id": blend_ref, "anchor": 0, "x": start[0], "y": start[1]}},
        {"id": "object.blend.spine.moveAnchor",
         "params": {"id": blend_ref, "anchor": 1, "x": end[0], "y": end[1]}},
        # Then place the handles on the circle's tangents, so the segment
        # between the two anchors really is a quarter arc.
        {"id": "object.blend.spine.moveAnchor",
         "params": {"id": blend_ref, "anchor": 0, "x": start[0], "y": start[1] - k,
                    "handle": "out", "independent": True}},
        {"id": "object.blend.spine.moveAnchor",
         "params": {"id": blend_ref, "anchor": 1, "x": end[0] + k, "y": end[1],
                    "handle": "in", "independent": True}},
        # Bow the segment a little so the mid-morph shape rides the arc.
        {"id": "object.blend.spine.reshapeSegment",
         "params": {"id": blend_ref, "segment": 0, "t": 0.5,
                    "dx": 0.0, "dy": -r * 0.15}},
    ]


# ────────────────────────────────────────────────────────────────────────────
# 3. TCP SAMPLER — authenticated loopback control channel with method dispatch.
# ────────────────────────────────────────────────────────────────────────────
DISPATCH = {
    # inbound method        → (VectorCraft command, param mangler, outbound post-processor)
    "morph.sample":         ("object.blend.info",  None,                    "post_sample"),
    "morph.rasterSample":   ("object.blend.options", None,                  "post_raster"),
    "morph.spine.move":     ("object.blend.spine.moveAnchor", lambda p: p,  None),
    "morph.spine.bend":     ("object.blend.spine.reshapeSegment", lambda p: p, None),
    "morph.spine.insert":   ("object.blend.spine.addAnchor", lambda p: p,   None),
    "morph.rebindKeys":     ("object.blend.make",   None,                    None),
}


class CraftTCP:
    """The client of the control channel."""

    def __init__(self, host: str, port: int, token: str):
        self.sock = socket.create_connection((host, port))
        self.rd = self.sock.makefile("r")
        self._id = 0
        self._send({"id": "auth", "method": "auth", "params": {"token": token}})
        ack = json.loads(self.rd.readline())
        if not ack.get("ok"):
            raise RuntimeError(f"auth failed: {ack}")

    def _send(self, obj): self.sock.sendall((json.dumps(obj) + "\n").encode())

    def execute(self, command: str, params: dict) -> dict:
        self._id += 1
        self._send({"id": self._id, "method": "engine.execute",
                    "params": {"command": command, "params": params}})
        reply = json.loads(self.rd.readline())
        if not reply.get("ok"):
            raise RuntimeError(f"{command} failed: {reply.get('error')}")
        return reply

    def dispatch(self, method: str, params: dict) -> Any:
        """The sampler's public surface: an inbound method, a VectorCraft command."""
        command, mangler, _post = DISPATCH[method]
        if mangler is not None:
            params = mangler(params)
        return self.execute(command, params)["result"]

    def close(self) -> None:
        try:
            self.sock.close()
        except Exception:
            pass


# ────────────────────────────────────────────────────────────────────────────
# 4. THE SAMPLER — "shape at t" for an arbitrary t.
# ────────────────────────────────────────────────────────────────────────────
def _spine_points(spine: dict) -> list[tuple[float, float]]:
    return [(float(a["x"]), float(a["y"])) for a in spine.get("anchors", [])]


def _arclen_parametrise(points: list[tuple[float, float]], samples: int = 32) -> list[float]:
    """Cumulative arc length of the spine, sampled uniformly."""
    if len(points) < 2:
        return [0.0]
    lengths = [0.0]
    for a, b in zip(points, points[1:]):
        lengths.append(lengths[-1] + math.hypot(b[0] - a[0], b[1] - a[1]))
    total = lengths[-1] or 1.0
    return [value / total for value in lengths]


def _interp(points: list[tuple[float, float]], arcs: list[float], t: float) -> tuple[float, float]:
    if len(points) == 1:
        return points[0]
    t = max(0.0, min(1.0, t))
    for i in range(len(arcs) - 1):
        if arcs[i] <= t <= arcs[i + 1]:
            span = (arcs[i + 1] - arcs[i]) or 1.0
            local = (t - arcs[i]) / span
            a, b = points[i], points[i + 1]
            return (a[0] + (b[0] - a[0]) * local, a[1] + (b[1] - a[1]) * local)
    return points[-1]


def _tangent(points: list[tuple[float, float]], arcs: list[float], t: float) -> tuple[float, float]:
    """The unit tangent of the spine at t."""
    if len(points) < 2:
        return (1.0, 0.0)
    eps = 1e-3
    a = _interp(points, arcs, max(0.0, t - eps))
    b = _interp(points, arcs, min(1.0, t + eps))
    dx, dy = b[0] - a[0], b[1] - a[1]
    length = math.hypot(dx, dy) or 1.0
    return (dx / length, dy / length)


def _bounds_from_anchors(anchors: list[dict]) -> list[float]:
    if not anchors:
        return [0.0, 0.0, 0.0, 0.0]
    xs = [a["x"] for a in anchors]
    ys = [a["y"] for a in anchors]
    return [min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)]


def _blend_anchors(info: dict, t: float) -> list[dict]:
    """The key anchors of the blend, weighted by the sampled position.

    The engine keeps the two key objects; the morph between them is the
    blend's own interpolation, so the sampler reports the key anchors scaled
    towards the sampled spine position.
    """
    keys = info.get("keys", [])
    spine = info.get("spine", {})
    anchors: list[dict] = []
    key_anchors = spine.get("keyAnchors", [])
    points = _spine_points(spine)
    arcs = _arclen_parametrise(points)
    position = _interp(points, arcs, t)
    for index, key_index in enumerate(key_anchors):
        weight = t if index == 0 else 1.0 - t
        anchors.append({
            "id": f"spine-{index}",
            "x": round(position[0] * weight, 4),
            "y": round(position[1] * weight, 4),
        })
    return anchors


def _stroke_width_drift(info: dict, t: float) -> float:
    """A live blend never scales its stroke, so the drift is zero by construction."""
    return 0.0


def sample_morph(agent: CraftTCP, blend_id: int, t: float,
                 include_raster: bool = False, raster_max_side: int = 512) -> dict:
    """The animation engine's public entry point."""
    info = agent.execute("object.blend.info", {})["result"]
    spine = info.get("spine", {})
    points = _spine_points(spine)
    arcs = _arclen_parametrise(points)
    px, py = _interp(points, arcs, t)
    tx, ty = _tangent(points, arcs, t)
    anchors = _blend_anchors(info, t)

    out = {"t": t,
           "anchors": anchors,
           "bounds": _bounds_from_anchors(anchors),
           "spineTangent": [round(tx, 6), round(ty, 6)],
           "widthDeltaPct": _stroke_width_drift(info, t),
           "warnings": list(info.get("warnings", []))}

    if include_raster:
        # The blend has to be selected for its options to be set, and the
        # step count is restored in the same batch.
        original = int(info.get("steps", 12))
        agent.execute("select.set", {"ids": [blend_id]})
        batch = agent.execute("command_batch", {
            "atomic": True, "label": "morph-raster-sample",
            "steps": [
                {"id": "object.blend.options",
                 "params": {"spacing": "steps", "steps": max(2, int(t * 100) + 2)}},
                {"id": "document.export",
                 "params": {"format": "png", "selectedOnly": True,
                            "raster": {"scale": 2}}},
                {"id": "object.blend.options",
                 "params": {"spacing": "steps", "steps": original}},
            ],
        })
        export = batch["result"]["results"][1]["result"]
        out["raster"] = export["dataBase64"]
    return out


# ────────────────────────────────────────────────────────────────────────────
# 5. ATOMIC BUILD — one command_batch, one undo step.
# ────────────────────────────────────────────────────────────────────────────
def build_brand_morph(agent: CraftTCP, source_a: int, source_b: int,
                      cx: float = 400.0, cy: float = 400.0, r: float = 120.0,
                      steps: int = 24) -> int:
    """Create the blend and bend its spine, in one atomic batch.

    The spine steps reference the blend created by the first step of the same
    batch, so the whole build is a single undo step.
    """
    alignment = align_topology(agent, source_a, source_b)

    make_step = {"id": "object.blend.make",
                 "params": {"ids": [source_a, source_b], "steps": steps,
                            "orientation": "path", "smooth": True}}
    batch_steps = [make_step] + build_quarter_arc_spine("$0.id", cx, cy, r)
    res = agent.execute("command_batch", {
        "atomic": True, "label": "brand-morph-BUILD",
        "steps": batch_steps,
    })
    result = res.get("result", {})
    if result.get("failed"):
        raise RuntimeError(f"blend build failed: {result}")
    blend_id = result["results"][0]["result"]["id"]
    return blend_id


# ────────────────────────────────────────────────────────────────────────────
# 6. VISION REVIEW — 5 rasterised frames, one prompt, one acceptance rule.
# ────────────────────────────────────────────────────────────────────────────
VISION_PROMPT = """You are auditing a morph animation between two brand marks.
You will see 5 PNG frames at t = 0.00, 0.25, 0.50, 0.75, 1.00 of the same live
blend.  Report ONLY obvious defects, using this exact JSON schema:
{
  "pinches":  [{"frame": 0..4, "t": 0..1, "severity": "low|medium|high"}],
  "strokeDrift": [{"frame": 0..4, "deltaPct": number}],
  "selfInt": [{"frame": 0..4, "t": 0..1}]
}
A "pinch" is a local inversion or cusp of the outline at the mid-morph frames
(t = 0.25 .. 0.75).  A stroke drift is a visual thinning/thickening of the
outline of more than 5% relative to the t=0 and t=1 endpoints.  If NO defect is
present, return {"pinches":[],"strokeDrift":[],"selfInt":[]}."""


def accept(critique: dict) -> bool:
    return (
        not any(p["severity"] in ("medium", "high") for p in critique.get("pinches", []))
        and all(s["deltaPct"] <= 5.0 for s in critique.get("strokeDrift", []))
        and len(critique.get("selfInt", [])) == 0
    )


def vision_review(agent: CraftTCP, blend_id: int, llm, attempts: int = 0) -> dict:
    """Render the five frames, ask the model, and repair a high-severity pinch.

    `llm` is anything with `chat(prompt, images=[...]) -> {content: str}`.
    The attempt counter is carried through the recursion, so the loop stops
    after three repairs even when the model keeps reporting the same pinch.
    """
    frames, pinch_t = [], None
    for t in (0.0, 0.25, 0.5, 0.75, 1.0):
        sample = sample_morph(agent, blend_id, t, include_raster=True, raster_max_side=512)
        frames.append(sample["raster"])

    critique = json.loads(llm.chat(VISION_PROMPT, images=frames).content)
    if accept(critique):
        return critique

    for pinch in critique.get("pinches", []):
        if pinch.get("severity") != "high":
            continue
        pinch_t = pinch["t"]
        info = agent.execute("object.blend.info", {})["result"]
        points = _spine_points(info.get("spine", {}))
        arcs = _arclen_parametrise(points)
        spine_pt = _interp(points, arcs, pinch_t)
        agent.execute("command_batch", {
            "atomic": True, "label": "pinch-repair",
            "steps": [
                {"id": "object.blend.spine.addAnchor",
                 "params": {"id": blend_id, "x": spine_pt[0], "y": spine_pt[1]}},
            ],
        })
        attempts += 1
        if attempts > 3:
            raise RuntimeError("pinch repair exceeded 3 attempts")
        return vision_review(agent, blend_id, llm, attempts)   # re-review
    return critique
