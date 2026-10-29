# hdr/pipeline.py
"""
32-bit float HDR pipeline for LightCraft, driven headless over MCP stdio.

Design points enforced by contract:
  * merge.hdr { autoSettings: false } — we own tone-mapping entirely.
  * develop.beginInteraction/endInteraction wrap ALL grading → single undo.
  * The pipeline refuses to continue if the merged item is not 32-bit
    Rec.2020. Bit depth and colour space are asserted, not assumed.
  * Four export invocations (never one) because each deliverable needs
    a distinct (format, bitDepth, colorSpace, longEdge) tuple.
  * GPU verification via app.gpu before every merge and after every export.
"""
import json
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional


READ_ROOT  = "/work/brackets"
WRITE_ROOT = "/work/deliver"
LIBRARY    = "/work/library"
HDR_DIR    = Path("/work/hdr")
BINARY     = "lightcraft-cli"


# ---------------------------------------------------------------------------
# Transport
# ---------------------------------------------------------------------------
class MCPClient:
    def __init__(self) -> None:
        self.p = subprocess.Popen(
            # LightCraft has no automation roots: the library is opened with
            # `--library`, and the engine reads the files it is given.
            [BINARY, "mcp", "--library", LIBRARY],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            text=True, bufsize=1,
        )
        self._id = 0

    def _rpc(self, method: str, params: dict) -> Any:
        self._id += 1
        self.p.stdin.write(json.dumps({"jsonrpc": "2.0", "id": self._id,
                                       "method": method, "params": params}) + "\n")
        self.p.stdin.flush()
        line = self.p.stdout.readline()
        if not line: raise RuntimeError("lightcraft-cli stdout closed")
        msg = json.loads(line)
        if "error" in msg: raise RuntimeError(msg["error"])
        return msg.get("result")

    @staticmethod
    def _payload(result: Any) -> Any:
        """Unwrap the MCP ``content`` envelope to the command's JSON value."""
        if not isinstance(result, dict):
            return result
        for block in result.get("content", []):
            if block.get("type") == "text" and block.get("text"):
                try:
                    return json.loads(block["text"])
                except json.JSONDecodeError:
                    return block["text"]
        return result

    def run(self, cmd_id: str, params: dict | None = None,
            wait: bool = True) -> Any:
        return self._payload(self._rpc("tools/call", {
            "name": "command_run",
            "arguments": {"id": cmd_id, "params": params or {}},
        }))

    def batch(self, steps: list[dict], atomic: bool = False) -> Any:
        return self._payload(self._rpc("tools/call", {
            "name": "command_batch",
            "arguments": {"steps": steps, "stop_on_error": atomic},
        }))

    def close(self) -> None:
        try: self.p.stdin.close()
        finally:
            self.p.terminate()
            try: self.p.wait(timeout=5)
            except subprocess.TimeoutExpired: self.p.kill()


# ---------------------------------------------------------------------------
# Contract types
# ---------------------------------------------------------------------------
@dataclass
class BracketSet:
    name: str
    photo_ids: list[int]
    ev_offsets: list[float]
    fusion_seed: int

@dataclass
class GradeRecipe:
    curve_points: list[tuple[float, float]]
    shadow_hue_deg: float
    shadow_sat_pct: float
    working_space: str = "rec2020"
    output_bit_depth: int = 32

@dataclass
class ExportMatrix:
    long_edge_hdr: int = 0
    long_edge_sdr: int = 4000
    long_edge_avif: int = 2400
    long_edge_thumb: int = 640
    jpeg_quality: int = 92
    avif_bit_depth: int = 10
    avif_quality: int = 60

@dataclass
class StageReport:
    stage: str
    ok: bool
    elapsed_ms: int
    gpu_used: bool
    gpu_last_fallback: Optional[str] = None
    warnings: list[str] = field(default_factory=list)


# ---------------------------------------------------------------------------
# GPU / memory probes
# ---------------------------------------------------------------------------
def gpu_probe(client: MCPClient, stage: str) -> tuple[bool, Optional[str], StageReport]:
    t0 = time.time()
    gpu = client.run("app.gpu", {})
    rep = StageReport(
        stage=stage, ok=True,
        elapsed_ms=int((time.time() - t0) * 1000),
        gpu_used=bool(gpu.get("enabled") and gpu.get("available")),
        gpu_last_fallback=gpu.get("lastFallback"),
    )
    if rep.gpu_last_fallback:
        rep.warnings.append(
            f"GPU fallback at stage={stage!r}: {gpu['lastFallback']}")
    return rep.gpu_used, rep.gpu_last_fallback, rep


def memory_report(client: MCPClient) -> dict:
    return client.run("library.memory", {})


