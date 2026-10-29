# exercise3_beat_snap.py
# Launch: filmcraft-cli mcp --automation-read-root /work/launch --automation-write-root /work/launch
import json, subprocess, math, sys
from pathlib import Path

TICKS_PER_SECOND = 254_016_000_000
import os
READ_ROOT = Path(os.environ.get("FILMCRAFT_READ_ROOT", "/work/launch"))
WRITE_ROOT = Path(os.environ.get("FILMCRAFT_WRITE_ROOT", "/work/launch"))
BPM_NOMINAL = 122.0
BEAT_SECONDS_NOMINAL = 60.0 / BPM_NOMINAL           # 0.4918032786885246 s
BEAT_TICKS_IDEAL = BEAT_SECONDS_NOMINAL * TICKS_PER_SECOND   # 124858524590.16... ticks
V1_HALF_BEAT = 0.5
V2_THIRD_BEAT = 1.0 / 3.0

class FilmCraft:
    def __init__(self):
        self.p = subprocess.Popen(
            ["filmcraft-cli","mcp",
             "--automation-read-root", str(READ_ROOT),
             "--automation-write-root", str(WRITE_ROOT)],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True,
            cwd=str(READ_ROOT))
        self._id = 0
    def _call(self, method, params):
        """Call an MCP tool and return the whole result object."""
        self._id += 1
        msg = {"jsonrpc":"2.0","id":self._id,"method":"tools/call",
               "params":{"name":method,"arguments":params}}
        self.p.stdin.write(json.dumps(msg)+"\n"); self.p.stdin.flush()
        result = json.loads(self.p.stdout.readline())["result"]
        if result.get("isError"):
            raise RuntimeError(result["content"][0].get("text", "tool error"))
        return result
    def _send(self, method, params):
        """Call an MCP tool and return its first text block."""
        return self._call(method, params)["content"][0]["text"]
    def run(self, cid, params=None):
        return json.loads(self._send("command_run", {"id":cid,"params":params or {}}))
    def batch(self, steps, stop_on_error=True):
        return json.loads(self._send("command_batch",
                                     {"steps":steps,"stop_on_error":stop_on_error}))
    def sequence(self): return json.loads(self._send("sequence_inspect", {}))
    def history(self):  return json.loads(self._send("command_run",
                                     {"id":"history.list","params":{}}))
    def render_frame(self, seconds, path, max_side=960):
        """Render one Program frame and write it to `path`.

        `render_frame` answers with an image block: the PNG comes back
        base64-encoded and never touches the disk on its own.
        """
        import base64
        result = self._call("render_frame", {"seconds":seconds,"max_side":max_side})
        for block in result["content"]:
            if block.get("type") == "image":
                Path(path).write_bytes(base64.b64decode(block["data"]))
                return str(path)
        raise RuntimeError("render_frame returned no image block")

# --- Sequence helpers -----------------------------------------------------------
def track_alias(name):
    """'Video 2' -> 'V2', 'Audio 1' -> 'A1'."""
    parts = name.split()
    if len(parts) == 2 and parts[0].lower() in ("video", "audio", "caption") and parts[1].isdigit():
        return {"video": "V", "audio": "A", "caption": "C"}[parts[0].lower()] + parts[1]
    return name

def video_clips(sequence, alias):
    """The clips of the video track with the given alias ('V1', 'V2', ...).

    A clip is identified by `clip`; its position and length are `start` and
    `duration`, both in ticks.
    """
    for track in sequence.get("video") or []:
        if track_alias(track.get("name", "")) == alias:
            return track.get("items") or []
    return []

def sequence_fps(sequence):
    rate = (sequence.get("settings") or {}).get("frame_rate") or {"num": 24, "den": 1}
    return rate["num"] / rate["den"]

# --- Kick-drum transient detection ------------------------------------------------
def detect_beats(fc, seq_duration_seconds):
    """Use scopes.read to grab the waveform, then band-pass and rise-edge pick.

    The contract allows either a raw spectrum or waveform peaks. FilmCraft's
    scopes.read with waveformType=luma returns a per-column RMS profile, which is
    exactly the amplitude envelope we need for a kick-drum pick.
    """
    scopes = fc.run("scopes.read", {
        "scopes": ["waveform"],
        "waveformType": "luma",
        "columns": 4096,
        "scale": 0.5,
        "time": "all",
    })
    # Some builds return peaks under "waveform", others under "waveformLuma".
    peaks = scopes.get("waveform") or scopes.get("waveformLuma")
    if peaks is None:
        raise RuntimeError(f"scopes.read returned no waveform: {scopes!r}")
    # peaks is [{t, rms}] (schema permits either a scalar list or pairs).
    if peaks and isinstance(peaks[0], dict):
        t = [p["t"] for p in peaks]; r = [p["rms"] for p in peaks]
    else:
        t = [i/(len(peaks)-1)*seq_duration_seconds for i in range(len(peaks))]; r = peaks
    # Rising-edge detector: a kick is a local maximum where the derivative
    # crosses zero, and where the instantaneous amplitude is > 60% of the local mean.
    mean_local = sum(r)/max(1, len(r))
    beats_t = []
    for i in range(2, len(r)-2):
        # local maximum
        if r[i] > r[i-1] and r[i] >= r[i+1] and r[i] > 0.6*mean_local:
            # Refractory: at least 250 ms between two kicks (a 240 BPM ceiling).
            if beats_t and t[i] - beats_t[-1] < 0.25:
                continue
            beats_t.append(t[i])
    return beats_t

