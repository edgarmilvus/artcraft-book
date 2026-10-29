# 12. Solutions and Explanations

The chapter ends with a worked answer for exercise 1: the transcript-driven
B-roll assembly, driven end to end against the headless engine. It is the only
project in this section, and it exists so the exercise can be run rather than
read — the pipeline, the report and the files it writes are all checked by a
harness.

## What it does

`01_exercise1_broll_assembly.ts` imports the A-roll and walks the B-roll folder,
creating one bin per directory with `file.newBin` and importing each clip with
`file.import` — the engine answers with item ids, and every later command uses
those ids rather than file names. It then asks `transcript.models` whether a
speech model is installed. When one is, `transcript.generate` runs with
`whisper-base`; when none is, the script falls back to the `a_roll_transcript.json`
sidecar, which is the same shape the engine would have produced.

The transcript is segmented into sentences at terminal punctuation or a pause
of 0.6 s, and each sentence is scanned for concrete nouns. A phrase is either
the noun or "the" plus the noun, so "the rooftop" and "honeycomb" both become
candidates. Each candidate is back-checked with `transcript.search` to confirm
its offsets land on real text.

The B-roll index is a weighted bag of words built from three sources: filename
tokens at weight 3, a hand-curated override map at weight 5 for clips the crew
named cryptically, and one transcript pass over the clip itself at weight 1.
Phrases are scored by cosine similarity in that space; the best entry wins, and
anything under 0.30 is dropped rather than guessed at. The cut point walks
forward to the next word gap of at least 0.6 s so nothing lands mid-sentence.

Placement is one `command_batch` of `timeline.place` calls on V2 with
`insert: false`, `video: true` and `audio: false`: an overlay, never a ripple,
and never a change to A1. Candidates are de-duplicated by item and checked for
overlap, so the same clip cannot be used twice and no two placements collide.

## The listings

| file | what it is |
| --- | --- |
| `01_exercise1_broll_assembly.ts` | the solution: transport, transcript resolution, segmentation, the B-roll index, cosine ranking, pause snapping, placement, contact sheets and the review document |
| `run_exercise1.ts` | the harness: synthesizes the media and the transcript, runs the solution, checks the report and every file it names |
| `package.json` | `check` (`tsc --noEmit`) and the MCP SDK dependency |
| `tsconfig.json` | the strict TypeScript configuration |

## Run it

```bash
cd chapter12/solutions_and_explanations/exercise_1_transcript-driven-b-roll-assembly-with-semantic-cut-point-discovery/files
export PATH="$PWD/../../../../tools/craft-cli/bin:$PATH"
npx tsx run_exercise1.ts
```

The harness writes a six-second A-roll (`A001_C003.mov`), three four-second
B-roll clips under `B_Roll/Day03/` — `city-rooftop-hives.mov`,
`queen-bee-close.mov`, `honeycomb-extractor.mov` — and a word-level transcript
with a deliberate pause before the second sentence. It then runs the solution
with `FILMCRAFT_READ_ROOT` and `FILMCRAFT_WRITE_ROOT` pointed at
`output/read` and `output/write`, parses the printed report, and checks it.

```
# the report
PASS report: it parsed
PASS report: the sequence has an id
PASS report: the b-roll was matched
PASS report: the placement is on V2
PASS report: the placement is inside the timeline
PASS report: the phrase is a real match
PASS report: the contact sheet is listed
PASS report: the undo count is positive

# the artifacts
PASS artifact: contact_8.png exists
PASS artifact: the review document exists
PASS artifact: the pre-run snapshot exists
PASS artifact: the review document is a table
PASS artifact: the snapshot holds the project
PASS artifact: the snapshot holds the sequence

15 assertions passed
```

## What it produces

| artifact | what it is |
| --- | --- |
| `output/read/B_Roll_Project/A001_C003.mov` | the synthetic interview take |
| `output/read/B_Roll_Project/B_Roll/Day03/*.mov` | the three B-roll candidates whose names carry the vocabulary |
| `output/read/a_roll_transcript.json` | the sidecar transcript: sixteen word entries with tick-accurate starts and ends |
| `output/write/assembly_pre_run.json` | the project and sequence captured before any edit — the undo point |
| `output/write/broll_review.md` | the review table: timecode, file, matched phrase, confidence, suggested duration |
| `output/write/contact_8.png` | the frame rendered at the midpoint of the first placement |

The report adds `undoStepsRequired`, the number of applied edits plus the two
bin creations, so an editor knows exactly how many `edit.undo` calls restore
the original state.

## Notes

- **`filmcraft-cli` must be on `PATH`** — the solution spawns
  `filmcraft-cli mcp` itself, with the read and write roots as flags.
- `ffmpeg` is required by the harness to synthesize the three media files.
- Contact sheets cover only the first five placements, at `max_side: 480`;
  they are a review aid, not a delivery render.
- There is no speech model dependency: the sidecar path is the one the harness
  exercises, and the model path is taken only when `transcript.models` reports
  an installed model.
- Type-check with `npm run check`.
