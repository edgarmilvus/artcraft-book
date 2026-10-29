# Dockerfile
# --- Stage 1: build the TypeScript worker -----------------------------
FROM node:20.11-bookworm-slim AS build
WORKDIR /src
COPY package.json package-lock.json tsconfig.json ./
RUN npm ci --frozen-lockfile
COPY src ./src
RUN npm run build
# Drop the TypeScript toolchain before the runtime stage copies node_modules.
RUN npm prune --omit=dev

# --- Stage 2: bring in the Craft CLIs ---------------------------------
# In a real deployment these would be released binaries; here we build
# them from the pinned ArtCraft monorepo tag so the image is reproducible.
FROM rust:1.79-bookworm AS craft
ARG CRAFT_VERSION=v1.4.0
RUN apt-get update && apt-get install -y --no-install-recommends \
      pkg-config libfontconfig1-dev && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 --branch ${CRAFT_VERSION} \
      https://github.com/artcraft/artcraft-support.git /craft \
 && cargo build --release --manifest-path /craft/Cargo.toml \
      -p photocraft-cli -p designcraft-cli

# --- Stage 3: minimal runtime -----------------------------------------
FROM node:20.11-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    CRAFT_IN_ROOT=/work/in \
    CRAFT_OUT_ROOT=/work/out

# Non-root user; the Craft CLIs write only under CRAFT_OUT_ROOT.
RUN useradd --create-home --shell /usr/sbin/nologin craft \
 && mkdir -p /work/in /work/out /opt/craft/bin \
 && chown -R craft:craft /work

COPY --from=craft /craft/target/release/photocraft-cli /opt/craft/bin/
COPY --from=craft /craft/target/release/designcraft-cli /opt/craft/bin/
COPY --from=build /src/dist /src/node_modules /src/package.json /app/
WORKDIR /app

ENV PATH="/opt/craft/bin:${PATH}"

USER craft
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+process.env.PORT+'/v1/render',{method:'OPTIONS'}).then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"

CMD ["node", "--enable-source-maps", "dist/index.js"]
