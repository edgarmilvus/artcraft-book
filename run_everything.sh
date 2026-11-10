#!/bin/sh
# Runs everything: the deterministic suite, then every live stage.
#
#   run_offline.sh      the 154 harnesses: real engines, scripted model, no key
#   run_live.sh         the nine entry points that call a model
#   run_everything.sh   this file: both, and it brings up what the live half
#                       needs instead of skipping it
#
# The live half needs a model endpoint (OPENAI_COMPATIBLE_*) and, for chapter
# 9, a Postgres with pgvector. This script starts that container when Docker
# is available, creates the schema if it is missing, and then runs every stage
# it can. Anything still skipped is named with the variable it needs — nothing
# is skipped silently.
set -u

ROOT=$(cd "$(dirname "$0")" && pwd)
PG_NAME=artcraft-pg
PG_PASSWORD=${PG_PASSWORD:-artcraft}
PG_PORT=${PG_PORT:-5432}

say() { printf '%s\n' "$*"; }

ensure_postgres() {
  command -v docker >/dev/null 2>&1 || return 1
  docker info >/dev/null 2>&1 || return 1

  if ! docker ps --format '{{.Names}}' | grep -qx "$PG_NAME"; then
    docker start "$PG_NAME" >/dev/null 2>&1 || \
      docker run -d --name "$PG_NAME" -p "$PG_PORT:5432" \
        -e "POSTGRES_PASSWORD=$PG_PASSWORD" pgvector/pgvector:pg16 >/dev/null || return 1
  fi

  i=0
  while [ "$i" -lt 30 ]; do
    docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1 && break
    i=$((i + 1)); sleep 1
  done
  docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1 || return 1

  docker exec -i "$PG_NAME" psql -U postgres -q >/dev/null 2>&1 <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS image_vectors (photo_id bigint PRIMARY KEY, fused vector(512) NOT NULL, captured timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS photo_faces (photo_id bigint NOT NULL, face_index int NOT NULL, bbox jsonb NOT NULL, PRIMARY KEY (photo_id, face_index));
CREATE TABLE IF NOT EXISTS eye_cache (photo_id bigint NOT NULL, face_index int NOT NULL, left_open boolean NOT NULL, right_open boolean NOT NULL, confidence real NOT NULL, PRIMARY KEY (photo_id, face_index));
CREATE TABLE IF NOT EXISTS burst_clusters (cluster_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), photo_ids bigint[] NOT NULL, label text, created_at timestamptz NOT NULL DEFAULT now());
SQL
  export PG_DSN="${PG_DSN:-postgres://postgres:$PG_PASSWORD@localhost:$PG_PORT/postgres}"
  return 0
}

"$ROOT/run_offline.sh"
offline=$?

if [ -z "${OPENAI_COMPATIBLE_API_KEY:-}" ] || [ -z "${OPENAI_COMPATIBLE_BASE_URL:-}" ]; then
  printf '\nlive paths skipped: OPENAI_COMPATIBLE_API_KEY and OPENAI_COMPATIBLE_BASE_URL are not set\n'
  exit "$offline"
fi

printf '\n'
if ensure_postgres; then
  say "postgres: $PG_NAME is up, schema present, PG_DSN exported"
else
  say "postgres: unavailable (no Docker, or the container did not start); chapter 9 will be skipped"
fi

if [ -z "${SEED_PHOTO_IDS:-}" ]; then
  say "chapter 9 also needs SEED_PHOTO_IDS; it will be skipped"
fi

printf '\n'
"$ROOT/run_live.sh"
live=$?

printf '\n'
say "summary: offline=$offline live=$live"
if [ "$offline" -eq 0 ] && [ "$live" -eq 0 ]; then
  exit 0
fi
exit 1
