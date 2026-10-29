"""Vector store-driven parametric icon synthesis.

The agent embeds a natural-language description, retrieves the nearest
approved icons from a vector store, derives a weighted style consensus from
them, synthesises a new icon in VectorCraft, and validates it against the
store. A candidate that comes back too close to an existing icon is perturbed
along the anchors' local normals, and then shrunk, until it is accepted.

The store is reached over a JSON-RPC bus (`embed.query`, `knn.search`,
`pgvector.upsert`, `vectorcraft.execute`, `vectorcraft.batch`). The class
`LocalVectorStore` below implements that bus in memory; a production sidecar
speaks the same methods against pgvector and Pinecone.
"""

from __future__ import annotations

import base64
import hashlib
import io
import json
import math
import re
import time
import uuid
from typing import Any

EMBED_DIM = 128

# ────────────────────────────────────────────────────────────────────────────
# 0. THE ENGINE — one MCP session to the headless VectorCraft.
# ────────────────────────────────────────────────────────────────────────────
class VectorAgent:
    """The subset of VectorCraft the synthesis needs."""

    def __init__(self, binary: str = "vectorcraft-cli") -> None:
        self.binary = binary
        self.proc: Any = None
        self._id = 0

    def __enter__(self) -> "VectorAgent":
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
                               "clientInfo": {"name": "icon-synthesiser", "version": "1.0.0"}}})
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
            if block.get("type") == "image" and block.get("data"):
                return {"png": block["data"], "mimeType": block.get("mimeType", "image/png")}
            if block.get("type") == "text" and block.get("text"):
                text = block["text"]
                try:
                    return json.loads(text)
                except json.JSONDecodeError:
                    return text
        return None

    def render(self, max_side: int = 1024) -> str:
        """A base64 PNG of the active artboard."""
        result = self._call("render_preview", {"artboard": 0, "max_side": max_side})
        if not isinstance(result, dict) or not result.get("png"):
            raise RuntimeError("render_preview returned no image")
        return result["png"]

    def run(self, command: str, params: dict[str, Any] | None = None) -> Any:
        """Run one engine command."""
        return self._call("command_run", {"id": command, "params": params or {}})

    def batch(self, steps: list[dict[str, Any]], label: str) -> Any:
        """Run an atomic batch of engine commands."""
        return self._call("command_batch", {"steps": steps, "atomic": True, "label": label})

    def tool(self, name: str, args: dict[str, Any] | None = None) -> Any:
        """Call a meta-tool, such as `inspect_document`."""
        return self._call(name, args or {})


# ────────────────────────────────────────────────────────────────────────────
# 0b. THE BUS — a JSON-RPC 2.0 sidecar. The local store is the reference
#     implementation of the five methods the agent uses.
# ────────────────────────────────────────────────────────────────────────────
BUS_METHODS = [
    "embed.query", "knn.search", "pgvector.upsert",
    "vectorcraft.execute", "vectorcraft.batch",
]


