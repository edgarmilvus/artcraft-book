# syntax=docker/dockerfile:1.7
#
# Runs the book's harnesses on any platform Docker supports.
#
#   docker compose run --rm artcraft            # build, then run the whole book
#   docker compose run --rm artcraft ./chapter14/run_all.sh
#
# The sources are not baked into the image: compose mounts the repository at
# /work, so edits are picked up without a rebuild and the artefacts land on
# your disk.
#
# That is why the build context is empty — see .dockerignore. Nothing here is
# COPYed from the workspace except the engines, which are downloaded.

# ---------------------------------------------------------------------------
# Stage 1 — fetch the Linux builds of the ten engines
# ---------------------------------------------------------------------------
FROM debian:bookworm-slim AS engines

ARG TARGETARCH

ARG PHOTOCRAFT_VER=0.8.2
ARG VECTORCRAFT_VER=0.10.0
ARG FILMCRAFT_VER=0.5.0
ARG DESIGNCRAFT_VER=0.4.0
ARG EFFECTCRAFT_VER=0.4.0
ARG LIGHTCRAFT_VER=0.5.0
ARG WORDCRAFT_VER=0.3.0
ARG PDFCRAFT_VER=0.5.0
ARG DECKCRAFT_VER=0.9.0
ARG GRIDCRAFT_VER=0.10.0

RUN apt-get update \
 && apt-get install -y --no-install-recommends curl ca-certificates tar gzip \
 && rm -rf /var/lib/apt/lists/*

RUN set -eux; \
    case "${TARGETARCH}" in \
      amd64) ARCH=linux-x86_64 ;; \
      arm64) ARCH=linux-aarch64 ;; \
      *) echo "unsupported architecture: ${TARGETARCH}" >&2; exit 1 ;; \
    esac; \
    mkdir -p /staging/bin /staging/tmp; \
    fetch() { \
      app="$1"; ver="$2"; \
      url="https://github.com/storytold/${app}/releases/download/v${ver}/${app}-${ver}-${ARCH}.tar.gz"; \
      echo "fetching ${url}"; \
      curl -fsSL "$url" -o "/staging/tmp/${app}.tar.gz"; \
      mkdir -p "/staging/tmp/${app}"; \
      tar -xzf "/staging/tmp/${app}.tar.gz" -C "/staging/tmp/${app}"; \
      bin="$(find "/staging/tmp/${app}" -type f -name "${app}-cli" | head -n 1)"; \
      test -n "$bin"; \
      cp "$bin" "/staging/bin/${app}-cli"; \
      chmod +x "/staging/bin/${app}-cli"; \
      rm -rf "/staging/tmp/${app}.tar.gz" "/staging/tmp/${app}"; \
    }; \
    fetch photocraft  "${PHOTOCRAFT_VER}"; \
    fetch vectorcraft "${VECTORCRAFT_VER}"; \
    fetch filmcraft   "${FILMCRAFT_VER}"; \
    fetch designcraft "${DESIGNCRAFT_VER}"; \
    fetch effectcraft "${EFFECTCRAFT_VER}"; \
    fetch lightcraft  "${LIGHTCRAFT_VER}"; \
    fetch wordcraft   "${WORDCRAFT_VER}"; \
    fetch pdfcraft    "${PDFCRAFT_VER}"; \
    fetch deckcraft   "${DECKCRAFT_VER}"; \
    fetch gridcraft   "${GRIDCRAFT_VER}"; \
    ls -l /staging/bin

# ---------------------------------------------------------------------------
# Stage 2 — Node, Python and the harnesses' runtime dependencies
# ---------------------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      python3 \
      python3-pip \
      python3-venv \
      curl \
      tini \
      ca-certificates \
      libfontconfig1 \
      libfreetype6 \
      fontconfig \
      fonts-inter \
      fonts-urw-base35 \
      python3-fonttools \
      ffmpeg \
      openssl \
      sqlite3 \
      unzip \
      zip \
      chromium \
 && rm -rf /var/lib/apt/lists/*

ENV VIRTUAL_ENV=/opt/venv
RUN python3 -m venv "$VIRTUAL_ENV"
ENV PATH="$VIRTUAL_ENV/bin:$PATH"

COPY tools/requirements.txt /opt/artcraft/requirements.txt

RUN pip install --no-cache-dir --upgrade pip \
 && pip install --no-cache-dir -r /opt/artcraft/requirements.txt \
 && pip install --no-cache-dir "psycopg[binary]"

COPY --from=engines /staging/bin/ /opt/artcraft/bin/

# The chapter 6 harnesses assert that saving produces no font warnings, and
# the engines look fonts up by literal family name — fontconfig's Helvetica
# alias is not consulted. Nimbus Sans is the metric clone of Helvetica, so it
# is re-registered under the name the engines look for.
RUN mkdir -p /usr/share/fonts/truetype/helvetica \
 && /usr/bin/python3 - <<'RENAME'
from fontTools.ttLib import TTFont
src = "/usr/share/fonts/opentype/urw-base35/NimbusSans-%s.otf"
dst = "/usr/share/fonts/truetype/helvetica/Helvetica-%s.otf"
for weight, sub in (("Regular", "Regular"), ("Bold", "Bold"), ("Italic", "Oblique")):
    font = TTFont(src % weight)
    for rec in font["name"].names:
        if rec.nameID in (1, 16):
            rec.string = "Helvetica"
        elif rec.nameID == 4:
            rec.string = "Helvetica %s" % sub
        elif rec.nameID == 6:
            rec.string = "Helvetica-%s" % sub
    font.save(dst % sub)
RENAME
RUN fc-cache -f

# The chapter 15 listings launch a browser at the macOS path, and Playwright's
# "chrome" channel looks in /opt/google/chrome. Both are satisfied by pointing
# them at the distribution's chromium, so the book's code needs no change.
RUN mkdir -p "/Applications/Google Chrome.app/Contents/MacOS" /opt/google/chrome \
 && ln -sf /usr/bin/chromium "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
 && ln -sf /usr/bin/chromium /opt/google/chrome/chrome

# The engines have to sit inside the mounted repository, because the harnesses
# resolve them by absolute path from the repo root. They are copied from the
# image into a named volume on first start, so the host folder is not touched
# and later runs find them already in place.
RUN cat > /usr/local/bin/artcraft-entry.sh <<'ENTRY'
#!/bin/sh
set -e

BIN=/work/tools/craft-cli/bin
if [ ! -x "$BIN/photocraft-cli" ]; then
  echo "installing engines into $BIN"
  mkdir -p "$BIN"
  cp /opt/artcraft/bin/* "$BIN/"
  chmod +x "$BIN"/*
fi

if [ ! -x /work/node_modules/.bin/tsc ]; then
  echo "installing node dependencies"
  cd /work && npm install --no-audit --no-fund
fi

exec "$@"
ENTRY
RUN chmod +x /usr/local/bin/artcraft-entry.sh

ENV npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false

ENV PHOTOCRAFT_DISABLE_GPU=1 \
    WGPU_BACKEND=cpu \
    PHOTOCRAFT_CONFIG_DIR=/tmp/photocraft \
    RUST_BACKTRACE=1

WORKDIR /work

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/artcraft-entry.sh"]
CMD ["./run_all.sh"]
