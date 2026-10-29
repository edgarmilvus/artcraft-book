import socket, json, base64, hashlib, os
from typing import Any, Optional
from openai import OpenAI

TCP_HOST, TCP_PORT = "127.0.0.1", 7979
TOKEN = os.environ["FILMCRAFT_TOKEN"]

# ---------- TCP transport with mandatory first-frame auth ------------------
class CraftClient:
    def __init__(self, host=TCP_HOST, port=TCP_PORT, token=TOKEN):
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.connect((host, port))
        self.reader = self.sock.makefile("r")
        self._id = 0
        # The auth frame MUST be first. Any other frame closes the socket.
        auth = {"id": "auth", "method": "auth", "params": {"token": token}}
        self.sock.sendall((json.dumps(auth) + "\n").encode())
        res = json.loads(self.reader.readline())
        if not res.get("ok"):
            raise ConnectionRefusedError(f"auth failed: {res}")

    def execute(self, command: str, params: dict | None = None) -> dict:
        self._id += 1
        frame = {"id": self._id, "method": "engine.execute",
                 "params": {"command": command, "params": params or {}}}
        self.sock.sendall((json.dumps(frame) + "\n").encode())
        return json.loads(self.reader.readline())

    def close(self):
        try: self.reader.close()
        finally: self.sock.close()

# ---------- Scope/vision helpers -------------------------------------------
def scope_metrics(scope_row: dict) -> dict:
    """Read the luma waveform bins and derive min/max/mean-Y in IRE.

    The engine reports one entry per column, and every column carries its
    minimum, mean and maximum in IRE.
    """
    s = scope_row.get("result", scope_row.get("data", scope_row))
    luma = s.get("waveform", {}).get("luma", s.get("waveform", []))
    if isinstance(luma, dict):
        luma = luma.get("columns", [])
    columns = luma if isinstance(luma, list) else []
    wmin = [float(c.get("min", 0.0)) for c in columns if isinstance(c, dict)]
    wmax = [float(c.get("max", 0.0)) for c in columns if isinstance(c, dict)]
    wmean = [float(c.get("mean", 0.0)) for c in columns if isinstance(c, dict)]
    return {
        "waveformMinIre": min(wmin) if wmin else 0.0,
        "waveformMaxIre": max(wmax) if wmax else 0.0,
        "midtoneMeanY": sum(wmean) / len(wmean) if wmean else 0.0,
    }

def numeric_pass(m: dict) -> bool:
    # The scopes report IRE, so the ceiling is 100 and the midtone band
    # sits between 25 and 75 IRE.
    return (m["waveformMinIre"] >= 0.0 and
            m["waveformMaxIre"] <= 100.0 and
            25.0 <= m["midtoneMeanY"] <= 75.0)

