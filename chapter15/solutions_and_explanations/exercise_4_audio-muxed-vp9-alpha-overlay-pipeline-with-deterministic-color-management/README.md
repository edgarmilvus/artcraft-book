# 15. Exercise 4: Audio-Muxed VP9 Alpha Overlay — solution

The worked overlay delivery. A 12-frame RGBA lower third and a 48 kHz/24-bit
stem are encoded twice into MKV and WebM, then checked for alpha, BT.709,
identical VP9 elementary streams, limited-range luma and Opus audio.

## What it does

1. `encodeAlpha()` runs a two-pass VP9 encode with `yuva420p`, Opus at 48 kHz
   and 192 kbit/s, and the same filter chain into both containers. The second
   pass is single-threaded so the elementary stream is byte-stable.
2. The final `-threads 1` pair is dropped for the analysis pass; the original
   `slice(0, -1)` left a dangling `-threads` and produced an invalid FFmpeg
   command.
3. `ffprobeFields()` reads primaries/transfer/matrix, alpha and duration.
   `hasAlphaPlane()` accepts `yuva420p` or
   the WebM `alpha_mode=1` tag, because FFmpeg reports both containers as
   `yuv420p`.
4. `observedColor()` reads the codec field and falls back to the Matroska
   `COLOR_PRIMARIES`/`COLOR_TRANSFER` tags. VP9 has no primaries/transfer in
   its bitstream, so the tags carry the full triad.
5. `videoStreamSha()` extracts the VP9 elementary stream to IVF and hashes it;
   MKV and WebM must match.
6. `signalStats()` enforces limited range with a five-step guard band for
   decoder ringing; `tcpExecute()` authenticates first and clears its socket
   timers on success and failure.

## Run it

```bash
cd chapter15/solutions_and_explanations/exercise_4_audio-muxed-vp9-alpha-overlay-pipeline-with-deterministic-color-management/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_ex4.ts
```

```
39 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/overlay.mkv` | VP9 alpha + Opus in Matroska |
| `output/overlay.webm` | VP9 alpha + Opus in WebM |
| `output/overlay.json` | the Lottie source |
| `output/thumb.png` | 1280×720 thumbnail |
| `output/whoosh_stem.wav` | 48 kHz / 24-bit / stereo stem |
| `output/color-conformance.json` | contract, observed triad, failed frames, pass |
| `output/delivery.json` | SHA-256 per deliverable + elementary-stream hash |
| `output/tcp-handshake.json` | the observed method order (`auth` first) |
| `output/report.json` | assertion count and artifact list |
| `output/run_ex4.log` | shell-captured harness log |

Intermediate frames, decoded output and pass logs remain under
`output/work/dist/`.

## The listings

| file | what it is |
| --- | --- |
| `files/04_audio-muxed-vp9-alpha-overlay-pipeline-with-deterministic-color-management.ts` | encode, probe, stream hash, signalstats, TCP client |
| `files/run_ex4.ts` | the acceptance harness with a loopback auth stub |
| `files/01_color.contract.ts` | the colour/audio contract |
| `files/overlay-lottie.json` | the 12-frame Lottie source |

## Notes

- The alpha tag alone is not proof: the harness also checks that the decoded
  frame has transparent pixels.
- The stream hash is over the VP9 elementary stream (IVF), not the container,
  so identical video in two containers compares equal.
- Luma 15 and ringing to 11 are normal for a transparent overlay at CRF 26;
  the gate allows 11–240 rather than failing a legal encode.
- Type-check it with `npm run check`.
