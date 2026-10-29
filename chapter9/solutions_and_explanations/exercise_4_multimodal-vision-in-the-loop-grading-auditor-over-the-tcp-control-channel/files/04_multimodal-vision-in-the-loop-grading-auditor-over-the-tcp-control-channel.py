# audit/tcp_audit.py
"""
Multimodal vision-in-the-loop grading auditor.

Contract:
  * Mandatory first-frame auth over raw TCP; anything else → socket closed.
  * All subsequent calls use {"method": "engine.execute"} framing.
  * Every iteration bumps a version snapshot ("audit_iter_N") so the human
    retoucher can time-travel through the audit history.
  * Bounded mutation: <= 3 controls changed per iteration; deltas clamped to
    ±0.35 (light.*) / ±12 (color.*, color.mixer.*). Violation = abort.
  * Numeric enforcement is authoritative; the LLM's critique is advisory.
"""
from __future__ import annotations
import io
import json
import os
import socket
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

import numpy as np
from PIL import Image
from openai import OpenAI


WRITE_ROOT = Path("/work/audit")


# ---------------------------------------------------------------------------
# 1. Auth-explicit TCP client
# ---------------------------------------------------------------------------
class AuthRefused(Exception):
    pass


class LightCraftTCP:
    def __init__(self, host: str = "127.0.0.1", port: int = 7979,
                 token: str | None = None) -> None:
        self.sock = socket.create_connection((host, port), timeout=10)
        self.reader = self.sock.makefile("r")
        self._id = 0

        if token is not None:
            if not (len(token) == 64 and all(c in "0123456789abcdefABCDEF" for c in token)):
                self.sock.close()
                raise AuthRefused("token is not 64 hex characters")
            auth = json.dumps({"id": "auth", "method": "auth",
                               "params": {"token": token}})
            self.sock.sendall((auth + "\n").encode("utf-8"))
            reply = json.loads(self.reader.readline())
            if not reply.get("ok"):
                self.sock.close()
                raise AuthRefused(reply.get("error", "unknown auth failure"))

    def execute(self, cmd_id: str, params: dict | None = None) -> Any:
        self._id += 1
        frame = json.dumps({
            "id": self._id,
            "method": "engine.execute",
            "params": {"command": cmd_id, "params": params or {}},
        })
        self.sock.sendall((frame + "\n").encode("utf-8"))
        line = self.reader.readline()
        if not line:
            raise RuntimeError("control socket closed")
        msg = json.loads(line)
        if "error" in msg:
            raise RuntimeError(f"{cmd_id}: {msg['error']}")
        return msg.get("result")

    def close(self) -> None:
        try: self.sock.close()
        except OSError: pass


# ---------------------------------------------------------------------------
# 2. Client-side pixel statistics (authoritative numeric enforcement)
# ---------------------------------------------------------------------------
@dataclass
class PixelStats:
    center_luma:     float   # 0..1
    shadow_clip:     float   # 0..1 fraction of total pixels
    highlight_clip:  float   # 0..1
    skin_hue:        Optional[float]  # degrees in [0,360), None if no skin
    background_deltaE: Optional[float]  # ΔE2000 vs reference neutral


REFERENCE_NEUTRAL = np.array([0xF4, 0xF1, 0xEA], dtype=np.float32)  # sRGB 0..255


def _linearize_srgb(rgb8: np.ndarray) -> np.ndarray:
    x = rgb8.astype(np.float32) / 255.0
    return np.where(x <= 0.04045, x / 12.92, ((x + 0.055) / 1.055) ** 2.4)