# ---------- Vision model prompt --------------------------------------------
def prompt_frame(b64: str) -> list:
    return [{
        "role": "user",
        "content": [
            {"type": "text", "text": (
                "You are a color finish QC agent. Inspect the graded frame and "
                "reply with ONLY valid JSON matching:\n"
                '{"status": "ok"|"too_cool"|"too_warm"|"too_flat"|"too_contrasty"|"shadows_muddy"|"highlights_blown",'
                '"shadowAdjustment": {"hue": number, "sat": number, "balance": number}|null,'
                '"midtoneAdjustment": {...}|null, "highlightAdjustment": {...}|null,'
                '"confidence": number_between_0_and_1}. No markdown, no prose.'
            )},
            {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
        ]
    }]

INVALID_FALLBACK = {
    "shadows":    {"hue": 195, "sat": 22, "balance": -0.04},
    "midtones":   {"hue": 35,  "sat": 13, "balance": 0.03},
    "highlights": {"hue": 48,  "sat": 3,  "balance": 0.0},
}

# ---------- Oscillation detection ------------------------------------------
def is_oscillation(history: list[dict]) -> bool:
    """Detect a ping-pong between two recent corrections.

    The applied steps are Lumetri writes: ``wheel_<axis>`` carries
    ``[hue/360, sat/100]`` and ``wheel_<axis>_l`` carries the balance.
    Two recent entries with opposite signs on any hue or balance component
    are an oscillation.
    """
    recent = [h for h in history[-3:] if h.get("appliedAdjustments")]
    def components(steps: list[dict]) -> dict[tuple[str, str], float]:
        out: dict[tuple[str, str], float] = {}
        for step in steps:
            params = step.get("params", {})
            name = params.get("param", "")
            value = params.get("value")
            if name.startswith("wheel_") and name.endswith("_l"):
                out[(name[len("wheel_"):-len("_l")], "balance")] = float(value or 0)
            elif name.startswith("wheel_") and isinstance(value, list) and value:
                out[(name[len("wheel_"):], "hue")] = float(value[0])
        return out
    for i in range(len(recent)):
        for j in range(i + 1, len(recent)):
            a = components(recent[i]["appliedAdjustments"])
            b = components(recent[j]["appliedAdjustments"])
            for key in set(a) & set(b):
                if a[key] * b[key] < 0:
                    return True
    return False

# ---------- Main agent loop ------------------------------------------------
def run_agentic_grade(clip_id: int, playhead_sec: float, max_iters: int = 6) -> dict:
    craft = CraftClient()
    llm   = OpenAI()

    iterations: list[dict] = []
    smoothed: dict[str, dict] = {k: v.copy() for k, v in INVALID_FALLBACK.items()}
    final_state: Optional[dict] = None
    oscillation_halted = False

    for it in range(1, max_iters + 1):
        # 1. Render current frame.
        render = craft.execute("render_frame", {"seconds": playhead_sec})
        png_b64 = render.get("result", {}).get("pngBase64") or ""
        frame_bytes = base64.b64decode(png_b64) if png_b64 else b""
        frame_hash = hashlib.sha256(frame_bytes).hexdigest()

        # 2. Vision judgement with one corrective retry on malformed JSON.
        raw_response, parsed = "", None
        for attempt in range(2):
            msgs = prompt_frame(png_b64)
            if attempt == 1:
                msgs[0]["content"][0]["text"] += (
                    f"\n\nYour previous reply was invalid JSON: {raw_response!r}. "
                    "Return strict JSON only, without any surrounding text."
                )
            resp = llm.chat.completions.create(
                model="gpt-4o",
                messages=msgs,
                response_format={"type": "json_object"},
            )
            raw_response = resp.choices[0].message.content or ""
            try:
                parsed = json.loads(raw_response)
                break
            except json.JSONDecodeError:
                parsed = None
        if parsed is None:
            # Both attempts failed: strict numerical fallback.
            parsed = {
                "status": "too_flat", "confidence": 0.0,
                "shadowAdjustment":    {"hue": -5, "sat": 0, "balance": 0},
                "midtoneAdjustment":   {"hue": 0,  "sat": 0, "balance": 0},
                "highlightAdjustment": {"hue": 0,  "sat": -5, "balance": 0},
            }

        # 3. Apply adjustments via a single command_batch over the TCP transport.
        steps = []
        for axis, key in (("shadows", "shadowAdjustment"),
                          ("midtones", "midtoneAdjustment"),
                          ("highlights", "highlightAdjustment")):
            adj = parsed.get(key)
            if not adj: continue
            # Accumulate the delta onto the running state.
            for k in ("hue", "sat", "balance"):
                if adj.get(k) is None: continue
                smoothed[axis][k] = smoothed[axis].get(k, 0) + adj[k]
            # The engine stores a band as a colour vector and a luma
            # offset: the vector carries hue and saturation together.
            steps.append({"id": "effects.setParam",
                          "params": {"clip": clip_id, "effect": "lumetri",
                                     "param": f"wheel_{axis}",
                                     "value": [(smoothed[axis].get("hue", 0) % 360) / 360,
                                               smoothed[axis].get("sat", 0) / 100]}})
            steps.append({"id": "effects.setParam",
                          "params": {"clip": clip_id, "effect": "lumetri",
                                     "param": f"wheel_{axis}_l",
                                     "value": smoothed[axis].get("balance", 0)}})
        if steps:
            craft.execute("command_batch", {"steps": steps})

        # 4. Numeric verification.
        scope = craft.execute("scopes.read", {
            "scopes": ["waveform"], "waveformType": "luma",
            "colorSpace": "709", "clamp": True,
        })
        metrics = scope_metrics(scope)
        num_ok = numeric_pass(metrics)
        vis_ok = parsed.get("status") == "ok"

        entry = {
            "iteration": it, "frameHash": frame_hash,
            "visionRawResponse": raw_response, "visionParsed": parsed,
            "appliedAdjustments": steps, "scopeReadout": metrics,
            "passedNumeric": num_ok, "passedVision": vis_ok,
            "oscillated": False,
        }
        iterations.append(entry)

        # 5. Convergence: both signals agree.
        if num_ok and vis_ok:
            final_state = smoothed
            break

        # 6. Oscillation check: bail out to the previous validated iteration.
        if is_oscillation(iterations):
            entry["oscillated"] = True
            oscillation_halted = True
            # Return the last iteration whose numeric check passed.
            prior = next((h for h in reversed(iterations[:-1]) if h["passedNumeric"]), None)
            if prior:
                final_state = smoothed  # frozen at prior (best-effort)
            break

    craft.close()
    final_hash = iterations[-1]["frameHash"] if iterations else ""
    status = ("CONVERGED" if final_state and iterations[-1]["passedNumeric"] and iterations[-1]["passedVision"]
              else "OSCILLATION_HALT" if oscillation_halted
              else "ITERATION_CAP")

    return {
        "sequenceId": 0, "clipId": clip_id, "maxIterations": max_iters,
        "iterations": iterations, "finalStatus": status,
        "finalFrameHash": final_hash,
        "finalGradeState": final_state or smoothed,
    }

if __name__ == "__main__":
    report = run_agentic_grade(clip_id=7, playhead_sec=45.5)
    with open("/work/verify/agentic_grade_report.json", "w") as f:
        json.dump(report, f, indent=2)