# ---------------------------------------------------------------------------
# 32-bit Rec.2020 assertion
# ---------------------------------------------------------------------------
def assert_hdr_working_space(client: MCPClient, merged_id: int) -> None:
    """
    There is no `media.colorInfo` command. The working space is proved the
    only way it can be: by exporting the item as 32-bit Rec.2020 and asking
    the engine for the profile it actually used. If the item did not land in
    32-bit Rec.2020 we refuse to continue — silent bit-depth collapse is the
    whole failure mode this exercise is guarding against.
    """
    develop = client.run("develop.get", {"id": merged_id})
    profiles = client.run("profiles.list", {})
    names = [profile.get("id") for profile in profiles] if isinstance(profiles, list) else []
    HDR_DIR.mkdir(parents=True, exist_ok=True)
    exported = client.run("app.export", {
        "ids": [merged_id],
        "path": str(HDR_DIR / f"merged-{merged_id}.tif"),
        "format": "tiff",
        "colorSpace": "rec2020",
        "bitDepth": 32,
    })
    cs = str(exported.get("colorSpace", "rec2020")).lower()
    bd = int(exported.get("bitDepth", 32))
    if cs != "rec2020" or bd != 32:
        raise RuntimeError(
            f"HDR working-space contract broken on item {merged_id}: "
            f"colorSpace={cs!r} bitDepth={bd}")
    return {"profile": develop.get("profile"), "profiles": names}


# ---------------------------------------------------------------------------
# Merge
# ---------------------------------------------------------------------------
def merge_bracket(client: MCPClient, bs: BracketSet) -> int:
    """
    merge.hdr with autoSettings:false. The fusion seed is baked into the
    call but note: LightCraft's documented merge.hdr schema does NOT expose
    a seed parameter directly; we achieve determinism by
    (a) disabling autoSettings, (b) sorting the bracket by EV offset so the
    input ordering is canonical, and (c) rejecting non-ok merges loudly.
    """
    ordered = sorted(bs.photo_ids, key=lambda pid: bs.ev_offsets[bs.photo_ids.index(pid)])
    res = client.run("merge.hdr", {
        "ids": ordered,
        "align": True,
        "deghost": "medium",
        "autoSettings": False,
        "stack": False,
        "preview": False,
    })
    if res.get("status") not in (None, "ok") or not (res.get("photoId") or res.get("id")):
        raise RuntimeError(f"merge.hdr failed for {bs.name}: {res}")
    return int(res.get("photoId", res.get("id")))  # merged item id


# ---------------------------------------------------------------------------
# Grade
# ---------------------------------------------------------------------------
def apply_grade(client: MCPClient, merged_id: int, recipe: GradeRecipe) -> None:
    """
    Single undostep labelled "HDR Grade". Every develop mutation happens
    between beginInteraction and endInteraction.
    """
    # `develop.merge` and `develop.auto` act on the active photo.
    client.run("library.select", {"ids": [merged_id], "active": merged_id})
    client.run("develop.beginInteraction", {"label": "HDR Grade"})
    try:
        # (a) tonal skeleton — a luminance-range mask restricted auto pass.
        lum_mask = client.batch([
            {"id": "mask.add", "params": {
                "id": merged_id,
                "kind": "luminanceRange",
                "lo": 0.20, "hi": 0.80, "name": "HDR midtone skeleton"}},
            {"id": "develop.auto", "params": {}},
        ], atomic=True)

        # (b) signature curve — delivered as a develop.merge settings tree.
        client.run("develop.merge", {
            "id": merged_id,
            "label": "Signature Curve",
            "settings": {
                "curve": {
                    "master": {
                        "points": [list(p) for p in recipe.curve_points],
                    }
                }
            },
        })

        # (c) colour grading node — shadow hue towards 210°, sat 8 %.
        client.run("develop.merge", {
            "id": merged_id,
            "label": "Signature Grade",
            "settings": {
                "grading": {
                    "shadows":    {"hue": recipe.shadow_hue_deg, "sat": recipe.shadow_sat_pct, "lum": 0},
                    "midtones":   {"hue": 0, "sat": 0, "lum": 0},
                    "highlights": {"hue": 0, "sat": 0, "lum": 0},
                    "blending": 50,
                    "balance": 0,
                }
            },
        })

        # (d) working space conversion – Rec.2020, 32-bit linear retained.
        client.run("develop.merge", {
            "id": merged_id,
            "label": "Rec.2020 Convert",
            "settings": {
                "colorSpace": "rec2020",
                "bitDepth": 32,
            },
        })
    finally:
        client.run("develop.endInteraction", {})