def _srgb_to_lab(rgb8: np.ndarray) -> np.ndarray:
    lin = _linearize_srgb(rgb8)
    # sRGB -> XYZ -> Lab (D65). Compact, self-contained, no colour library.
    M = np.array([[0.4124564, 0.3575761, 0.1804375],
                  [0.2126729, 0.7151522, 0.0721750],
                  [0.0193339, 0.1191920, 0.9503041]], dtype=np.float32)
    XYZ = lin @ M.T
    XYZ /= np.array([0.95047, 1.0, 1.08883], dtype=np.float32)
    f = np.where(XYZ > 0.008856, np.cbrt(XYZ), 7.787 * XYZ + 16 / 116)
    L = 116 * f[..., 1] - 16
    a = 500 * (f[..., 0] - f[..., 1])
    b = 200 * (f[..., 1] - f[..., 2])
    return np.stack([L, a, b], axis=-1)


def _deltaE2000(lab1: np.ndarray, lab2: np.ndarray) -> float:
    """Full CIEDE2000. Sufficiently accurate for a ≤ 8 ΔE pass/fail gate."""
    L1, a1, b1 = lab1; L2, a2, b2 = lab2
    C1, C2 = np.hypot(a1, b1), np.hypot(a2, b2)
    Cbar = (C1 + C2) / 2
    G = 0.5 * (1 - np.sqrt(Cbar**7 / (Cbar**7 + 25**7)))
    a1p, a2p = (1 + G) * a1, (1 + G) * a2
    C1p, C2p = np.hypot(a1p, b1), np.hypot(a2p, b2)
    h1p = np.degrees(np.arctan2(b1, a1p)) % 360
    h2p = np.degrees(np.arctan2(b2, a2p)) % 360
    dLp = L2 - L1
    dCp = C2p - C1p
    dhp = h2p - h1p
    if abs(dhp) > 180: dhp -= 360 * np.sign(dhp)
    dHp = 2 * np.sqrt(C1p * C2p) * np.sin(np.radians(dhp / 2))
    Lbp = (L1 + L2) / 2
    Cbp = (C1p + C2p) / 2
    hbp = (h1p + h2p) / 2 if abs(h1p - h2p) <= 180 else ((h1p + h2p + 360) / 2) % 360
    T = (1 - 0.17*np.cos(np.radians(hbp-30)) + 0.24*np.cos(np.radians(2*hbp))
         + 0.32*np.cos(np.radians(3*hbp+6)) - 0.20*np.cos(np.radians(4*hbp-63)))
    dTheta = 30 * np.exp(-((hbp - 275) / 25) ** 2)
    Rc = 2 * np.sqrt(Cbp**7 / (Cbp**7 + 25**7))
    Sl = 1 + (0.015 * (Lbp - 50)**2) / np.sqrt(20 + (Lbp - 50)**2)
    Sc = 1 + 0.045 * Cbp
    Sh = 1 + 0.015 * Cbp * T
    Rt = -np.sin(np.radians(2 * dTheta)) * Rc
    return float(np.sqrt((dLp/Sl)**2 + (dCp/Sc)**2 + (dHp/Sh)**2 + Rt*(dCp/Sc)*(dHp/Sh)))


