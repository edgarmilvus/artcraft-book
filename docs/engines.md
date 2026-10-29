# Getting the engines, and what happens if they vanish

The harnesses drive ten Apache-2.0 CLIs — `photocraft-cli`,
`vectorcraft-cli`, `filmcraft-cli`, `designcraft-cli`, `effectcraft-cli`,
`lightcraft-cli`, `wordcraft-cli`, `pdfcraft-cli`, `gridcraft-cli`,
`deckcraft-cli`. They are not committed here. This page is about where they
come from, and what to do when *where they come from* is unavailable.

## The normal path

```bash
tools/install_craft_clis.sh            # install what is missing
tools/install_craft_clis.sh --check    # verify what is installed
```

The script reads the pinned versions from
[`tools/craft-cli/versions.txt`](../tools/craft-cli/versions.txt), downloads
each macOS archive from the vendor's GitHub releases
(`github.com/storytold/<app>`), verifies the binary against
[`tools/craft-cli/SHA256SUMS`](../tools/craft-cli/SHA256SUMS) and unpacks it
into `tools/craft-cli/bin/`. The Dockerfile reads the same versions file, so
the native install and the image cannot drift.

Because the version is pinned and the hash is checked, a re-uploaded asset
cannot silently change what a reader installs: the checksum fails and the
script stops. What a checksum cannot survive is an asset being **deleted**.

## Fallback 1 — the mirror release (native, macOS)

The ten macOS archives are mirrored in this repository's
[`craft-cli-v1`](../../releases/tag/craft-cli-v1) release, taken from the
vendor's releases at the pinned versions. The installer already understands a
flat mirror layout:

```bash
CRAFT_CLI_SOURCE=https://github.com/edgarmilvus/artcraft-book/releases/download/craft-cli-v1 \
  tools/install_craft_clis.sh
```

`CRAFT_CLI_SOURCE` also accepts any GitHub Enterprise host, an S3 bucket or a
local directory (`file:///Volumes/artcraft-releases`), which is the pattern to
use if you want your own mirror rather than this one.

## Fallback 2 — the container image (any platform)

The image carries the Linux builds of the ten engines plus the Node and Python
runtime the harnesses need, so a Docker user needs no download at all:

```bash
docker run --rm -v "$PWD:/work" -w /work -e MCP_TIMEOUT_MS=300000 \
  ghcr.io/edgarmilvus/artcraft-engines:latest ./chapter14/run_all.sh
```

`MCP_TIMEOUT_MS` matters here: the engine calls have a 60-second default, and a
container without a GPU can exceed it on the first launch. The default is fine
natively and too short inside the image.

The sources are not baked into the image — you mount your clone — and the
image is rebuilt from `tools/craft-cli/versions.txt` by
`.github/workflows/docker.yml`. Pull with your own token
(`docker login ghcr.io`) if anonymous pulls start being rate-limited.

## Verifying what you have

```bash
tools/install_craft_clis.sh --check          # native, against SHA256SUMS
shasum -a 256 -c SHA256SUMS.macos.txt        # the mirror archives, if downloaded
docker run --rm ghcr.io/edgarmilvus/artcraft-engines:latest \
  sh -c '/opt/artcraft/bin/photocraft-cli --version'
```

## Licensing

All ten engines are Apache-2.0. Redistributing the archives and packaging the
binaries in a public image is therefore permitted, with the obligations the
licence carries, and this repository meets them:

- each vendor archive carries its `LICENSE-APACHE` and `LICENSE-MIT` inside it,
  exactly as shipped;
- the ten `NOTICE` files are reproduced in [`docs/notices/`](notices/), because
  the vendor archives do not include them;
- the image is labelled with its licence and its source, and nothing here claims
  to be an official vendor build.

The book's own code is MIT; see [LICENSE](../LICENSE).
