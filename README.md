# ArtCraft Book: The Agentic Creative Studio in TypeScript

Twenty chapters of headless automation against the ArtCraft creative
suite: PhotoCraft, VectorCraft, FilmCraft, DesignCraft, EffectCraft,
LightCraft, WordCraft, PdfCraft, GridCraft and DeckCraft, driven over
the Model Context Protocol.

Every runnable listing in the book is in this repository, and **every one
of them runs**. The harnesses next to the code execute each project against
the real engine binaries and assert on the artifacts the engine produced —
not on the prose, and not on a mock.

The exercise *prompts* — the starting contracts the book prints before each
worked solution — are kept outside this tree, so that everything here is
code with a harness attached.

---

<p align="center">
  <img src="images/36cover.jpg" alt="ArtCraft: The Agentic Creative Studio in TypeScript" width="360">
</p>

**A production field guide to agents that edit creative work.** Twenty chapters
take the agent from a flat generated image to a layered PhotoCraft document, a
pathfinder boolean, a frame-accurate FilmCraft assembly, a governed PDF/DOCX
pipeline and a capstone studio that runs end to end over MCP. Every listing in
the book is here, and every one of them has a harness.

[**Additional Information →**](https://tiny.cc/ArtCraftBook)

### Quickstart

One harness runs with nothing but Node and npm — no engines, no Docker:

```bash
git clone https://github.com/edgarmilvus/artcraft-book.git
cd artcraft-book
npm ci
npx tsx chapter11/solutions_and_explanations/exercise_3_frame-rate-rational-conversion-harness-23-976-25-29-97df/files/run_ex3.ts
```

That is the frame-rate argument of chapter 11 in one file. For the projects that
drive the real engines, use the Docker path:

```bash
docker compose build
docker compose run --rm artcraft
```

The rest of this README explains the native install, the per-chapter runners and
the artefacts each harness leaves behind.

### Chapter index

| # | Chapter | Code |
| --- | --- | --- |
| 1 | The Death of Flat Generative Pixels | [chapter1](chapter1/README.md) |
| 2 | Inside the ArtCraft Architecture | [chapter2](chapter2/README.md) |
| 3 | Headless CLI Orchestration | [chapter3](chapter3/README.md) |
| 4 | The Loopback Control Channel | [chapter4](chapter4/README.md) |
| 5 | The Model Context Protocol Bridge | [chapter5](chapter5/README.md) |
| 6 | Automated PSD Manipulation | [chapter6](chapter6/README.md) |
| 7 | Multimodal Visual Feedback Loops | [chapter7](chapter7/README.md) |
| 8 | Programmatic Vector Engineering | [chapter8](chapter8/README.md) |
| 9 | High-Throughput RAW Development | [chapter9](chapter9/README.md) |
| 10 | E-Commerce Graphics Factory | [chapter10](chapter10/README.md) |
| 11 | Inside the Integer Timebase | [chapter11](chapter11/README.md) |
| 12 | Autonomous Video Assembly | [chapter12](chapter12/README.md) |
| 13 | Three-Way Colour Wheels and Loudness | [chapter13](chapter13/README.md) |
| 14 | Programmatic Motion Graphics | [chapter14](chapter14/README.md) |
| 15 | Cross-Platform Lottie and VP9 | [chapter15](chapter15/README.md) |
| 16 | Automated Editorial Publishing | [chapter16](chapter16/README.md) |
| 17 | Headless Office Pipelines | [chapter17](chapter17/README.md) |
| 18 | Financial Engineering at Scale | [chapter18](chapter18/README.md) |
| 19 | Full-Stack Studio Governance | [chapter19](chapter19/README.md) |
| 20 | The Autonomous Creative Studio | [chapter20](chapter20/README.md) |

---

## Sixty seconds

A clone is about 90 MB, and one harness runs with nothing but Node and npm.
Nothing is mocked and nothing needs the engine binaries:

```bash
git clone https://github.com/edgarmilvus/artcraft-book.git
cd artcraft-book
npm ci
npx tsx chapter11/solutions_and_explanations/exercise_3_frame-rate-rational-conversion-harness-23-976-25-29-97df/files/run_ex3.ts
```

That prints twenty-nine assertions and exits zero in about a second:

```
PASS output: edl-conversion.csv
PASS output: parity-report.json
PASS csv: one row per edge plus header
PASS output: report manifest

29 assertions passed
```

It converts a 25 fps edit decision list to 23.976, measures the residual in
ticks, microseconds and 48 kHz samples, and round-trips 29.97 drop-frame
timecode — the whole argument of chapter 11 in one file with no engine.

**Everything else needs the engines.** The other 37 projects drive the real
ArtCraft CLIs, which are Apache-2.0, macOS-only, about 4 GB, and never
committed: `tools/install_craft_clis.sh` fetches and verifies them. If you do
not want to install them, the Docker path in [Run](#run) carries the same
binaries inside the image.

A handful of projects compute rather than compose. The frame-rate harness above
is pure arithmetic and needs nothing beyond Node; most of the others open an
engine session in their first few lines, which is why the CLIs or the Docker
path are the normal way in.

```
chapter1/ … chapter20/          one tree per chapter
  README.md              the chapter: what it needs, how to run it, the index
  <section>/
    <example>/
      README.md          what this code is and how to use it
      files/            the listings, verbatim from the book
        run_*.ts|py     the harness for that project
        output/         the artefacts the harness produced
      output/
        run_*.log       the harness log — the proof it ran
```

Every project directory has its own README: what the code does, which
engines it drives, the exact command to run it, and the artifacts it
produces. The chapter README is the index over them.

## What you need

There are two ways to run this book. On macOS you run the harnesses
natively. On any other system, or on a Mac where you would rather not
install three gigabytes of engines, you run them inside Docker.

| | Native on macOS | Docker |
| --- | --- | --- |
| You need | macOS 14+, Node.js 22.5+, Python 3.10+ | Docker |
| Disk | about 4 GB | about 8 GB |
| Engine binaries | fetched by `tools/install_craft_clis.sh` | inside the image |
| Speed | fastest | slower |

The engine binaries are Apache-2.0, are never committed, and are the one
thing the Docker image saves you from installing. For the native path they
are downloaded and verified against `tools/craft-cli/SHA256SUMS`:

```bash
tools/install_craft_clis.sh
tools/install_craft_clis.sh --check
```

They must end up in `tools/craft-cli/bin/`: the harnesses resolve each
engine by an absolute path rooted at the repository, so having the engines
elsewhere on your `PATH` is not enough.

To install from a mirror — a GitHub Enterprise host, an S3 bucket, a local
directory of archives — set `CRAFT_CLI_SOURCE`:

```bash
CRAFT_CLI_SOURCE=https://github.com/storytold tools/install_craft_clis.sh
```

**If a vendor release disappears,** two fallbacks exist: the ten macOS archives
are mirrored in this repository's `craft-cli-v1` release, and the same engines
ship in a container image for the Docker path. Both read the versions pinned in
`tools/craft-cli/versions.txt`, and both are verified against
`tools/craft-cli/SHA256SUMS`. See [docs/engines.md](docs/engines.md).

## Install

Natively:

```bash
npm install
tools/install_python_deps.sh
```

`npm install` writes one `node_modules` at the repository root and points
the ninety-odd chapter projects at it. `install_python_deps.sh` builds a
virtual environment with the third-party packages the Python listings
import — Pillow, numpy, jsonschema, pydantic, the OpenAI SDK, the MCP
SDK and asyncpg — and the runners pick it in preference to the system
interpreter.

With Docker, nothing is installed on the host:

```bash
docker compose build
```

The image carries Node, Python, the ten Linux builds of the engines and a
Chromium to drive the pages in chapter 15.

Nothing else is needed: the harnesses run with an empty environment — no
API key, no database server, no network.

## Run

```bash
./run_all.sh
```

Every harness writes its log next to the code it exercises and prints
its result. The root script calls each chapter's own `run_all.sh` in
turn and keeps going when one of them fails, so one command covers the
whole book: 154 harnesses across the twenty chapters.

Each project writes its artifacts under its own `output/`, or under
`files/output/` when the listings live in `files/`; the project README
names the exact path.

A snapshot of those artifacts from a verified full run ships in
`artifacts/`, with checksums and instructions to restore them. See
`artifacts/README.md`.

Some tools are invoked over the MCP control channel, whose client waits
60 seconds by default. On a slow machine, or inside a container, a large
export can exceed that. Raise it without editing any code:

```bash
MCP_TIMEOUT_MS=300000 ./run_all.sh
```

With Docker, the same run, with everything already inside the image:

```bash
docker compose run --rm artcraft
```

A container is slower than a native run, so a harness that waits on the engine
can cross the 60-second default. Pass the same setting through the container:

```bash
docker compose run --rm -e MCP_TIMEOUT_MS=300000 artcraft
```

The sources are mounted into the container rather than copied, so edits are
picked up without a rebuild and the artifacts land on your disk. To run one
chapter there:

```bash
docker compose run --rm artcraft ./chapter14/run_all.sh
```

To run one chapter:

```bash
./chapter14/run_all.sh
```

To run one artifact:

```bash
cd chapter20/advanced_application_implementation/example/files
npx tsx run_forge.ts
```

`make e2e` is `./run_all.sh`. `make check` type-checks every project, links the
shared dependency tree and checks the master MCP server, without touching the
engines — useful on Linux, where the macOS binaries cannot be installed:

```bash
node tools/typecheck_all.mjs chapter20   # one chapter
```

## Run the live model paths

`run_all.sh` never contacts a model: the LLM is behind an interface and the
harnesses inject a scripted one, so the suite is deterministic and needs no
key. The handful of entry points that do call a real model live behind a
second script, and it runs them against any OpenAI-compatible endpoint:

```bash
export OPENAI_COMPATIBLE_API_KEY=…
export OPENAI_COMPATIBLE_BASE_URL=https://openrouter.ai/api/v1
export OPENAI_COMPATIBLE_MODEL=deepseek/deepseek-v4.1-flash
export OPENAI_COMPATIBLE_VISION_MODEL=deepseek/deepseek-v4.1-flash

./run_live.sh --list     # the stages, and what each one needs
./run_live.sh            # run them all; skips stages whose requirements are missing
./run_live.sh --only ch5-brief
```

Add `EMBEDDING_API_KEY`, `EMBEDDING_BASE_URL` and `EMBEDDING_MODEL` if you want
the embedding path. Chapter 9's culling agent also needs a Postgres with
pgvector (`PG_DSN`) and the ids of the frames to cull (`SEED_PHOTO_IDS`), and
chapter 9's library path comes from `LIGHTCRAFT_LIBRARY`. A stage that cannot
run says so and is skipped instead of failing.

The script reads, in order: your shell, `$ARTCRAFT_LIVE_ENV`
(default `~/.config/artcraft/live.env`), and `tools/secrets.env`. Nothing in
the repository names a provider, and `run_all.sh` is unchanged by any of it.

The first line covers every chapter, the second only chapter 20.

## The engine surfaces

**The ten binaries do not share a dialect.** This is the first thing every
listing has to get right, and it was established by running them, not by
reading their documentation:

| apps | call |
| --- | --- |
| PhotoCraft, VectorCraft, FilmCraft, LightCraft, PdfCraft | `command_run { id, params }` |
| DesignCraft, WordCraft | `execute { command, params }` |
| EffectCraft, GridCraft | `execute_command { command, params }` |
| DeckCraft | `run_command { command, params }` |

`photocraft-cli commands` (or the same subcommand on any of the others) is
the authority for what a given binary accepts; the chapters use that, never
a guessed name.

## Layout of the tools

| path | what it is |
| --- | --- |
| `tools/env.sh` | put the pinned Node and the engine binaries on `PATH` |
| `tools/install_craft_clis.sh` | fetch and verify the engine binaries |
| `tools/install_node.sh` | fetch the pinned Node 22 |
| `tools/install_python_deps.sh` | build the repository's Python environment |
| `tools/requirements.txt` | the Python packages that environment contains |
| `tools/pick_python.sh` | print the Python 3.10+ interpreter the runners use |
| `tools/craft-cli/bin/` | the installed binaries (not committed) |
| `tools/craft-cli/SHA256SUMS` | the checksums the install verifies |
| `tools/link_node_modules.mjs` | point the projects at the root `node_modules` |
| `tools/typecheck_all.mjs` | type-check every project |
| `tools/README.md` | the toolchain in one page, including the four call dialects |

Everything above ships in the repository except the two things it installs:
`tools/craft-cli/bin/` and `tools/node/` are downloaded. `tools/secrets.env`
is a slot for optional live-model keys: it is listed in `.gitignore`, so you
create it yourself and it is never committed.

## License

The code in this repository is released under the MIT license. The full text
is in [LICENSE](LICENSE).

The ArtCraft engine binaries are not covered by it. They are Apache-2.0, licensed
by their vendor; this repository does not modify them, and where it redistributes
them — the `craft-cli-v1` mirror release and the container image — each engine's
`LICENSE` and `NOTICE` travel with the binaries.