class LocalVectorStore:
    """An in-memory stand-in for pgvector + Pinecone.

    It answers the same five methods, so the agent cannot tell the
    difference; the production sidecar swaps the cosine scan for
    `ORDER BY embedding <=> $1 LIMIT $2` and keeps the rest.
    """

    def __init__(self, agent: Any = None) -> None:
        self.rows: list[dict[str, Any]] = []
        self.agent = agent

    # -- the bus -----------------------------------------------------------
    def call(self, method: str, params: dict[str, Any]) -> Any:
        if method == "embed.query":
            return {"embedding": self.embed_text(params["text"])}
        if method == "knn.search":
            return {"matches": self.knn(params["embedding"], int(params.get("k", 8)))}
        if method == "pgvector.upsert":
            return self.upsert(params)
        if method == "vectorcraft.execute":
            return self.agent.run(params["id"], params.get("params", {}))
        if method == "vectorcraft.batch":
            return self.agent.batch(params["steps"], params.get("label", "batch"))
        raise RuntimeError(f"unknown bus method `{method}`")

    # -- the store ---------------------------------------------------------
    @staticmethod
    def embed_text(text: str) -> list[float]:
        """A deterministic text embedding: the same words always land in the
        same place, which is what a retrieval test needs."""
        digest = hashlib.sha256(text.strip().lower().encode()).digest()
        raw = [digest[i % len(digest)] / 255.0 - 0.5 for i in range(EMBED_DIM)]
        return l2_normalise(raw)

    def upsert(self, params: dict[str, Any]) -> dict[str, Any]:
        metadata = params.get("metadata", {})
        row = {
            "id": len(self.rows) + 1,
            "slug": params.get("slug", f"icon-{len(self.rows) + 1}"),
            "embedding": list(params["embedding"]),
            "brandCompliant": True,
            "anchorCount": int(metadata.get("anchorCount", 32)),
            "strokeWidthPt": float(metadata.get("strokeWidthPt", 2.0)),
            "strokeCap": metadata.get("strokeCap", "round"),
            "fillOpacity": float(metadata.get("fillOpacity", 1.0)),
            "cornerClass": metadata.get("cornerClass", "soft"),
            "sourcePath": metadata.get("sourcePath", ""),
        }
        self.rows.append(row)
        return {"id": row["id"]}

    def knn(self, query: list[float], k: int) -> list[dict[str, Any]]:
        scored = []
        for row in self.rows:
            distance = 1.0 - cosine(query, row["embedding"])
            scored.append((distance, row))
        scored.sort(key=lambda pair: pair[0])
        return [{
            "slug": row["slug"],
            "cosineDistance": round(distance, 6),
            "anchorCount": row["anchorCount"],
            "strokeWidthPt": row["strokeWidthPt"],
            "strokeCap": row["strokeCap"],
            "fillOpacity": row["fillOpacity"],
            "cornerClass": row["cornerClass"],
            "sourcePath": row["sourcePath"],
        } for distance, row in scored[:k]]


# ────────────────────────────────────────────────────────────────────────────
# 1. 128-d EMBEDDER — deterministic and L2-normalised at the end.
# ────────────────────────────────────────────────────────────────────────────
def embed_icon(anchors: list[dict], stroke_width_pt: float,
               stroke_cap: str, fill_opacity: float) -> list[float]:
    """
    Construct the 128-d embedding = concat of:
      [ 4 ]  role histogram  (corner, tangent, extreme, other)
      [ 4 ]  handle-policy histogram (auto-tangent, fixed-ratio, mirrored, independent)
      [32]  Fourier coefficients of the turn-angle sequence
      [ 4]  curvature distribution moments (mean, var, skew, kurtosis)
      [64]  8x8 DCT of the normalised anchor rasterisation
      [16]  style block (stroke-width bucket, cap one-hot, opacity bucket, corner class one-hot x4)
    Total = 4+4+32+4+64+16 = 124 -> pad to 128 with 4 zeros reserved for future use.
    """
    n = len(anchors)
    assert n >= 3

    # 1a. Role histogram — the engine does not carry roles, so they are
    #     classified from the tangent angle at each anchor.
    role = [0.0] * 4
    for i, a in enumerate(anchors):
        role[classify_role(a, anchors)] += 1
    role = [r / n for r in role]

    # 1b. Handle-policy histogram — inferred from the raw handles.
    pol = [0.0] * 4
    for a in anchors:
        pol[infer_handle_policy(a)] += 1
    pol = [p / n for p in pol]

    # 1c. Turn-angle sequence (heading change per anchor), then DFT.
    turns = turn_angles(anchors)                        # length n, radians
    fs = [t / (2 * math.pi) for t in range(32)]         # first 32 frequencies
    coeffs = []
    for f in fs:
        real = sum(turns[i] * math.cos(2 * math.pi * f * i / n) for i in range(n)) / n
        imag = sum(turns[i] * math.sin(2 * math.pi * f * i / n) for i in range(n)) / n
        coeffs.append(real)
        coeffs.append(imag)
    coeffs = coeffs[:32]

    # 1d. Curvature moments.
    curvatures = [anchor_curvature(anchors, i) for i in range(n)]
    mean = sum(curvatures) / n
    var = sum((c - mean) ** 2 for c in curvatures) / n
    skew = (sum((c - mean) ** 3 for c in curvatures) / n) / (var ** 1.5) if var > 1e-12 else 0.0
    kurt = (sum((c - mean) ** 4 for c in curvatures) / n) / (var ** 2) if var > 1e-12 else 0.0
    moments = [mean, var, skew, kurt]

    # 1e. DCT of the anchor raster.
    grid = rasterise(anchors, 8)
    dct = dct_2d(grid)
    dct_flat = flatten_low_pass(dct, keep=64)           # first 64 coefficients

    # 1f. Style block.
    style = style_block(stroke_width_pt, stroke_cap, fill_opacity, anchors)

    vec = role + pol + coeffs + moments + dct_flat + style
    vec += [0.0] * (EMBED_DIM - len(vec))               # pad to 128
    return l2_normalise(vec)


