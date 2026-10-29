# 13. Advanced Application Implementation

A FilmCraft pipeline that authors a three-episode mini-documentary: it
assembles B-roll, syncs dialogue, applies three-way color wheels per
scene, ducks a music bed under the dialogue, governs loudness to ‑16 LUFS
integrated / ‑1 dB true peak, and exports a delivery master. The pipeline
runs headless against `filmcraft-cli mcp` and `pdfcraft-cli mcp`.

## What it does

The pipeline stages:

1. **Ingest** — `doc_open` the B-roll clips, `sequence_inspect` for metadata.
2. **Assembly** — `command_batch` to place clips on the timeline, trim to
   the edit decision list.
3. **Dialogue sync** — `audio.align` the dialogue track to the reference
   transcript.
4. **Color** — three-way wheels per scene (lift/gamma/gain), encoded as
   `layer.newAdjustmentLayer.colorWheels`.
5. **Ducking** — sidechain compressor on the music bed keyed to the
   dialogue bus (`audio.sidechain`).
6. **Loudness governance** — `audio.loudness.normalize` to ‑16 LUFS / ‑1 dB
   true peak, with a `measure` pass before and after.
7. **Export** — `doc_render_preview` a QC frame, `doc_save` the master
   MP4, `doc_save` a PDF/A delivery sheet.

## The listings

| file | what it is |
| --- | --- |
| `package.json` | npm scripts (`check`, `harness`) and dependencies |
| `tsconfig.json` | TypeScript config for the worker |
| `tsconfig.harness.json` | TypeScript config for the harness |

## Run it

```bash
cd chapter13/advanced_application_implementation/example/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_forge.ts
```

```
31 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `files/output/project/media/dialogue.wav` | synced dialogue track |
| `files/output/project/media/music.wav` | ducked music bed |
| `files/output/project/media/shot.png` | QC frame from the master |
| `output/run_forge.log` | the harness log |

## Notes

- `filmcraft-cli` and `pdfcraft-cli` on `PATH`.
- The pipeline is deterministic: no LLM, no network.
- Loudness measured with EBU R128 algorithm via FilmCraft's `audio.loudness`.
