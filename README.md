# ArtCraft Book: The Agentic Creative Studio in TypeScript

Twenty chapters of headless automation against the ArtCraft creative suite:
PhotoCraft, VectorCraft, FilmCraft, DesignCraft, EffectCraft, LightCraft,
WordCraft, PdfCraft, GridCraft and DeckCraft, driven over the Model Context
Protocol.

Every runnable listing in the book is here, and every one of them runs: the
harnesses next to the code execute each project against the real engine
binaries and assert on the artefacts those engines produced. **The engines are
never simulated; the model is.** The deterministic suite injects a scripted
model through the same interface production uses, so a red harness points at
the engine code rather than at a model's mood, and the paths that call a real
model are collected behind `run_live.sh`.

The exercise *prompts* — the starting contracts the book prints before each
worked solution — are kept outside this tree, so that everything here is code
with a harness attached.

**Not affiliated with the ArtCraft team.** This repository and the book are an
independent project. The engines are Apache-2.0 and belong to their authors;
the code, the harnesses and the prose here are the book's.

---

<p align="center">
  <img src="images/36cover.jpg" alt="ArtCraft: The Agentic Creative Studio in TypeScript" width="360">
</p>

**A production field guide to agents that edit creative work.** Twenty chapters
take the agent from a flat generated image to a layered PhotoCraft document, a
pathfinder boolean, a frame-accurate FilmCraft assembly, a governed PDF/DOCX
pipeline and a capstone studio that runs end to end over MCP.