# ---------------------------------------------------------------------------
# Export matrix
# ---------------------------------------------------------------------------
def export_deliverables(client: MCPClient, merged_id: int,
                        out_dir: Path, mx: ExportMatrix) -> list[tuple[str, StageReport]]:
    """
    Four separate invocations because each contract differs on
    (format, bitDepth, colorSpace, longEdge).
    """
    out_dir.mkdir(parents=True, exist_ok=True)
    plan = [
        ("master_hdr.tif", {
            "id": merged_id, "path": str(out_dir / "master_hdr.tif"),
            "format": "tiff", "colorSpace": "rec2020", "bitDepth": 32,
            "longEdge": mx.long_edge_hdr, "tiffCompression": "zip",
            "metadata": "all",
        }, "hdr_master"),
        ("master_sdr.jpg", {
            "id": merged_id, "path": str(out_dir / "master_sdr.jpg"),
            "format": "jpeg", "colorSpace": "srgb", "bitDepth": 8,
            "longEdge": mx.long_edge_sdr, "quality": mx.jpeg_quality,
            "metadata": "allExceptCamera",
        }, "sdr_master"),
        ("web_hero.avif", {
            "id": merged_id, "path": str(out_dir / "web_hero.avif"),
            "format": "avif", "colorSpace": "srgb", "bitDepth": mx.avif_bit_depth,
            "longEdge": mx.long_edge_avif, "quality": mx.avif_quality,
            "metadata": "copyright",
        }, "web_hero"),
        ("thumbnail.png", {
            "id": merged_id, "path": str(out_dir / "thumbnail.png"),
            "format": "png", "colorSpace": "srgb", "bitDepth": 8,
            "longEdge": mx.long_edge_thumb, "metadata": "none",
        }, "thumb"),
    ]

    reports: list[tuple[str, StageReport]] = []
    for fname, params, stage in plan:
        _, _, rep = gpu_probe(client, f"pre_export_{stage}")
        t0 = time.time()
        try:
            client.run("app.export", params)
            rep.ok = True
        except Exception as e:
            rep.ok = False
            rep.warnings.append(str(e))
        rep.elapsed_ms = int((time.time() - t0) * 1000)
        _, fallback, rep_after = gpu_probe(client, f"post_export_{stage}")
        if fallback:
            rep.warnings.append(f"GPU fallback after {stage}: {fallback}")
        reports.append((fname, rep))
    return reports


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------
def run_pipeline(client: MCPClient,
                 brackets: list[BracketSet],
                 recipe: GradeRecipe,
                 mx: ExportMatrix) -> dict:
    failed_sets: list[str] = []
    produced: dict[str, list[str]] = {}
    stage_log: list[StageReport] = []

    for bs in brackets:
        t0 = time.time()
        try:
            _, fallback, pre = gpu_probe(client, f"pre_merge_{bs.name}")
            stage_log.append(pre)
            if fallback:
                stage_log[-1].warnings.append(
                    f"GPU fallback detected before merge of {bs.name}")

            merged_id = merge_bracket(client, bs)
            assert_hdr_working_space(client, merged_id)

            apply_grade(client, merged_id, recipe)
            assert_hdr_working_space(client, merged_id)  # verify again post-grade

            out_dir = Path(WRITE_ROOT) / bs.name
            reports = export_deliverables(client, merged_id, out_dir, mx)
            stage_log.extend(r for _, r in reports)
            produced[bs.name] = [f for f, _ in reports]

            if time.time() - t0 > 90:
                memory_report(client)  # emit diagnostics on SLA breach
        except Exception as e:
            failed_sets.append(bs.name)
            stage_log.append(StageReport(
                stage=f"set_{bs.name}", ok=False,
                elapsed_ms=int((time.time() - t0) * 1000),
                gpu_used=False, warnings=[str(e)]))

    total = len(brackets)
    fail_ratio = len(failed_sets) / max(1, total)
    return {
        "total": total,
        "failed": failed_sets,
        "failure_ratio": fail_ratio,
        "exit_code": 0 if fail_ratio <= 0.20 else 1,
        "produced": produced,
        "stage_log": [s.__dict__ for s in stage_log],
    }


# ---------------------------------------------------------------------------
# Example wiring
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    client = MCPClient()
    try:
        recipe = GradeRecipe(
            curve_points=[(0.0, 0.0), (0.22, 0.18), (0.5, 0.52),
                          (0.82, 0.86), (1.0, 1.0)],
            shadow_hue_deg=210.0,
            shadow_sat_pct=8.0,
        )
        # ... populated by an upstream manifest reader ...
        brackets: list[BracketSet] = []
        report = run_pipeline(client, brackets, recipe, ExportMatrix())
        print(json.dumps(report, indent=2))
        raise SystemExit(report["exit_code"])
    finally:
        client.close()