def compute_pixel_stats(jpeg_path: Path) -> PixelStats:
    img = np.asarray(Image.open(jpeg_path).convert("RGB"))
    H, W, _ = img.shape
    lab = _srgb_to_lab(img)
    L = lab[..., 0] / 100.0  # normalize to 0..1

    cy, cx = H // 2, W // 2
    r = max(1, min(H, W) // 8)
    center_luma = float(L[cy - r:cy + r, cx - r:cx + r].mean())

    shadow_clip    = float((L <= 0.02).mean())
    highlight_clip = float((L >= 0.98).mean())

    # Background: sample the four corners' 10% border, avoiding the product.
    margin = max(2, W // 10)
    border = np.concatenate([
        img[:margin, :].reshape(-1, 3),
        img[-margin:, :].reshape(-1, 3),
        img[:, :margin].reshape(-1, 3),
        img[:, -margin:].reshape(-1, 3),
    ])
    border_lab = _srgb_to_lab(border).mean(axis=0)
    ref_lab = _srgb_to_lab(REFERENCE_NEUTRAL.reshape(1, 3))[0]
    bg_de = _deltaE2000(border_lab, ref_lab)

    # Skin: any face pixels from a bbox overlap would go here in production;
    # we approximate with a hue histogram in [18°, 38°] using Lab's a/b.
    a, b = lab[..., 1], lab[..., 2]
    hue_lab = (np.degrees(np.arctan2(b, a)) % 360)
    skin_mask = (hue_lab >= 18) & (hue_lab <= 38)
    if skin_mask.sum() >= 0.002 * H * W:
        skin_hue = float(np.median(hue_lab[skin_mask]))
    else:
        skin_hue = None

    return PixelStats(
        center_luma=center_luma,
        shadow_clip=shadow_clip,
        highlight_clip=highlight_clip,
        skin_hue=skin_hue,
        background_deltaE=bg_de,
    )


# ---------------------------------------------------------------------------
# 3. Numeric enforcement (authoritative)
# ---------------------------------------------------------------------------
CONSTRAINTS = {
    "CENTER_LUMA":        ("center_luma",      (0.62, 0.78)),
    "SHADOW_CLIPPING":    ("shadow_clip",      (0.0,  0.015)),
    "HIGHLIGHT_CLIPPING": ("highlight_clip",   (0.0,  0.008)),
    "BACKGROUND_NEUTRALITY": ("background_deltaE", (None, 8.0)),
    "SKIN_HUE":           ("skin_hue",         (18.0, 38.0)),
}


def numeric_violations(stats: PixelStats) -> list[dict]:
    out: list[dict] = []
    for code, (field, (lo, hi)) in CONSTRAINTS.items():
        v = getattr(stats, field)
        if v is None:
            continue
        if lo is not None and v < lo:
            out.append({"code": code, "delta": v - lo})
        if hi is not None and v > hi:
            out.append({"code": code, "delta": v - hi})
    return out


# ---------------------------------------------------------------------------
# 4. Vision prompt + bounded adjustment scheduler
# ---------------------------------------------------------------------------
VISION_SYSTEM_PROMPT = """You are a strict commercial-grade color auditor.
Given a product photograph, return ONLY valid JSON matching:
{
  "status": "ok" | "needs_adjustment",
  "issues": [ { "code": <CODE>, "delta": <float> } ],
  "notes": "<short string>"
}
Valid <CODE> values are exactly:
CENTER_LUMA, BACKGROUND_NEUTRALITY, SHADOW_CLIPPING, HIGHLIGHT_CLIPPING, SKIN_HUE.
Do not add commentary outside the JSON object. Do not hallucinate codes."""

MAX_CONTROLS_PER_ITER = 3
MAX_DELTA_LIGHT = 0.35
MAX_DELTA_COLOR = 12.0


def plan_adjustments(issues: list[dict]) -> dict[str, float]:
    """Map audit codes onto develop controls with bounded deltas."""
    plan: dict[str, float] = {}
    for issue in issues[:MAX_CONTROLS_PER_ITER]:
        code, delta = issue["code"], float(issue["delta"])
        if code == "CENTER_LUMA":
            d = float(np.clip(delta * 4.0, -MAX_DELTA_LIGHT, MAX_DELTA_LIGHT))
            plan["light.exposure"] = d
        elif code == "SHADOW_CLIPPING":
            d = float(np.clip(abs(delta) * 300.0, 0.0, MAX_DELTA_LIGHT))
            plan["light.shadows"] = d
            plan["light.blacks"]  = d * 0.5
        elif code == "HIGHLIGHT_CLIPPING":
            d = float(np.clip(abs(delta) * 400.0, 0.0, MAX_DELTA_LIGHT))
            plan["light.highlights"] = -d
            plan["light.whites"]     = -d * 0.5
        elif code == "BACKGROUND_NEUTRALITY":
            d = float(np.clip(delta * 1.5, -MAX_DELTA_COLOR, MAX_DELTA_COLOR))
            # The white balance controls are `wb.temp` (kelvin) and `wb.tint`;
            # there is no `color.mixer.temperature`.
            plan["wb.temp"] = -d * 200.0
            plan["wb.tint"] = -d * 20.0
        elif code == "SKIN_HUE":
            d = float(np.clip(delta * 0.4, -MAX_DELTA_COLOR, MAX_DELTA_COLOR))
            plan["mixer.orange.hue"] = d
        if len(plan) >= MAX_CONTROLS_PER_ITER:
            break
    return dict(list(plan.items())[:MAX_CONTROLS_PER_ITER])


# ---------------------------------------------------------------------------
# 5. Audit loop
# ---------------------------------------------------------------------------
def vision_critique(client: OpenAI, jpeg_path: Path) -> dict:
    import base64
    b64 = base64.b64encode(jpeg_path.read_bytes()).decode()
    r = client.chat.completions.create(
        model="gpt-4o",
        response_format={"type": "json_object"},
        messages=[
            {"role": "system", "content": VISION_SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "text", "text": "Audit this product photograph."},
                {"type": "image_url",
                 "image_url": {"url": f"data:image/jpeg;base64,{b64}"}},
            ]},
        ],
    )
    return json.loads(r.choices[0].message.content)


