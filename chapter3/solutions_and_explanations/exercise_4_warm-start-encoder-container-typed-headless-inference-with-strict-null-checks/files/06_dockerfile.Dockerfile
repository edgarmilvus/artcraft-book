# ---- Dockerfile (3-stage, distroless final, ≤3 layers after final COPY) ----
# Stage 1 — build
FROM node:22-bookworm AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc --build \
 && find dist -name '*.map' -delete

# Stage 2 — prune native bindings check
FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm prune --omit=dev \
 && node -e "require('onnxruntime-node'); console.log('onnx OK')"

# Stage 3 — distroless final
FROM gcr.io/distroless/nodejs22-debian12
WORKDIR /app
# Only three COPYs land after this point → three fs layers for runtime content.
COPY --from=deps  /app/node_modules ./node_modules
COPY --from=build /app/dist         ./dist
COPY models/brand-classifier-v4.onnx ./models/brand-classifier-v4.onnx
USER 1000:1000
EXPOSE 8080
# ENTRYPOINT is set by the base image to `node`, so we only supply args.
CMD ["/app/dist/server.js"]
