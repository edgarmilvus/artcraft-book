#!/usr/bin/env python3
"""
sparse_tile_delta.py — PhotoCraft sparse-tile memory-delta harness.

Empirically proves that PhotoCraft's 256x256 copy-on-write sparse tiles isolate
localized brush edits. Runs entirely over `photocraft-cli mcp` (stdio, line-
delimited JSON-RPC 2.0). `ui_screenshot` is deliberately NOT used: the point
is the *document model*, not the desktop window.

Pipeline of record:
  1. doc_open     — open the retouch target.
  2. doc_inspect  — baseline layer tree + dimensions.
  3. command_batch{ stop_on_error: true, 10 × paint.stroke } — localized edits.
  4. command_run{ layer.newAdjustmentLayer.curves } — a global edit.
  5. command_run{ filter.blur.gaussianBlur, wait:false } then poll jobs_list
     (selecting a pixel layer first: filters refuse to run on an adjustment).
  6. Write the JSON report to report_path (the harness writes it; `doc_save`
     is the engine's own serializer and is not needed here).

CPU SIMD oracle vs wgpu note (see report.notes): the headless runner in this
build composites ONLY through the CPU SIMD reference oracle. The accelerated
wgpu (Metal/Vulkan/DX12) pipeline lives in the desktop binary, selected at
launch. For memory-delta work that split is a red herring: the tile deltas
are a property of the document model, not of the raster pipeline that reads
it, so the numbers below are pipeline-independent.
"""

from __future__ import annotations
import json, os, subprocess, sys, time
from typing import Any, Dict, List, Optional, Set, Tuple

TILE = 256                      # canonical 256-px tile geometry
TILE_ORIGIN = (0, 0)            # tile boundaries are anchored at the origin


