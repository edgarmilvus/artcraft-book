# ---- Dockerfile (multi-stage) ----
FROM rust:1.83-bookworm AS builder
WORKDIR /src
COPY . .
RUN cargo build --release --bin photocraft-cli

FROM debian:bookworm-slim AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates libfontconfig1 libfreetype6 libgl1 libglx0 libglib2.0-0 \
 && rm -rf /var/lib/apt/lists/*

# Non-root craft user with a fixed UID.
RUN groupadd -g 10001 craft && useradd -u 10001 -g craft -m craft

# Font set for deterministic text shaping.
COPY Fonts/ /usr/share/fonts/truetype/craft/
RUN fc-cache -f -v

COPY --from=builder /src/target/release/photocraft-cli /usr/local/bin/photocraft-cli
RUN chmod 0755 /usr/local/bin/photocraft-cli

COPY orchestrator.js /opt/orchestrator/orchestrator.js

# The orchestrator turns these into --automation-read-root / --automation-write-root.
ENV ASSET_ROOT=/work/assets \
    OUT_ROOT=/work/output

# Build-time smoke test: open a 64x64 document, render an 8-px preview and close
# it through the same MCP client production uses. This proves the CLI boots and
# completes the handshake inside the image. It does not persist a font cache:
# fonts are indexed per process, and the persistent cache is the `fc-cache` run
# above, after the Fonts/ copy.
RUN mkdir -p /work/assets /work/output && \
    ASSET_ROOT=/work/assets OUT_ROOT=/work/output \
    node /opt/orchestrator/orchestrator.js --warmup

USER craft
WORKDIR /work
# Runtime contract reminder (enforced by the K8s spec, shown here for local docker run):
#   docker run --memory=2g --cpus=2 --read-only --tmpfs /tmp:size=512m \
#              -v /host/assets:/work/assets:ro -v /host/output:/work/output \
#              banner-factory
ENTRYPOINT ["node", "/opt/orchestrator/orchestrator.js"]
