# tools/ — the local toolchain for running the book's examples

Everything here is **local to the repository**: no global installs, no admin
rights, and it all runs natively on macOS.

## Layout

| Path | What |
| --- | --- |
| `node/` | Node 22 (darwin) + npm, downloaded from nodejs.org — *not committed* |
| `craft-cli/bin/` | the ten ArtCraft macOS CLIs (`photocraft-cli`, …) — *not committed* |
| `craft-cli/<app>-<ver>/` | the extracted release payloads (licenses, docs) — *not committed* |
| `craft-cli/SHA256SUMS` | the checksums `install_craft_clis.sh` verifies |
| `craft-cli/FACTS-ch*.md` | the engines' real surfaces, written by running them |
| `install_craft_clis.sh` | (Re)downloads and verifies the CLIs |
| `install_node.sh` | (Re)downloads the pinned Node |
| `install_python_deps.sh` | builds the repository's `.venv` |
| `requirements.txt` | the Python packages that `.venv` contains |
| `pick_python.sh` | prints the path of a Python 3.10+ interpreter |
| `env.sh` | `source tools/env.sh` to put Node and the CLIs on `PATH` |
| `link_node_modules.mjs` | points the chapter projects at the root `node_modules` |
| `typecheck_all.mjs` | type-checks every chapter project |
| `check_project_readmes.py` | checks every project README against the files it names |

The first three rows are produced by the installers and are listed here so you
know what to expect after running them; they are not in the repository.

## Quick start

```bash
source tools/env.sh
photocraft-cli commands | head
node -v
```

`photocraft-cli commands` answers with 892 engine commands; `node -v`
should report v22.x.

## Notes

- The CLIs are the **macOS universal** builds, published per release as
  `<app>-cli-<ver>-macos-universal.zip`. Because they exist, the examples run
  without Docker on Apple Silicon.
- Versions: photocraft 0.8.2, vectorcraft 0.10.0, filmcraft 0.5.0,
  designcraft 0.4.0, effectcraft 0.4.0, lightcraft 0.5.0, wordcraft 0.3.0,
  pdfcraft 0.5.0, gridcraft 0.10.0, deckcraft 0.9.0.
- The binaries are proprietary and are **never committed**.
  `install_craft_clis.sh` downloads them and checks the SHA-256 against
  `craft-cli/SHA256SUMS`; set `CRAFT_CLI_SOURCE` to install from a mirror.
- The engines do **not** share a dialect. `craft-cli/FACTS-ch*.md` records what
  each one actually speaks.

## `../master_mcp_server.ts` — one MCP server for all ten CLIs

Fronts every app CLI behind a single `artcraft_run` tool, so a client that
speaks MCP only once can reach all ten engines:

```bash
ARTCRAFT_ROOT="$PWD" npx tsx master_mcp_server.ts
```

`ARTCRAFT_ROOT` sets the working directory for the spawned CLIs and the root
the engine paths are resolved against. The server takes the document source
from the request, so `cli run` never starts from an empty session:

```json
{ "id": "shape.create", "out": "master.png" }
```

That call produces a 1920×1080 PNG through PhotoCraft.