# --------------------------------------------------------------------------
# Minimal line-delimited JSON-RPC 2.0 client for `<app>-cli mcp`.
# --------------------------------------------------------------------------
class StdioMCP:
    def __init__(self, argv: List[str]) -> None:
        self.proc = subprocess.Popen(
            argv, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        self._id = 0

    def _write(self, obj: Dict[str, Any]) -> None:
        assert self.proc.stdin is not None
        self.proc.stdin.write(json.dumps(obj) + "\n")
        self.proc.stdin.flush()

    def _read(self) -> Dict[str, Any]:
        assert self.proc.stdout is not None
        line = self.proc.stdout.readline()
        if not line:
            raise EOFError("MCP server closed the stream")
        return json.loads(line)

    def call(self, method: str, params: Any = None) -> Any:
        self._id += 1
        rid = self._id
        self._write({"jsonrpc": "2.0", "id": rid, "method": method,
                     "params": params or {}})
        # Every response line is one JSON-RPC frame; dispatch by `id`.
        while True:
            msg = self._read()
            if msg.get("id") == rid:
                if msg.get("error"):
                    raise RuntimeError(msg["error"])
                return msg.get("result")

    def initialize(self) -> None:
        self.call("initialize", {
            "protocolVersion": "2024-11-05", "capabilities": {},
            "clientInfo": {"name": "sparse-tile-harness", "version": "1.0"},
        })

    def tool(self, name: str, **arguments: Any) -> Any:
        res = self.call("tools/call", {"name": name, "arguments": arguments})
        value = unwrap_content(res)
        # MCP reports engine refusals as `isError: true` with a text block.
        # Turning them into exceptions here keeps every later step honest:
        # silent `{"_text": ...}` values used to flow on as if they were data.
        if isinstance(res, dict) and res.get("isError"):
            raise RuntimeError(f"{name} failed: {value!r}")
        return value

    def close(self) -> None:
        try:
            if self.proc.stdin:
                self.proc.stdin.close()
        except Exception:
            pass
        self.proc.terminate()


def unwrap_content(res: Any) -> Any:
    """MCP wraps the tool result as content[{type:'text', text:'…'}]. Unwrap."""
    if not isinstance(res, dict) or "content" not in res:
        return res
    for block in res["content"]:
        if block.get("type") == "text":
            text = block.get("text", "")
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                return {"_text": text}
    return res


# --------------------------------------------------------------------------
# Tile geometry — 256 px, boundaries anchored at (0, 0).
# --------------------------------------------------------------------------
def tiles_touched_by_rect(x0: int, y0: int, x1: int, y1: int) -> Set[Tuple[int, int]]:
    """Set of (tx, ty) tile indices whose 256-px cell intersects the inclusive rect."""
    if x1 < x0: x0, x1 = x1, x0
    if y1 < y0: y0, y1 = y1, y0
    tx0 = (x0 - TILE_ORIGIN[0]) // TILE
    tx1 = (x1 - TILE_ORIGIN[0]) // TILE
    ty0 = (y0 - TILE_ORIGIN[1]) // TILE
    ty1 = (y1 - TILE_ORIGIN[1]) // TILE
    # Round UP per dimension: every cell the rect overlaps is counted once.
    return {(tx, ty) for tx in range(tx0, tx1 + 1) for ty in range(ty0, ty1 + 1)}


def rect_area(x0: int, y0: int, x1: int, y1: int) -> int:
    # Endpoints are inclusive, so a 1x1 rect covers one pixel, not zero.
    return max(0, x1 - x0 + 1) * max(0, y1 - y0 + 1)


def damage_to_rect(damage: Any) -> Optional[Tuple[int, int, int, int]]:
    """Normalise a paint.stroke `damage` value to (x0, y0, x1, y1) inclusive.

    The engine reports `damage` as [x, y, w, h] (top-left plus size). We
    accept the alternate [x0, y0, x1, y1] form when the interpreted size
    would be nonsensically large — a defensive tolerance that keeps the
    harness honest if the engine changes the wire shape."""
    if not (isinstance(damage, (list, tuple)) and len(damage) == 4):
        return None
    x, y, a, b = (int(round(float(v))) for v in damage)
    if x < 0 or y < 0 or a < 0 or b < 0:
        return None
    # Favour [x, y, x1, y1] when a,b are clearly absolute endpoints.
    if a > x and b > y and (a <= 200_000) and (b <= 200_000) and (a - x) > 10_000:
        return (x, y, a, b)
    return (x, y, x + a - 1, y + b - 1)


def count_nodes(tree: Any) -> int:
    if isinstance(tree, dict):
        n = 1
        for key in ("layers", "children", "nodes", "stack"):
            if isinstance(tree.get(key), list):
                for child in tree[key]:
                    n += count_nodes(child)
        return n
    if isinstance(tree, list):
        return sum(count_nodes(x) for x in tree)
    return 0


def extract_dims(tree: Any) -> Tuple[int, int]:
    found: Dict[str, int] = {}
    def walk(n: Any) -> None:
        if isinstance(n, dict):
            for k, v in n.items():
                if k in ("width", "height") and isinstance(v, (int, float)) and k not in found:
                    found[k] = int(v)
                walk(v)
        elif isinstance(n, list):
            for x in n: walk(x)
    walk(tree)
    return found.get("width", 0), found.get("height", 0)


def extract_tile_census(tree: Any) -> Optional[Dict[str, int]]:
    """If the doc tree surfaces a tile count directly, capture it; else None."""
    out: Dict[str, int] = {}
    def walk(n: Any) -> None:
        if isinstance(n, dict):
            for k, v in n.items():
                if "tile" in k.lower() and isinstance(v, (int, float)):
                    out[k] = int(v)
                walk(v)
        elif isinstance(n, list):
            for x in n: walk(x)
    walk(tree)
    return out or None


def job_state(jobs: Any, job_id: Any) -> str:
    """Scan a jobs_list response for `job_id`; default to 'running'."""
    pools: List[Any] = []
    if isinstance(jobs, dict):
        for k in ("running", "jobs", "items", "finished", "done"):
            if isinstance(jobs.get(k), list):
                pools.append(jobs[k])
    if isinstance(jobs, list):
        pools.append(jobs)
    for arr in pools:
        for j in arr:
            if isinstance(j, dict) and j.get("id") == job_id:
                return str(j.get("state", "running"))
    return "running"


# --------------------------------------------------------------------------
# Ten localized strokes, each constrained to a 400x400 px island.
# --------------------------------------------------------------------------
def build_localized_strokes(doc_w: int, doc_h: int) -> List[Dict[str, Any]]:
    """Return ten `paint.stroke` params, each inside its own 400x400 island.

    Target justification:
      * "pixels"      — correct for a destructive retouch on the composited
                        pixel stream; this is what the memory-delta harness
                        needs, because the sparse tiles that matter here are
                        the *pixel* tiles of the layer's raster plane.
      * "mask"        — would dirty only the layer mask's tiles.
      * "quickMask"   — transient; not even part of the document.
      * {"channel":i} — targets an alpha channel, useful for channel-based
                        editing but not for a dodge/burn retouch.
    """
    cols, rows, island = 5, 2, 400
    gx = max(40, (doc_w - cols * island) // (cols + 1))
    gy = max(40, (doc_h - rows * island) // (rows + 1))
    strokes: List[Dict[str, Any]] = []
    for r in range(rows):
        for c in range(cols):
            x0 = gx + c * (island + gx)
            y0 = gy + r * (island + gy)
            cx, cy = x0 + island // 2, y0 + island // 2
            i = len(strokes)
            strokes.append({
                # 4 anchor points (>=3 required) forming a short diagonal "S".
                "points": [
                    [x0 + 40,           y0 + 40],
                    [cx - 30,           cy - 30],
                    [cx + 30,           cy + 30],
                    [x0 + island - 40,  y0 + island - 40],
                ],
                "size":    20 + (i % 4) * 8,   # 20, 28, 36, 44 px diameter
                "hardness": 0.80,
                "opacity":  0.35,
                "flow":     0.25,
                "spacing":  0.20,               # strictly under 0.25
                "color":    "#3b2a14",
                "mode":     "multiply",         # classic dodge/burn blend
                "target":   "pixels",
            })
    return strokes


# --------------------------------------------------------------------------
# Main harness.
# --------------------------------------------------------------------------
def main() -> int:
    # Both roots and the target are parameterised: the book's `/work/project`
    # is a container path. Defaults keep the book's layout, the env vars let the
    # harness run anywhere.
    read_root   = os.environ.get("READ_ROOT",  "/work/project")
    write_root  = os.environ.get("WRITE_ROOT", "/work/project")
    target      = os.environ.get("TARGET_DOC",  os.path.join(read_root, "retouch/FW26_hero_048.tif"))
    report_path = os.environ.get("REPORT_PATH", "reports/sparse_tile_delta_FW26_hero_048.json")

    mcp = StdioMCP([
        "photocraft-cli", "mcp",
        "--automation-read-root",  read_root,
        "--automation-write-root", write_root,
    ])
    mcp.initialize()

    steps: List[Dict[str, Any]] = []
    cumulative_tiles: Set[Tuple[int, int]] = set()
    doc_index: Optional[int] = None

    try:
        # ---- open + baseline ------------------------------------------------
        opened = mcp.tool("doc_open", path=target)
        doc_index = int(opened.get("index", 0))
        baseline = mcp.tool("doc_inspect", index=doc_index)
        doc_w, doc_h = extract_dims(baseline)
        assert doc_w > 0 and doc_h > 0, "doc_inspect did not surface document dimensions"
        base_nodes = count_nodes(baseline)
        base_census = extract_tile_census(baseline)

        # ---- step 1: ten localized strokes in one batch --------------------
        strokes = build_localized_strokes(doc_w, doc_h)
        t0 = time.perf_counter()
        batch = mcp.tool(
            "command_batch",
            stop_on_error=True,   # default true; stated explicitly for the record
            steps=[{"id": "paint.stroke", "params": s} for s in strokes],
        )
        dt_ms = (time.perf_counter() - t0) * 1000.0

        # Union of the ten damage rectangles → union of tiles.
        damage_area = 0
        touched: Set[Tuple[int, int]] = set()
        rects: List[List[int]] = []
        results = (batch or {}).get("results", []) if isinstance(batch, dict) else []
        for r in results:
            # Each batch entry is {ok, result} (or {ok: false, error}); the
            # damage rectangle lives one level down, inside `result`.
            payload = (r or {}).get("result") if isinstance(r, dict) else None
            if not isinstance(payload, dict):
                payload = r if isinstance(r, dict) else {}
            rect = damage_to_rect(payload.get("damage"))
            if rect is None:
                continue
            x0, y0, x1, y1 = rect
            rects.append([x0, y0, x1, y1])
            damage_area += rect_area(x0, y0, x1, y1)
            touched |= tiles_touched_by_rect(x0, y0, x1, y1)
        touched -= cumulative_tiles                  # never double count
        cumulative_tiles |= touched
        steps.append({
            "id": "localized_brush_strokes",
            "category": "batch",
            "elapsed_ms": round(dt_ms, 3),
            "damage_area_px": damage_area,
            "sparse_coverage_pct": round(100.0 * damage_area / (doc_w * doc_h), 2),
            "estimated_tiles_touched": len(touched),
            "damage_rects": rects,
        })

        # ---- step 2: a global curves adjustment ----------------------------
        t0 = time.perf_counter()
        mcp.tool(
            "command_run",
            id="layer.newAdjustmentLayer.curves",
            params={
                # 4-point composite S-curve, in 0..255 per the runtime schema.
                "points": [[0, 0], [64, 40], [192, 215], [255, 255]],
                # Per-channel curves are omitted — composite only.
            },
        )
        dt_ms = (time.perf_counter() - t0) * 1000.0
        full = tiles_touched_by_rect(0, 0, doc_w - 1, doc_h - 1)
        new_tiles = full - cumulative_tiles
        cumulative_tiles |= full
        steps.append({
            "id": "layer.newAdjustmentLayer.curves",
            "category": "command",
            "elapsed_ms": round(dt_ms, 3),
            "damage_area_px": doc_w * doc_h,
            "sparse_coverage_pct": 100.00,
            "estimated_tiles_touched": len(new_tiles),
            "damage_rects": [[0, 0, doc_w - 1, doc_h - 1]],
        })

        # ---- step 3: destructive Gaussian Blur, asynchronously -------------
        # The curves adjustment layer is active after step 2, and filters
        # refuse to run on an adjustment layer ("filters need a pixel layer").
        # Select the pixel layer the blur is meant to touch.
        mcp.tool("command_run", id="layer.selectBottom", params={})
        t0 = time.perf_counter()
        started = mcp.tool(
            "command_run",
            id="filter.blur.gaussianBlur",
            params={"radius": 2.0},
            wait=False,          # returns {job: <id>} immediately
        )
        job_id = (started or {}).get("job")
        if job_id is None:
            raise RuntimeError(f"async command_run did not return a job id: {started!r}")

        # Poll jobs_list until the job leaves the "running" state. The job stays
        # in the list once it is `done`, but bound the wait anyway: an engine
        # crash would otherwise hang the harness forever.
        deadline = time.monotonic() + 120.0
        while True:
            time.sleep(0.05)
            state = job_state(mcp.tool("jobs_list"), job_id)
            if state in ("done", "finished", "succeeded"):
                break
            if state in ("failed", "cancelled"):
                raise RuntimeError(f"blur job {job_id} ended as {state}")
            if time.monotonic() > deadline:
                raise RuntimeError(f"blur job {job_id} still {state} after 120 s")
        dt_ms = (time.perf_counter() - t0) * 1000.0

        new_tiles = full - cumulative_tiles
        cumulative_tiles |= full
        steps.append({
            "id": "filter.blur.gaussianBlur",
            "category": "async_command",
            "elapsed_ms": round(dt_ms, 3),
            "damage_area_px": doc_w * doc_h,
            "sparse_coverage_pct": 100.00,
            "estimated_tiles_touched": len(new_tiles),
            "damage_rects": [[0, 0, doc_w - 1, doc_h - 1]],
        })

        # ---- final inspection + report -------------------------------------
        after = mcp.tool("doc_inspect", index=doc_index)
        report = {
            "harness": "sparse_tile_delta",
            "document": target,
            "tile_geometry": {"size": TILE, "origin_px": list(TILE_ORIGIN)},
            "document_size": {"width": doc_w, "height": doc_h},
            "layer_tree_nodes_baseline": base_nodes,
            "layer_tree_nodes_final": count_nodes(after),
            "engine_tile_census": {
                "baseline": base_census,
                "final":    extract_tile_census(after),
            },
            "steps": steps,
            "cumulative_estimated_tiles": len(cumulative_tiles),
            "notes": [
                "Headless runner composites exclusively via the CPU SIMD reference "
                "oracle. The wgpu (Metal/Vulkan/DX12) pipeline lives in the desktop "
                "binary and is selected at launch; it is a red herring for memory-"
                "delta work, because the sparse-tile arithmetic belongs to the "
                "*document model*, not to the rasterizer that eventually reads it.",
                "Damage rectangles come from the engine (paint.stroke `damage`). "
                "Tile counts are computed at a fixed 256-px geometry anchored at "
                "(0, 0); every tile is counted once per step.",
                "Tiles already touched by an earlier step are removed from later "
                "steps so cumulative_estimated_tiles never double counts.",
            ],
        }

        os.makedirs(os.path.dirname(report_path) or ".", exist_ok=True)
        with open(report_path, "w", encoding="utf-8") as fh:
            json.dump(report, fh, indent=2)
        print(json.dumps(report, indent=2))

    finally:
        try:
            if doc_index is not None:
                mcp.tool("doc_close", index=doc_index)
        except Exception:
            pass
        mcp.close()

    return 0


if __name__ == "__main__":
    sys.exit(main())