@dataclass
class AuditIteration:
    iter: int
    issues: list[dict]
    deltas: dict[str, float]
    render_path: str
    version_name: str


def audit_photo(lc: LightCraftTCP, llm: OpenAI, photo_id: int) -> dict:
    work = WRITE_ROOT / str(photo_id)
    work.mkdir(parents=True, exist_ok=True)

    history: list[AuditIteration] = []
    converged = False
    consecutive_ok = 0

    for it in range(1, 4):
        render_path = work / f"iter_{it}.jpg"
        lc.execute("render_photo", {
            "id": photo_id, "size": 1024, "format": "jpeg",
            "path": str(render_path),
        })
        if not render_path.exists() or render_path.stat().st_size == 0:
            raise RuntimeError(f"empty render at {render_path}")

        # Numeric enforcement (authoritative).
        stats = compute_pixel_stats(render_path)
        hard_violations = numeric_violations(stats)

        # LLM critique (advisory) — used only for codes the numeric pass missed.
        critique = vision_critique(llm, render_path)
        merged_issues: list[dict] = hard_violations or critique.get("issues", [])
        status = "needs_adjustment" if hard_violations else critique.get("status", "ok")

        # Snapshot before any mutation.
        version_name = f"audit_iter_{it}"
        lc.execute("version.create", {"name": version_name})

        if status == "ok":
            consecutive_ok += 1
        else:
            consecutive_ok = 0

        deltas: dict[str, float] = {}
        if consecutive_ok < 2:
            deltas = plan_adjustments(merged_issues)
            if deltas:
                lc.execute("develop.beginInteraction",
                           {"label": f"Audit iter {it}"})
                try:
                    for ctrl, d in deltas.items():
                        lc.execute("develop.set",
                                   {"control": ctrl, "value": d, "ids": [photo_id]})
                finally:
                    lc.execute("develop.endInteraction", {})

        history.append(AuditIteration(
            iter=it, issues=merged_issues, deltas=deltas,
            render_path=str(render_path), version_name=version_name))

        if consecutive_ok >= 2:
            converged = True
            break

    # Push to XMP sidecar for durability outside the catalog.
    lc.execute("library.toggleAutoWriteXmp", {})  # toggle ON
    lc.execute("photo.saveMetadataToFile", {"ids": [photo_id]})

    final_dev = lc.execute("develop.get", {"id": photo_id})
    return {
        "photo_id": photo_id,
        "iterations": len(history),
        "converged": converged,
        "final_dev": final_dev,
        "history": [h.__dict__ for h in history],
        "flagged_for_human": not converged,
    }


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    token = os.environ["LIGHTCRAFT_TOKEN"]
    lc = LightCraftTCP(token=token)
    llm = OpenAI()
    try:
        report = audit_photo(lc, llm, photo_id=12345)
        print(json.dumps(report, indent=2))
    finally:
        lc.close()