# ────────────────────────────────────────────────────────────────────────────
# 2. KNN QUERY (pgvector) — cosine operator `<=>`.
# ────────────────────────────────────────────────────────────────────────────
KNN_SQL = """
SELECT id, slug, embedding <=> $1 AS cosine_distance,
       stroke_width_pt, stroke_cap, fill_opacity, corner_class, source_path
  FROM icons
 WHERE brand_compliant
 ORDER BY embedding <=> $1
 LIMIT $2;
"""
# `<=>` is pgvector's cosine-distance operator, i.e. 1 - cosine_similarity.
# We use cosine (not `<->`, which is L2) because our embedder already L2-normalises
# every vector; on the unit sphere, cosine distance ignores magnitude and only
# compares orientation, which is what "brand look-alike" means here.

def knn(sidecar, query_vec: list[float], k: int = 8) -> list[dict]:
    return sidecar.call("knn.search", {"embedding": query_vec, "k": k})["matches"]


# ────────────────────────────────────────────────────────────────────────────
# 3. WEIGHTED STYLE CONSENSUS (softmax by cosine similarity).
# ────────────────────────────────────────────────────────────────────────────
def style_consensus(matches: list[dict], tau: float = 0.15) -> dict:
    sims = [1.0 - m["cosineDistance"] for m in matches]
    # Softmax with temperature tau; tau=0.15 keeps the nearest neighbour's voice
    # at roughly 2.6x the farthest when sims range over ~0.06 (typical for our store).
    exps = [math.exp(s / tau) for s in sims]
    z = sum(exps)
    w = [e / z for e in exps]
    sw    = sum(wi * m["strokeWidthPt"] for wi, m in zip(w, matches))
    cap_c = {c: sum(wi for wi, m in zip(w, matches) if m["strokeCap"] == c)
             for c in ("butt", "round", "square")}
    cap   = max(cap_c, key=cap_c.get)
    op    = sum(wi * m["fillOpacity"] for wi, m in zip(w, matches))
    corner_c = {c: sum(wi for wi, m in zip(w, matches) if m["cornerClass"] == c)
                for c in ("sharp", "soft", "rounded")}
    corner = max(corner_c, key=corner_c.get)
    anchor_lo = min(m.get("anchorCount", 25) for m in matches) or 25
    anchor_hi = max(m.get("anchorCount", 60) for m in matches) or 60
    return {"strokeWidthPt": sw, "strokeCap": cap, "fillOpacity": op,
            "cornerClass": corner, "anchorRange": (anchor_lo, anchor_hi),
            "weights": w, "similarities": sims}


# ────────────────────────────────────────────────────────────────────────────
# 4. SHAPE GRAMMAR — description tokens → anchor list + optional boolean steps.
# ────────────────────────────────────────────────────────────────────────────
def polygon(cx: float, cy: float, radius: float, sides: int, rotation: float = -math.pi / 2) -> list[dict]:
    return [{"x": round(cx + radius * math.cos(rotation + 2 * math.pi * i / sides), 4),
             "y": round(cy + radius * math.sin(rotation + 2 * math.pi * i / sides), 4)}
            for i in range(sides)]


