# syntax=docker/dockerfile:1.7

# --------------------------------------------------------------------
# Stage 1 — Builder: install Node deps and compile TypeScript.
# --------------------------------------------------------------------
FROM node:20-bookworm-slim AS builder
WORKDIR /app

# Copy only manifests first so this layer caches across source changes.
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir -p node_modules

COPY src ./src
RUN npx tsc -p tsconfig.json --outDir dist

# --------------------------------------------------------------------
# Stage 2 — Runtime: squeeze everything into a scratch-slim image that
# also bundles the Photocraft CLI binary the docs ship in the
# `photocraft-cli` container tag.
# --------------------------------------------------------------------
FROM node:20-bookworm-slim AS runtime

# Install the ArtCraft CLI. In production pipelines you would pin a
# digest rather than `latest`, e.g. photocraft-cli:0.36.2@sha256:...
COPY --from=photocraft-cli:latest /usr/local/bin/photocraft-cli /usr/local/bin/photocraft-cli
COPY --from=photocraft-cli:latest /usr/local/share/fonts /usr/local/share/fonts

# Create a non-root user — the Rust sandbox refuses to write into
# root-owned paths and CI scanners flag root containers.
RUN useradd --create-home --shell /bin/bash app
WORKDIR /app
COPY --from=builder --chown=app:app /app/dist ./dist
COPY --from=builder --chown=app:app /app/node_modules ./node_modules

ENV NODE_ENV=production \
    PORT=8787 \
    PHOTOCRAFT_GPU=0 \
    RUST_BACKTRACE=1

USER app
EXPOSE 8787

# Signals: the process must handle SIGTERM gracefully; Node does by
# default and `photocraft-cli` child processes inherit the group.
ENTRYPOINT ["node", "dist/banner-service.js"]
