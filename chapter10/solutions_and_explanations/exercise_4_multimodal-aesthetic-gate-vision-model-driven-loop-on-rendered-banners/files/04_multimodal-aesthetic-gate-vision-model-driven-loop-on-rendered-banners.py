"""
Exercise 4: Multimodal Aesthetic Gate.

Loop contract:
  - Render the banner as base64 PNG.
  - Ask a vision model for a strict-JSON score.
  - On failure, dispatch exactly one correction.
  - Terminate on pass, no-progress, max-iterations, or timeout.
"""
from __future__ import annotations

import base64
import hashlib
import json
import os
import re
import time
from dataclasses import dataclass, field
from typing import Any, Optional
from pathlib import Path

from openai import OpenAI


# ---------------------------------------------------------------------------
# Contracts
# ---------------------------------------------------------------------------

@dataclass
class Score:
    textClipped: bool
    contrast: float
    hueDrift: float
    heroCentered: bool
    heroOffsetPx: tuple[int, int]
    rationale: str


@dataclass
class AuditIteration:
    iteration: int
    imageBase64Preview: str
    score: Optional[dict]
    correction: Optional[dict]
    elapsedMs: int


@dataclass
class AestheticAudit:
    sku: str
    variant: str
    renderer: str
    iterations: list[AuditIteration] = field(default_factory=list)
    status: str = "passed"
    finalPath: str = ""
    finalBytes: int = 0
    finalSha256: str = ""


# ---------------------------------------------------------------------------
# Vision scoring
# ---------------------------------------------------------------------------

SCORING_PROMPT = """You are auditing an e-commerce banner against four invariants.
Return ONLY a JSON object with EXACTLY these keys and no others:

{
  "textClipped":  boolean   -- any glyph is cut by the frame edge or overlapped by another element,
  "contrast":     number    -- 0..1, WCAG-style ratio normalized (split background vs. text),
  "hueDrift":     number    -- 0..1, 0 = perfect brand palette match, 1 = far off,
  "heroCentered": boolean,
  "heroOffsetPx": [signed integer, signed integer]   -- offset of the hero centroid from frame center,
  "rationale":    string, at most 240 characters, human-readable
}
"""


def _is_valid(score: dict) -> bool:
    required = {"textClipped", "contrast", "hueDrift", "heroCentered", "heroOffsetPx", "rationale"}
    if not isinstance(score, dict) or set(score.keys()) != required:
        return False
    if not isinstance(score["textClipped"], bool): return False
    if not isinstance(score["heroCentered"], bool): return False
    if not isinstance(score["contrast"], (int, float)) or not (0.0 <= score["contrast"] <= 1.0): return False
    if not isinstance(score["hueDrift"], (int, float)) or not (0.0 <= score["hueDrift"] <= 1.0): return False
    off = score["heroOffsetPx"]
    if (not isinstance(off, list) or len(off) != 2
            or not all(isinstance(n, (int, float)) for n in off)):
        return False
    if not isinstance(score["rationale"], str) or len(score["rationale"]) > 240:
        return False
    return True