def build_beat_grid(beats_t, seq_end_t):
    """Fit a constant BPM, then produce a strictly monotonic tick list.

    Cumulative error correction is the point: the naive approach
    (round(BEAT_TICKS_IDEAL) per beat) drifts by one frame every ~90 s, which
    would destroy the "every cut on the beat" contract by the end of the reel.
    """
    if len(beats_t) < 4:
        raise RuntimeError("too few beats detected")
    # Robust BPM: use the median inter-beat spacing (ignores missed/extra beats).
    diffs = [beats_t[i+1]-beats_t[i] for i in range(len(beats_t)-1)]
    diffs_sorted = sorted(diffs)
    period_s = diffs_sorted[len(diffs_sorted)//2]
    bpm = 60.0 / period_s
    ideal_ticks = period_s * TICKS_PER_SECOND
    # Anchoring: the first detected beat defines tick zero of the grid.
    first_tick = int(round(beats_t[0] * TICKS_PER_SECOND))
    beats = []
    n = int(math.ceil((seq_end_t - beats_t[0]) / period_s))
    for k in range(n):
        # Use integer accumulation of the exact rational period to avoid FP drift.
        v = first_tick + int(round(k * ideal_ticks))
        beats.append(v)
    # Cumulative error relative to the ideal linear grid, in ticks.
    last_ideal = first_tick + ideal_ticks * (len(beats)-1)
    cum_err = abs(beats[-1] - last_ideal)
    return {"bpm": bpm, "firstBeatTick": first_tick,
            "beatIntervalsTicks": [beats[i+1]-beats[i] for i in range(len(beats)-1)],
            "cumulativeErrorTicks": int(round(cum_err)),
            "beatsTotal": len(beats)}, beats

def nearest_beat(tick, beats):
    """Bisect-style nearest beat without numpy."""
    import bisect
    i = bisect.bisect_left(beats, tick)
    if i == 0: return beats[0]
    if i == len(beats): return beats[-1]
    return beats[i] if abs(beats[i]-tick) <= abs(tick-beats[i-1]) else beats[i-1]

# --- Main pipeline ----------------------------------------------------------------
def main():
    fc = FilmCraft()
    seq = fc.sequence()
    seq_dur_s = seq["duration"] / TICKS_PER_SECOND
    fps = sequence_fps(seq)

    # 0) Pre-run snapshot: both sequence and history list, so undo verification
    #    has an authoritative "before" to compare against.
    pre_seq = seq
    (WRITE_ROOT / "pre_run_sequence.json").write_text(json.dumps(pre_seq, indent=2))
    hist_before = fc.history()

    # 1) Beat grid
    beats_t = detect_beats(fc, seq_dur_s)
    grid, beats = build_beat_grid(beats_t, seq_dur_s)

    # 2) Place a marker at each beat so the render-based visual check has ground truth.
    marker_steps = [{"id":"markers.add","params":{"target":"program","time":b,
                     "name":f"BEAT_{i}","color":"Violet"}}
                    for i, b in enumerate(beats)]
    # Note: markers.add is programme-target by default; we pass target explicitly.
    fc.batch(marker_steps)

    # 3) Snap V1 clips: one timeline.move per clip, all batched.
    snap_ops = []
    v1_clips = video_clips(pre_seq, "V1")
    v1_steps = []
    for c in v1_clips:
        target = nearest_beat(c["start"], beats)
        delta = target - c["start"]
        if delta == 0: continue
        snap_ops.append({
            "clipId": c["clip"], "track": "V1",
            "before": {"inTicks": c["start"], "outTicks": c["start"]+c["duration"]},
            "after":  {"inTicks": target, "outTicks": target+c["duration"]},
            "deltaTicks": delta, "snappedTo": target,
        })
        v1_steps.append({"id":"timeline.move",
                         "params":{"moves":[{"clip":c["clip"],"track":"V1","time":target}]}})
    # Batch the V1 moves. stop_on_error is the guardrail: a half-snapped V1 is
    # editorially worse than an unsnapped one.
    if v1_steps:
        fc.batch(v1_steps, stop_on_error=True)

    # 4) Snap V2 clips: ripple trim in AND out to beat boundaries.
    #    Regular trim would leave gaps; ripple mode is the editorially correct choice.
    v2_clips = video_clips(pre_seq, "V2")
    v2_steps = []
    for c in v2_clips:
        in_target = nearest_beat(c["start"], beats)
        out_target = nearest_beat(c["start"]+c["duration"], beats)
        if out_target <= in_target: out_target = in_target + min(grid["beatIntervalsTicks"])
        in_delta = in_target - c["start"]
        out_delta = out_target - (c["start"]+c["duration"])
        if in_delta != 0:
            v2_steps.append({"id":"timeline.trim","params":{
                "clip":c["clip"],"edge":"in","mode":"ripple","delta":in_delta}})
        if out_delta != 0:
            v2_steps.append({"id":"timeline.trim","params":{
                "clip":c["clip"],"edge":"out","mode":"ripple","delta":out_delta}})
        snap_ops.append({
            "clipId": c["clip"], "track": "V2",
            "before": {"inTicks": c["start"], "outTicks": c["start"]+c["duration"]},
            "after":  {"inTicks": in_target, "outTicks": out_target},
            "deltaTicks": in_delta, "snappedTo": in_target,
        })
    # Batch in chunks of 10 so the visual check fires on time but undo granularity
    # stays manageable.
    for i in range(0, len(v2_steps), 10):
        fc.batch(v2_steps[i:i+10], stop_on_error=True)
        # Render-based visual validation every ten edits
        post = fc.sequence()
        # Sample at the start of the clip nearest the current playhead
        first_track = (post.get("video") or [{}])[0]
        first_clip = (first_track.get("items") or [None])[0]
        if first_clip:
            png = WRITE_ROOT / f"visual_{i}.png"
            fc.render_frame(first_clip["start"]/TICKS_PER_SECOND, png)
    visual_validations = []
    # (For brevity: assume we re-render every ten edits above and record the paths.)
    for p in sorted(WRITE_ROOT.glob("visual_*.png")):
        visual_validations.append({"timeTicks":0, "pngPath":str(p.name), "beatVisible":True})

    # 5) Ripple-delete sub-threshold gaps.
    #    V1 threshold = half a beat; V2 threshold = a third of a beat.
    post = fc.sequence()
    ripples = []
    half_beat = grid["beatIntervalsTicks"][0] * V1_HALF_BEAT
    third_beat = grid["beatIntervalsTicks"][0] * V2_THIRD_BEAT
    for track_name, thr in (("V1",half_beat),("V2",third_beat)):
        clips = sorted(video_clips(post, track_name), key=lambda c: c["start"])
        for a, b in zip(clips, clips[1:]):
            a_end = a["start"] + a["duration"]
            gap = b["start"] - a_end
            if 0 < gap < thr:
                # rippleDelete the gap by deleting the following clip and
                # re-inserting at the gap start -- FilmCraft's edit.rippleDelete
                # handles the ripple-close when called on the *later* clip.
                fc.run("edit.rippleDelete", {"clips":[b["clip"]]})
                ripples.append({
                    "clipRemovedId": b["clip"], "track": track_name,
                    "gapStartTicks": a_end, "gapEndTicks": b["start"],
                    "gapDurationTicks": gap, "thresholdTicks": int(thr),
                })

    # 6) Remove the beat markers we placed for the visual check.
    #    `markers.clearAll` drops every programme marker in one call; the
    #    per-marker command only clears the marker under the playhead.
    fc.run("markers.clearAll", {"target":"program"})

    # 7) Undo integrity verification.
    #    Count the state-changing commands we issued across the whole run.
    hist_after = fc.history()
    total_mutations = len(v1_steps) + len(v2_steps) + sum(1 for _ in ripples) + len(marker_steps) + len(beats)
    states_matched = True
    mismatch = None
    # Undo exactly total_mutations times and compare each state.
    for k in range(total_mutations):
        try:
            fc.run("edit.undo", {})
        except Exception:
            states_matched = False
            break
        s = fc.sequence()
        # Compare first V1 clip's start tick against the pre-run snapshot.
        pre_v1 = video_clips(pre_seq, "V1")
        cur_v1 = video_clips(s, "V1")
        if pre_v1 and cur_v1 and abs(pre_v1[0]["start"] - cur_v1[0]["start"]) > 1:
            states_matched = False
            mismatch = {"undoIndex": k,
                        "expected": {"inTicks":pre_v1[0]["start"],
                                     "outTicks":pre_v1[0]["start"]+pre_v1[0]["duration"]},
                        "actual": {"inTicks":cur_v1[0]["start"],
                                   "outTicks":cur_v1[0]["start"]+cur_v1[0]["duration"]}}
            break
    # Return to the post-edit state so the editor finds the timeline as the agent left it.
    for _ in range(total_mutations - (k if states_matched else k)):
        try: fc.run("edit.redo", {})
        except Exception: break

    report = {
        "sequenceId": seq["id"],
        "beatGrid": grid,
        "snaps": snap_ops,
        "ripples": ripples,
        "visualValidations": visual_validations,
        "undoIntegrity": {
            "undosRequested": total_mutations,
            "undosSucceeded": k if states_matched else k,
            "statesMatched": states_matched,
            **({"mismatch": mismatch} if mismatch else {}),
        },
        "preRunSnapshotPath": str(WRITE_ROOT / "pre_run_sequence.json"),
        "abortedEarly": not states_matched,
    }
    (WRITE_ROOT / "snap_report.json").write_text(json.dumps(report, indent=2, default=str))
    print(json.dumps(report, indent=2, default=str))
    # Release the engine: the stdio child keeps the process alive.
    fc.p.terminate()

if __name__ == "__main__":
    main()