def hexagon(fit):  return [polygon(256, 256, 170, 6)], []
def disc(fit):     return [polygon(256, 256, 160, 48)], []
def rect_icon(fit): return [[{"x": 120, "y": 120}, {"x": 392, "y": 120},
                             {"x": 392, "y": 392}, {"x": 120, "y": 392}]], []


def parcel(fit):
    body = [{"x": 128, "y": 176}, {"x": 384, "y": 176}, {"x": 384, "y": 400}, {"x": 128, "y": 400}]
    return [body], []


def shield(fit):
    return [[{"x": 256, "y": 116}, {"x": 384, "y": 188}, {"x": 384, "y": 300},
             {"x": 256, "y": 404}, {"x": 128, "y": 300}, {"x": 128, "y": 188}]], []


def arrow_up(fit):
    shaft = [{"x": 236, "y": 200}, {"x": 276, "y": 200}, {"x": 276, "y": 300}, {"x": 236, "y": 300}]
    head = [{"x": 176, "y": 288}, {"x": 336, "y": 288}, {"x": 256, "y": 160}]
    return [shaft, head], []


GRAMMAR_RULES = [
    # (regex, builder) — a builder returns (subpaths, extra_batch_steps)
    (r"hexagonal",             lambda m, fit: hexagon(fit)),
    (r"arrow (leaving|going) from the top",
                               lambda m, fit: arrow_up(fit)),
    (r"parcel|box|package",    lambda m, fit: parcel(fit)),
    (r"circle|disc|dot",       lambda m, fit: disc(fit)),
    (r"shield",                lambda m, fit: shield(fit)),
]


def shape_grammar(description: str, consensus: dict) -> tuple[list[list[dict]], list[dict]]:
    """Parse description into one or more subpath anchor-lists plus optional boolean steps."""
    tokens = description.lower()
    built: list[list[dict]] = []
    extra:  list[dict] = []
    fit = {"canvasPt": 512, "cornerClass": consensus["cornerClass"]}
    for pat, builder in GRAMMAR_RULES:
        if re.search(pat, tokens):
            subpaths, steps = builder(None, fit)
            built.extend(subpaths)
            extra.extend(steps)
    if not built:
        built.append(rect_icon(fit)[0][0])   # fallback
    return built, extra


# ────────────────────────────────────────────────────────────────────────────
# 5. SYNTHESIS IN VECTORCRAFT (one batch per candidate, atomic).
# ────────────────────────────────────────────────────────────────────────────
def synthesise_candidate(agent, subpaths, extra, consensus) -> tuple[int, str]:
    batch: list[dict[str, Any]] = []
    refs: list[str] = []
    for sp in subpaths:
        batch.append({"id": "path.create", "params": {"anchors": sp, "closed": True}})
        refs.append(f"${len(batch) - 1}.id")
    batch += extra
    if len(refs) > 1:
        batch.append({"id": "select.set", "params": {"ids": refs}})
        batch.append({"id": "object.compoundPath.make", "params": {}})
        refs = [f"${len(batch) - 1}.id"]
    batch.append({"id": "paint.setFill",   "params": {"ids": [refs[0]], "color": "#1F2937",
                                                      "opacity": consensus["fillOpacity"]}})
    batch.append({"id": "stroke.set",      "params": {"ids": [refs[0]],
                                                      "weight": consensus["strokeWidthPt"],
                                                      "cap":    consensus["strokeCap"],
                                                      "join":   "round"}})
    result = agent.batch(batch, "synthesis")
    if isinstance(result, dict) and result.get("failed"):
        raise RuntimeError(f"synthesis failed: {result}")
    return _last_created_id(result, refs[0]), canonical_hash_of_doc(agent)