def score_render(llm: OpenAI, png_b64: str) -> Optional[dict]:
    """Return a validated score dict, or None if the model's response is malformed."""
    try:
        resp = llm.chat.completions.create(
            model="gpt-4o",
            messages=[{
                "role": "user",
                "content": [
                    {"type": "text", "text": SCORING_PROMPT},
                    {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{png_b64}"}},
                ],
            }],
            response_format={"type": "json_object"},
        )
        payload = json.loads(resp.choices[0].message.content)
        return payload if _is_valid(payload) else None
    except Exception:
        return None


# ---------------------------------------------------------------------------
# Correction selector (exactly one command per iteration)
# ---------------------------------------------------------------------------

def select_correction(score: dict, ctx: dict) -> Optional[dict]:
    """Pick exactly one corrective command according to the defined priority."""
    if score["textClipped"]:
        return {
            "id": "type.setStyle",
            "params": {
                "layer": ctx["headlineLayerId"],
                "size": max(12, ctx["headlineSize"] - 4),
                "leading": ctx["headlineLeading"],
            },
        }
    if score["contrast"] < 0.45:
        return {
            "id": "layer.newAdjustmentLayer.curves",
            "params": {"points": [[0, 0], [64, 48], [192, 208], [255, 255]]},
        }
    if score["hueDrift"] > 0.15:
        # Clamp the hue delta so we never over-swing in a single step.
        delta = int(max(-12, min(12, round(score["hueDrift"] * 40))))
        return {
            "id": "image.adjustments.hueSaturation",
            "params": {"hue": delta, "saturation": 5},
        }
    if not score["heroCentered"]:
        dx, dy = score["heroOffsetPx"]
        return {
            "id": "layer.translate",
            "params": {"layer": ctx["heroLayerId"], "dx": -int(dx), "dy": -int(dy)},
        }
    return None  # nothing to correct


def normalize_rationale(s: str) -> str:
    """Whitespace collapsed, trailing punctuation stripped - used for oscillation detection."""
    return re.sub(r"[.!?;,\s]+$", "", re.sub(r"\s+", " ", s.strip()))


# ---------------------------------------------------------------------------
# Main loop
# ---------------------------------------------------------------------------

def run_loop(sku: str, variant: str, renderer: str, llm: OpenAI,
             runtime: Any = None) -> AestheticAudit:
    audit = AestheticAudit(sku=sku, variant=variant, renderer=renderer)
    runtime = runtime or _DefaultRuntime()
    total_budget_s = 45.0
    start = time.monotonic()

    ctx = runtime.context()  # {headlineLayerId, headlineSize, ...}
    last_rationale: Optional[str] = None
    last_good_b64: Optional[str] = None
    last_good_score: Optional[dict] = None
    last_render_b64: Optional[str] = None
    failed_iterations = 0

    for iteration in range(1, 4):  # max 3 iterations
        elapsed_s = time.monotonic() - start
        if elapsed_s > total_budget_s:
            audit.status = "timed-out"
            break

        triad_start = time.monotonic()
        render_b64 = runtime.render()                   # MCP doc_render_preview
        last_render_b64 = render_b64
        score = score_render(llm, render_b64)           # may be None (malformed)
        correction = None
        if score is not None:
            correction = select_correction(score, ctx)
        triad_ms = int((time.monotonic() - triad_start) * 1000)

        audit.iterations.append(AuditIteration(
            iteration=iteration,
            imageBase64Preview=render_b64[:200],
            score=score,
            correction=correction,
            elapsedMs=triad_ms,
        ))

        # A malformed response counts against the iteration budget but does not
        # drive a correction.
        if score is None:
            failed_iterations += 1
            if failed_iterations >= 2:
                audit.status = "max-iterations"
                break
            continue

        # If nothing to correct, we are done.
        if correction is None:
            last_good_b64 = render_b64
            last_good_score = score
            audit.status = "passed"
            break

        # Anti-oscillation: identical normalized rationale means we did not move the needle.
        norm = normalize_rationale(score["rationale"])
        if last_rationale is not None and norm == last_rationale:
            audit.status = "no-progress"
            break
        last_rationale = norm

        # Apply exactly one correction via MCP command_run.
        runtime.apply(correction)

    else:
        audit.status = "max-iterations"

    # Persist the final graded artifact – the last passing render if any,
    # otherwise the most recent render even if it failed.
    final_b64 = last_good_b64 or last_render_b64 or ""
    final_bytes = base64.b64decode(final_b64) if final_b64 else b""
    path, size, digest = runtime.finish(audit, final_b64)
    audit.finalPath = path
    audit.finalBytes = size
    audit.finalSha256 = digest

    _write_sidecar(audit)
    return audit


# ---------------------------------------------------------------------------
# Renderer-agnostic MCP stubs (real implementations call through stdio MCP)
# ---------------------------------------------------------------------------

class _DefaultRuntime:
    """The book's wiring example: real MCP calls replace these methods."""

    def context(self) -> dict:
        return _bootstrap_context("photocraft")

    def render(self) -> str:
        return _render_banner("photocraft")

    def apply(self, correction: dict) -> None:
        _apply_command("photocraft", correction)

    def finish(self, audit: "AestheticAudit", final_b64: str) -> tuple[str, int, str]:
        data = base64.b64decode(final_b64) if final_b64 else b""
        path = f"{audit.sku}_{audit.variant}_graded.png"
        with open(path, "wb") as handle:
            handle.write(data)
        return path, len(data), hashlib.sha256(data).hexdigest()


def _bootstrap_context(renderer: str) -> dict:
    """Read layer ids and initial sizes from the running engine."""
    # In the real system this returns doc_inspect results for the target doc.
    return {"headlineLayerId": 3, "headlineSize": 56, "headlineLeading": 64, "heroLayerId": 2}


def _render_banner(renderer: str) -> str:
    """Return base64 PNG of the current banner state."""
    if renderer == "photocraft":
        # client.call_tool("doc_render_preview", {"max_side": 1024})
        return _mock_render()
    if renderer == "designcraft":
        # client.call_tool("render_page", {"page": 1, "scale": 1})
        return _mock_render()
    raise ValueError(f"unknown renderer {renderer}")


def _apply_command(renderer: str, correction: dict) -> None:
    """Dispatch the correction via command_run on the target engine."""
    # client.call_tool("command_run", {"id": correction["id"], "params": correction["params"]})
    pass


def _mock_render() -> str:
    return base64.b64encode(b"mock-png-bytes").decode()


def _write_sidecar(audit: AestheticAudit) -> None:
    data = {
        "sku": audit.sku,
        "variant": audit.variant,
        "renderer": audit.renderer,
        "iterations": [
            {
                "iteration": it.iteration,
                "imageBase64Preview": it.imageBase64Preview,
                "score": it.score,
                "correction": it.correction,
                "elapsedMs": it.elapsedMs,
            }
            for it in audit.iterations
        ],
        "status": audit.status,
        "finalPath": audit.finalPath,
        "finalBytes": audit.finalBytes,
        "finalSha256": audit.finalSha256,
    }
    target_dir = Path(audit.finalPath).parent if audit.finalPath else Path(".")
    target_dir.mkdir(parents=True, exist_ok=True)
    with open(target_dir / f"{audit.sku}_{audit.variant}_audit.json", "w") as f:
        json.dump(data, f, sort_keys=True, indent=2)


# ---------------------------------------------------------------------------
# Entry
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    llm = OpenAI()
    result = run_loop(sku="SKU-1234", variant="1:1-en-US", renderer="photocraft", llm=llm)
    print(json.dumps({"status": result.status, "finalSha256": result.finalSha256}))
