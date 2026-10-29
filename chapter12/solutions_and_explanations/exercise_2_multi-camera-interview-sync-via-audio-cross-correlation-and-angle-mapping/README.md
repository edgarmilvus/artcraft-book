# 12. Exercise 2: Multi-Camera Interview Sync — solution

The worked audio-sync core. Three free-running cameras are aligned from their
audio alone: pairwise cross-correlation, rejection of the one false lock, and
a least-squares solve for one global offset per camera.

## What it does

1. Reads the extracted 48 kHz WAV sidecars and normalizes each waveform.
2. `cross_correlate()` correlates a probe against a search window and rejects
   three failure modes: an impulse peak (`impulse`), a peak below 2.5 sigma
   (`lowZ`) and two comparable peaks more than a second apart (`multiModal`).
3. `reconcile()` fixes camera A as the reference and solves the accepted
   pairwise lags into B/C offsets by weighted least squares, reporting the
   residual in milliseconds.
4. `detect_speech_pauses()` finds silence runs in the A-cam waveform for the
   angle map.
5. The engine path places each camera on its own video track with a surgical
   `timeline.place`, enables multicam, writes angle markers on pauses and
   renders the three slate frames.

## Run it

```bash
cd chapter12/solutions_and_explanations/exercise_2_multi-camera-interview-sync-via-audio-cross-correlation-and-angle-mapping/files
PY=$("../../../../tools/pick_python.sh")
"$PY" run_ex2.py
```

```
26 assertions passed
```

The harness synthesizes its own WAVs and checks the pure correlation and
reconciliation layer; `main()` in the solution is the FilmCraft path.

## What it produces

All evidence is written to the solution's `output/` directory.

| artifact | what it is |
| --- | --- |
| `output/audio/camA.wav` | reference camera |
| `output/audio/camB.wav` | camera 100 ms late |
| `output/audio/camC.wav` | camera 250 ms late |
| `output/audio/dialogue.wav` | speech/silence pattern for pause detection |
| `output/audio/camImpulse*.wav` | the impulse pair used to prove rejection |
| `output/correlations.png` | visual summary of the accepted lags |
| `output/correlations.json` | full correlation rows, including rejection reasons |
| `output/multicam_report.json` | alignment, residual, pauses and validation flag |
| `output/report.json` | assertion count, offsets and artifact list |
| `output/run_ex2.log` | shell-captured harness log written by `run_all.sh` |

## The listings

| file | what it is |
| --- | --- |
| `files/02_exercise2_multicam_sync.py` | MCP transport, project helpers, correlation, rejection, reconciliation, pause detection and placement |
| `files/run_ex2.py` | the acceptance harness: synthetic WAVs, impulse rejection, least squares and pauses |
| `files/01_typescript.ts` | the correlation and multicam report contract |

## Notes

- Offsets are computed in samples and converted with the exact tick rate;
  placement is `timeline.place`, never a ripple trim.
- The impulse rejection is a separate fixture so one bad pair does not corrupt
  the three-camera solve.
- Python 3.10 or newer, with `numpy` and `Pillow`.