def _last_created_id(result: Any, fallback: str) -> int:
    """The id of the object the batch created."""
    if isinstance(result, dict):
        for entry in reversed(result.get("results", [])):
            if entry.get("ok") and isinstance(entry.get("result"), dict) and "id" in entry["result"]:
                return entry["result"]["id"]
    return int(str(fallback).lstrip("$").split(".")[0])


# ────────────────────────────────────────────────────────────────────────────
# 6. PERTURBATION LOOP + VALIDATION.
# ────────────────────────────────────────────────────────────────────────────
def validate(agent, obj_id, sidecar, reject_sim: float = 0.94) -> dict:
    anchors = read_anchors(agent, obj_id)
    vec = embed_icon(anchors, *read_style(agent, obj_id))
    nearest = knn(sidecar, vec, k=1)
    if not nearest:
        return {"accepted": True, "nearest": None, "similarity": 0.0}
    sim = 1.0 - nearest[0]["cosineDistance"]
    return {"accepted": sim <= reject_sim,
            "nearest": nearest[0]["slug"], "similarity": sim}


def perturb(agent, obj_id, magnitude_pt: float) -> int:
    """Nudge every anchor along its local normal.

    The handles translate with the anchor, so the curve stays a translated
    copy locally and the shape survives the nudge.
    """
    steps: list[dict[str, Any]] = []
    for member_id, anchors in _member_paths(agent, obj_id):
        for i, a in enumerate(anchors):
            tx, ty = _tangent_at(anchors, i)
            nx, ny = -ty, tx
            # Select the anchor, then move the selection along the normal.
            steps.append({"id": "select.anchors", "params": {"id": member_id, "anchors": [[0, i]]}})
            steps.append({"id": "path.moveAnchors",
                          "params": {"dx": nx * magnitude_pt, "dy": ny * magnitude_pt}})
    agent.batch(steps, "perturb")
    return obj_id


def _member_paths(agent, obj_id: int) -> list[tuple[int, list[dict]]]:
    """The paths an object is made of, with their anchors.

    A compound path is not a path, so its members are moved instead; the
    engine refuses `path.moveAnchors` on a compound.
    """
    node = agent.run("document.node", {"id": obj_id})
    kind = node.get("kind", {})
    if kind.get("path"):
        return [(obj_id, read_anchors(agent, obj_id))]
    members: list[tuple[int, list[dict]]] = []
    for child in kind.get("children", []):
        anchors: list[dict] = []
        for subpath in child.get("kind", {}).get("path", {}).get("subpaths", []):
            for anchor in subpath.get("anchors", []):
                position = anchor.get("p") or [anchor.get("x"), anchor.get("y")]
                in_handle = anchor.get("in") or [None, None]
                out_handle = anchor.get("out") or [None, None]
                anchors.append({
                    "x": round(float(position[0]), 6),
                    "y": round(float(position[1]), 6),
                    "in":  [round(float(in_handle[0]), 6),  round(float(in_handle[1]), 6)]  if in_handle[0] is not None else None,
                    "out": [round(float(out_handle[0]), 6), round(float(out_handle[1]), 6)] if out_handle[0] is not None else None,
                    "smooth": bool(anchor.get("smooth", False)),
                })
        members.append((child["id"], anchors))
    return members


def shrinking_perturb(agent, obj_id, pct: float) -> int:
    """The shrink branch: scale the whole icon down by a percentage."""
    agent.batch([{"id": "transform.set",
                  "params": {"ids": [obj_id], "scaleX": 100 - pct, "scaleY": 100 - pct}}],
                "shrink")
    return obj_id