[**Additional Information →**](https://tiny.cc/ArtCraftBook)

## Quickstart

A clone is about 90 MB. One harness runs with nothing but Node and npm — no
engines, no Docker, no model:

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
timecode — the whole argument of chapter 11 in one file, with no engine.

**Everything else opens an engine session.** The other 37 projects drive the
real ArtCraft CLIs, which are Apache-2.0, macOS-only, about 4 GB, and never
committed. [Install](#install) is the next section for a reason.

## Chapter index

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


## Install

The CLIs are **macOS builds**. That decides the path:

| | macOS 14+ | Linux | Windows |
| --- | --- | --- | --- |
| Engines natively | yes | no | no |
| Engines in Docker | yes | yes | Docker Desktop (WSL2) |
| One harness, no engines | yes | yes | yes, Node 22.5+ |
| Disk | about 4 GB | about 8 GB | about 8 GB |

**On macOS, natively** — the fastest path:

```bash
npm ci
tools/install_python_deps.sh
tools/install_craft_clis.sh
tools/install_craft_clis.sh --check
```

`npm ci` writes one `node_modules` at the root and links the 120 projects to it.
`install_python_deps.sh` builds a `.venv` with the packages the Python listings
import — Pillow, numpy, jsonschema, pydantic, the OpenAI SDK, the MCP SDK and
asyncpg — and the runners find it on their own. The two engine commands download
about 4 GB and verify every binary against `tools/craft-cli/SHA256SUMS`; they
must end up in `tools/craft-cli/bin/`, because the harnesses resolve each engine
by an absolute path rooted at the repository.

**On Linux, and on Windows through Docker Desktop** — nothing on the host:

```bash
docker compose build
```

The image carries Node, Python, the ten Linux builds of the engines and a
Chromium to drive the pages in chapter 15.

Nothing else is needed to run a harness: no API key, no database server. The
harnesses never contact a model or a server, though the install steps above do
download Node, the engine binaries and the Python packages.

## Run offline

Three scripts, one vocabulary. `run_offline` never calls a model; it is not
about the network, it is about the model.

| command | what it runs | needs |
| --- | --- | --- |
| `./run_offline.sh` | 154 harnesses against the real engines, with a scripted model | the engine binaries |
| `./run_live.sh` | the nine entry points that call a real model | `OPENAI_COMPATIBLE_*` |
| `./run_everything.sh` | offline, then live; starts the pgvector container chapter 9 needs, and names anything it still cannot run | both |
| `make check` | types, the shared tree, the master server | `npm ci` |

```bash
./run_offline.sh
```

About eight minutes on an Apple Silicon Mac, longer on Intel and in a
container. Every harness writes its log next to the code it exercises and
prints its result; the root script calls each chapter's own `run_all.sh` in
turn and keeps going when one of them fails, so one command covers the whole
book: 154 harnesses across the twenty chapters.

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
MCP_TIMEOUT_MS=300000 ./run_offline.sh
```

### One chapter, one harness

```bash
./chapter14/run_all.sh          # one chapter, natively
cd chapter20/advanced_application_implementation/example/files
npx tsx run_forge.ts            # one artifact
node tools/typecheck_all.mjs chapter20   # types only, no engines
```

`make check` runs the last of those for every project, plus the shared-tree check
and the master server. It does not touch the engines, so it works on Linux too.

## Run live

`run_live.sh` is the other half: the nine entry points that call a real model,
collected behind one script because they all read the same environment.

Put it in one file. `run_live.sh` and `run_everything.sh` read it; source it too if you also run the entry points by hand:

```bash
mkdir -p ~/.config/artcraft
cat > ~/.config/artcraft/env.sh <<'EOF'
export OPENAI_COMPATIBLE_BASE_URL="https://openrouter.ai/api/v1"
export OPENAI_COMPATIBLE_MODEL="deepseek/deepseek-v4.1-flash"
export OPENAI_COMPATIBLE_VISION_MODEL="deepseek/deepseek-v4.1-flash"
export OPENAI_COMPATIBLE_API_KEY="…"            # yours

export EMBEDDING_BASE_URL="https://generativelanguage.googleapis.com/v1beta/openai/"
export EMBEDDING_MODEL="gemini-embedding-2"
export EMBEDDING_API_KEY="…"                     # yours

export SEED_PHOTO_IDS="[1,2,3]"
export LIGHTCRAFT_LIBRARY="$HOME/artcraft-live-library/wedding"
export PG_DSN="postgres://postgres:artcraft@localhost:5432/postgres"
EOF
chmod 600 ~/.config/artcraft/env.sh
source ~/.config/artcraft/env.sh
```

Any OpenAI-compatible endpoint works: change `BASE_URL`, `MODEL` and the key
together, because a key is valid for one endpoint only.

```bash
./run_live.sh --list     # the stages, and what each one needs
./run_live.sh            # run them all
./run_live.sh --only ch5-brief
./run_everything.sh      # offline, then live
```

| variable | what it configures |
| --- | --- |
| `OPENAI_COMPATIBLE_BASE_URL` `…_MODEL` `…_VISION_MODEL` `…_API_KEY` | the model endpoint; `_VISION_MODEL` is the one that accepts images |
| `EMBEDDING_BASE_URL` `EMBEDDING_MODEL` `EMBEDDING_API_KEY` | the embedding endpoint, usually a different provider |
| `SEED_PHOTO_IDS` `LIGHTCRAFT_LIBRARY` `PG_DSN` | chapter 9 only: which frames, where its library is, where its vectors live |

Chapter 9 does not ship photographs. To run it against a fixture:

```bash
tools/make_live_fixtures.sh --write
```

It generates three frames, imports them, seeds the vectors and appends
`SEED_PHOTO_IDS`, `LIGHTCRAFT_LIBRARY` and `PG_DSN` to the environment file.
The frames are a smoke fixture, not photography.

**With Docker.** The container does not see your shell, so pass the environment
in: `source ~/.config/artcraft/env.sh` on the host first, and `compose.yaml`
forwards the variables.

```bash
source ~/.config/artcraft/env.sh
docker compose run --rm artcraft ./run_live.sh
```

Two values mean something different inside the container. `PG_DSN` must reach the
host, not the container's own loopback — use
`postgres://postgres:artcraft@host.docker.internal:5432/postgres`.
`LIGHTCRAFT_LIBRARY` must be a path inside the container, so mount the folder
and point the variable at the mount:

```bash
docker compose run --rm -v "$HOME/artcraft-live-library:/library:ro" \
  -e LIGHTCRAFT_LIBRARY=/library/wedding artcraft ./run_live.sh --only ch9-culling
```

A stage whose requirements are missing is skipped and named, not failed.
`run_offline.sh` is unchanged by any of it.

## Run in Docker

Everything inside the image, no install on the host. The container's default
command is `./run_offline.sh`, so this runs the deterministic suite:

```bash
docker compose build
docker compose run --rm artcraft
```

For the live paths, source the environment on the host and pass the script —
`compose.yaml` forwards the variables:

```bash
source ~/.config/artcraft/env.sh
docker compose run --rm artcraft ./run_live.sh
docker compose run --rm artcraft ./run_everything.sh
```

On Linux and on Windows with Docker Desktop that is the whole story. A container
is slower than a native run, so a harness that waits on an engine can cross the
60-second default:

```bash
docker compose run --rm -e MCP_TIMEOUT_MS=300000 artcraft
```

The sources are mounted into the container rather than copied, so edits are
picked up without a rebuild and the artifacts land on your disk. One chapter:

```bash
docker compose run --rm artcraft ./chapter14/run_all.sh
```

## When something does not start

The five messages a first run actually produces:

| message | what it means | fix |
| --- | --- | --- |
| `photocraft-cli not found at …/tools/craft-cli/bin/photocraft-cli` | the engine binaries were not installed | `tools/install_craft_clis.sh`, then `--check` |
| `no Python 3.10+ interpreter found on the PATH` | macOS ships 3.9, which is too old | install a newer Python, rerun `tools/install_python_deps.sh` |
| `no tsc — run "npm install" first` | you are inside a chapter project, not at the root | `npm ci` at the repository root |
| `Cannot find module '@modelcontextprotocol/sdk'` | the shared `node_modules` is missing | same: `npm ci` at the root |
| a large export stops after sixty seconds | the MCP client's default timeout | `MCP_TIMEOUT_MS=300000 ./run_offline.sh` |

Anything else: the failing harness prints its full output into the project's `output/`,
and the last non-blank line is usually the message that matters. Open an issue with the
chapter, the file and that line.

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
| `tools/make_live_fixtures.sh` | generate the three frames chapter 9's live stage needs, and seed them |
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