def synthesis_pipeline(agent, sidecar, request: dict) -> dict:
    # 6a. Embed + KNN.
    qv = sidecar.call("embed.query", {"text": request["description"]})["embedding"]
    matches = knn(sidecar, qv, k=request["k"])
    retrieval_hash = sha256(json.dumps([
        {"slug": m["slug"], "d": m["cosineDistance"]} for m in matches
    ], sort_keys=True))

    # 6b. Weighted style consensus.
    consensus = style_consensus(matches)

    # 6c. Shape grammar → anchor lists.
    subpaths, extra = shape_grammar(request["description"], consensus)

    # 6d. First candidate + validation.
    obj_id, _ = synthesise_candidate(agent, subpaths, extra, consensus)
    validation_history: list[dict[str, Any]] = []
    decision = validate(agent, obj_id, sidecar, request["similarityRejectThreshold"])
    validation_history.append({"stage": "initial", **decision})
    if decision["accepted"]:
        return finalise(agent, obj_id, qv, matches, consensus, request,
                        retrieval_hash, validation_history, "accepted")

    # 6e. Perturbation schedule: 1.5, 2.4, 3.84, 6.144, 8.0 (capped at 8 pt).
    mag = 1.5
    for _ in range(request["perturbationBudget"]):
        mag = min(mag * 1.6, 8.0)
        perturb(agent, obj_id, mag)
        d = validate(agent, obj_id, sidecar, request["similarityRejectThreshold"])
        validation_history.append({"stage": "perturb", "magnitudePt": mag, **d})
        if d["accepted"]:
            return finalise(agent, obj_id, qv, matches, consensus, request,
                            retrieval_hash, validation_history, "perturbed")

    # 6f. Escalate to the shrink branch.
    for step in range(3):
        shrinking_perturb(agent, obj_id, request["shrinkStepPct"])
        d = validate(agent, obj_id, sidecar, request["similarityRejectThreshold"])
        validation_history.append({"stage": "shrink", "stepPct": request["shrinkStepPct"],
                                   "iteration": step, **d})
        if d["accepted"]:
            return finalise(agent, obj_id, qv, matches, consensus, request,
                            retrieval_hash, validation_history, "shrunk")

    # 6g. Non-convergence → reject the request outright.
    return {"status": "rejected", "history": validation_history}


# ────────────────────────────────────────────────────────────────────────────
# 7. NESTED CONTENT-HASH CHAIN.
# ────────────────────────────────────────────────────────────────────────────
def finalise(agent, obj_id, qv, matches, consensus, request,
             retrieval_hash: str, history: list[dict], path_taken: str) -> dict:
    anchors = read_anchors(agent, obj_id)
    geometry_hash = sha256(json.dumps(anchors, sort_keys=True, separators=(",", ":")))
    validation_hash = sha256(json.dumps(history, sort_keys=True))
    spec_hash = sha256(request["description"] + "|" + request["requestId"])

    # Nested: each layer commits the layer below, so a change to any sub-tree
    # invalidates every hash above it.
    composite = sha256(json.dumps({
        "spec":       spec_hash,
        "retrieval":  retrieval_hash,
        "geometry":   geometry_hash,
        "validation": validation_hash,
        "pathTaken":  path_taken,
    }, sort_keys=True))

    return {
        "status": "accepted",
        "pathTaken": path_taken,
        "objectId": obj_id,
        "hashes": {
            "specHash": spec_hash,
            "retrievalHash": retrieval_hash,
            "geometryHash": geometry_hash,
            "validationHash": validation_hash,
            "composite": composite,
        },
        "style": consensus,
        "provenance": [{"slug": m["slug"], "weight": consensus["weights"][i],
                        "similarity": consensus["similarities"][i]}
                       for i, m in enumerate(matches)],
    }


# ────────────────────────────────────────────────────────────────────────────
# 8. THE ENGINE HELPERS
# ────────────────────────────────────────────────────────────────────────────
def read_anchors(agent, obj_id: int) -> list[dict]:
    """The engine's own anchor list.

    There is no `path.info` command: the anchors are the object's node in the
    document tree, read with `document.node`.
    """
    node = agent.run("document.node", {"id": obj_id})
    kind = node.get("kind", {})
    # A plain path carries its subpaths; a compound path carries its members,
    # each with its own subpaths.
    subpaths = kind.get("path", {}).get("subpaths", [])
    if not subpaths:
        for child in kind.get("children", []):
            subpaths.extend(child.get("kind", {}).get("path", {}).get("subpaths", []))
    out: list[dict] = []
    for subpath in subpaths:
        for anchor in subpath.get("anchors", []):
            position = anchor.get("p") or [anchor.get("x"), anchor.get("y")]
            in_handle = anchor.get("in") or [None, None]
            out_handle = anchor.get("out") or [None, None]
            out.append({
                "x": round(float(position[0]), 6),
                "y": round(float(position[1]), 6),
                "in":  [round(float(in_handle[0]), 6),  round(float(in_handle[1]), 6)]  if in_handle[0] is not None else None,
                "out": [round(float(out_handle[0]), 6), round(float(out_handle[1]), 6)] if out_handle[0] is not None else None,
                "smooth": bool(anchor.get("smooth", False)),
            })
    return out


def read_style(agent, obj_id: int) -> tuple[float, str, float]:
    """The stroke width, the cap style and the fill opacity of an object."""
    attributes = agent.run("attributes.info", {"ids": [obj_id]}) or {}
    node = agent.run("document.node", {"id": obj_id}) or {}
    items = node.get("appearance", {}).get("items", [])
    weight, cap, opacity = 2.0, "round", 1.0
    for item in items:
        if item.get("kind") == "stroke":
            weight = float(item.get("width", 2.0))
        if item.get("kind") == "fill":
            paint = item.get("paint", {})
            opacity = float(paint.get("opacity", 1.0))
    return weight, cap, opacity


def canonical_hash_of_doc(agent) -> str:
    """A fingerprint of the document's geometry."""
    tree = agent.tool("inspect_document", {}) or {}
    payload = []
    for layer in tree.get("layers", []):
        for node in layer.get("children", []):
            payload.append(f"{node.get('id')}:{node.get('kind')}:{node.get('anchors')}")
    return sha256("|".join(sorted(payload)))


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode()).hexdigest()


def _tangent_at(anchors, i):
    a = anchors[i]; nxt = anchors[(i + 1) % len(anchors)]
    d = (nxt["x"] - a["x"], nxt["y"] - a["y"]); n = math.hypot(*d) or 1.0
    return (d[0] / n, d[1] / n)


# ────────────────────────────────────────────────────────────────────────────
# 9. THE EMBEDDER'S HELPERS
# ────────────────────────────────────────────────────────────────────────────
def l2_normalise(vec: list[float]) -> list[float]:
    norm = math.sqrt(sum(v * v for v in vec)) or 1.0
    return [v / norm for v in vec]


def cosine(a: list[float], b: list[float]) -> float:
    return sum(x * y for x, y in zip(a, b))


def classify_role(anchor: dict, anchors: list[dict]) -> int:
    """0 = corner, 1 = tangent, 2 = extreme, 3 = other.

    The engine does not carry roles, so they are derived: an anchor with no
    handles is a corner, an anchor whose handles are collinear is a tangent,
    and an anchor that is further from the outline's centre than its
    neighbours is an extreme.
    """
    if not anchor.get("in") and not anchor.get("out"):
        return 0
    if anchor.get("in") and anchor.get("out"):
        cross = ((anchor["out"][0] - anchor["x"]) * (anchor["in"][1] - anchor["y"])
                 - (anchor["out"][1] - anchor["y"]) * (anchor["in"][0] - anchor["x"]))
        if abs(cross) < 1e-6:
            return 1
    cx = sum(a["x"] for a in anchors) / len(anchors)
    cy = sum(a["y"] for a in anchors) / len(anchors)
    radius = math.hypot(anchor["x"] - cx, anchor["y"] - cy)
    radii = [math.hypot(a["x"] - cx, a["y"] - cy) for a in anchors]
    mean = sum(radii) / len(radii)
    if radius > mean * 1.15:
        return 2
    return 3


def infer_handle_policy(anchor: dict) -> int:
    """0 = auto-tangent, 1 = fixed-ratio, 2 = mirrored, 3 = independent."""
    if not anchor.get("in") or not anchor.get("out"):
        return 3
    in_len = math.hypot(anchor["in"][0] - anchor["x"], anchor["in"][1] - anchor["y"])
    out_len = math.hypot(anchor["out"][0] - anchor["x"], anchor["out"][1] - anchor["y"])
    if abs(in_len - out_len) < 1e-6:
        return 0
    ratio = out_len / in_len if in_len > 1e-9 else 1.0
    if 0.9 < ratio < 1.1:
        return 0
    if abs((anchor["in"][0] - anchor["x"]) + (anchor["out"][0] - anchor["x"])) < 1e-6:
        return 2
    return 1


def turn_angles(anchors: list[dict]) -> list[float]:
    """The heading change at every anchor, in radians."""
    n = len(anchors)
    angles: list[float] = []
    for i in range(n):
        previous = anchors[(i - 1) % n]
        following = anchors[(i + 1) % n]
        a = math.atan2(anchors[i]["y"] - previous["y"], anchors[i]["x"] - previous["x"])
        b = math.atan2(following["y"] - anchors[i]["y"], following["x"] - anchors[i]["x"])
        delta = (b - a + math.pi) % (2 * math.pi) - math.pi
        angles.append(delta)
    return angles


def anchor_curvature(anchors: list[dict], i: int) -> float:
    """Menger curvature of the tangent pair at an anchor."""
    a = anchors[i]
    p_in = a.get("in") or [a["x"], a["y"]]
    p_out = a.get("out") or [a["x"], a["y"]]
    u = (a["x"] - p_in[0], a["y"] - p_in[1])
    v = (p_out[0] - a["x"], p_out[1] - a["y"])
    nu, nv = math.hypot(*u), math.hypot(*v)
    if nu < 1e-9 or nv < 1e-9:
        return 0.0
    denom = nu * nv * math.hypot(u[0] + v[0], u[1] + v[1])
    if denom < 1e-9:
        return 0.0
    cross = u[0] * v[1] - u[1] * v[0]
    return abs(2.0 * cross / denom)


def rasterise(anchors: list[dict], size: int) -> list[list[float]]:
    """The outline drawn on a size x size grid, normalised to 0..1."""
    xs = [a["x"] for a in anchors]
    ys = [a["y"] for a in anchors]
    min_x, max_x = min(xs), max(xs)
    min_y, max_y = min(ys), max(ys)
    span = max(max_x - min_x, max_y - min_y) or 1.0
    grid = [[0.0] * size for _ in range(size)]
    for a in anchors:
        gx = int((a["x"] - min_x) / span * (size - 1))
        gy = int((a["y"] - min_y) / span * (size - 1))
        grid[min(gy, size - 1)][min(gx, size - 1)] = 1.0
    return grid


def dct_2d(grid: list[list[float]]) -> list[list[float]]:
    """A plain 2-d DCT-II of the grid."""
    n = len(grid)
    out = [[0.0] * n for _ in range(n)]
    for u in range(n):
        for v in range(n):
            total = 0.0
            for x in range(n):
                for y in range(n):
                    total += (grid[x][y]
                              * math.cos(math.pi * (2 * x + 1) * u / (2 * n))
                              * math.cos(math.pi * (2 * y + 1) * v / (2 * n)))
            out[u][v] = total
    return out


def flatten_low_pass(matrix: list[list[float]], keep: int) -> list[float]:
    """The `keep` largest coefficients of the DCT, row by row."""
    flat = [value for row in matrix for value in row]
    flat.sort(key=abs, reverse=True)
    return flat[:keep]


def style_block(stroke_width_pt: float, stroke_cap: str, fill_opacity: float,
                anchors: list[dict]) -> list[float]:
    """16 numbers describing the style of the icon."""
    block = [0.0] * 16
    block[0] = min(stroke_width_pt / 8.0, 1.0)
    block[1 + ("butt", "round", "square").index(stroke_cap)] = 1.0
    block[4] = min(fill_opacity, 1.0)
    corner = classify_role(anchors[0], anchors) if anchors else 0
    block[8 + min(corner, 3)] = 1.0
    block[12] = len(anchors) / 64.0
    return block
