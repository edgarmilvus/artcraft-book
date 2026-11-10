#!/bin/sh
# Creates the small fixture chapter 9's live stage needs: three photographs in
# a LightCraft library, their ids, and their vectors in Postgres.
#
#   tools/make_live_fixtures.sh              # prints the two variables
#   tools/make_live_fixtures.sh --write      # also appends them to live.env
#
# Idempotent: the folder is regenerated, the photos are re-imported only if the
# library is empty, and the rows are upserted.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
export PATH="$ROOT/tools/craft-cli/bin:$PATH"

LIB="${LIGHTCRAFT_LIBRARY:-$HOME/artcraft-live-library}"
PHOTOS="$LIB/photos"
PG_NAME="${PG_NAME:-artcraft-pg}"
PG_PASSWORD="${PG_PASSWORD:-artcraft}"
PG_PORT="${PG_PORT:-5432}"
PG_DSN="${PG_DSN:-postgres://postgres:$PG_PASSWORD@localhost:$PG_PORT/postgres}"
WRITE=0
[ "${1:-}" = "--write" ] && WRITE=1
PG_OK=0

say() { printf '%s\n' "$*"; }

command -v lightcraft-cli >/dev/null 2>&1 || {
  say "lightcraft-cli not found. Run tools/install_craft_clis.sh first." >&2
  exit 1
}

PY=""
if [ -x "$ROOT/.venv/bin/python" ]; then PY="$ROOT/.venv/bin/python"; fi
if [ -z "$PY" ]; then PY=$(command -v python3) || { say "no python3 on PATH" >&2; exit 1; }; fi

say "library:  $LIB"
mkdir -p "$PHOTOS"

"$PY" - "$PHOTOS" <<'PY'
import sys, pathlib
from PIL import Image

out = pathlib.Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
for i, base in enumerate([(70, 60, 55), (90, 75, 60), (50, 45, 42)], start=1):
    img = Image.new("RGB", (900, 600))
    px = img.load()
    for y in range(600):
        for x in range(900):
            # a checkerboard, so sharpness is not zero
            v = 18 if ((x // 9) + (y // 9)) % 2 else 0
            px[x, y] = ((base[0] + v + x // 30) % 256,
                        (base[1] + v + y // 35) % 256,
                        (base[2] + v) % 256)
    img.save(out / f"fixture_{i}.jpg", quality=90)
print(f"wrote 3 jpgs to {out}")
PY

say "importing into the library"
lightcraft-cli run --library "$LIB" --import "$PHOTOS" catalog.query limit=100 >/tmp/fixtures-query.json 2>/dev/null || {
  say "import failed; is the library writable?" >&2; exit 1; }

IDS=$("$PY" - <<'PY'
import json, sys
ids = []
for line in open("/tmp/fixtures-query.json"):
    try: d = json.loads(line)
    except Exception: continue
    if d.get("command") != "catalog.query": continue
    for p in d.get("result", {}).get("photos", []):
        if str(p.get("fileName", "")).startswith("fixture_") and str(p.get("fileName","")).endswith(".jpg"):
            ids.append(int(p["id"]))
print(json.dumps(sorted(ids)))
PY
)
[ "$IDS" = "[]" ] && { say "no fixture photos came back from the library" >&2; exit 1; }
say "photo ids: $IDS"

# --- Postgres ---------------------------------------------------------------
if ! docker info >/dev/null 2>&1; then
  if [ -d /Applications/Docker.app ]; then
    say "starting Docker Desktop"
    open -a Docker >/dev/null 2>&1
    i=0; while [ "$i" -lt 60 ] && ! docker info >/dev/null 2>&1; do i=$((i+1)); sleep 2; done
  fi
fi

if docker info >/dev/null 2>&1; then
  docker start "$PG_NAME" >/dev/null 2>&1 || \
    docker run -d --name "$PG_NAME" -p "$PG_PORT:5432" -e "POSTGRES_PASSWORD=$PG_PASSWORD" pgvector/pgvector:pg16 >/dev/null
  i=0; while [ "$i" -lt 30 ] && ! docker exec "$PG_NAME" pg_isready -U postgres >/dev/null 2>&1; do i=$((i+1)); sleep 1; done

  docker exec -i "$PG_NAME" psql -U postgres -q >/dev/null <<'SQL'
CREATE EXTENSION IF NOT EXISTS vector;
CREATE TABLE IF NOT EXISTS image_vectors (photo_id bigint PRIMARY KEY, fused vector(512) NOT NULL, captured timestamptz NOT NULL);
CREATE TABLE IF NOT EXISTS photo_faces (photo_id bigint NOT NULL, face_index int NOT NULL, bbox jsonb NOT NULL, PRIMARY KEY (photo_id, face_index));
CREATE TABLE IF NOT EXISTS eye_cache (photo_id bigint NOT NULL, face_index int NOT NULL, left_open boolean NOT NULL, right_open boolean NOT NULL, confidence real NOT NULL, PRIMARY KEY (photo_id, face_index));
CREATE TABLE IF NOT EXISTS burst_clusters (cluster_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), photo_ids bigint[] NOT NULL, label text, created_at timestamptz NOT NULL DEFAULT now());
SQL

  SQL=$("$PY" - "$IDS" <<'PY'
import json, math, sys
ids = json.loads(sys.argv[1])
rows = []
for n, pid in enumerate(ids):
    vec = "[" + ",".join(f"{math.sin((i + 37 * pid) / 7.0):.6f}" for i in range(512)) + "]"
    rows.append(f"({pid}, '{vec}', now() - interval '{n * 3} seconds')")
print("INSERT INTO image_vectors(photo_id, fused, captured) VALUES " + ",".join(rows) +
      " ON CONFLICT (photo_id) DO UPDATE SET fused = EXCLUDED.fused, captured = EXCLUDED.captured;")
PY
)
  docker exec -i "$PG_NAME" psql -U postgres -q -c "$SQL" >/dev/null
  say "postgres: 3 rows in image_vectors, schema present"
  PG_OK=1
else
  say "postgres: Docker unavailable, vectors not seeded; run this again once Docker is up" >&2
fi

say ""
say "Add these to the live configuration (or rerun with --write):"
say "  SEED_PHOTO_IDS=$IDS"
say "  LIGHTCRAFT_LIBRARY=$LIB"
[ "$PG_OK" = 1 ] && say "  PG_DSN=$PG_DSN"

if [ "$WRITE" = 1 ]; then
  ENV_FILE="${ARTCRAFT_LIVE_ENV:-$HOME/.config/artcraft/live.env}"
  mkdir -p "$(dirname "$ENV_FILE")"
  "$PY" - "$ENV_FILE" "$IDS" "$LIB" "$PG_OK" "$PG_DSN" <<'PY'
import sys, pathlib
path, ids, lib, pg_ok, pg_dsn = pathlib.Path(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
lines = []
if path.exists():
    lines = [l for l in path.read_text().splitlines()
             if not l.startswith(("SEED_PHOTO_IDS=", "LIGHTCRAFT_LIBRARY=", "PG_DSN="))]
lines += [f"SEED_PHOTO_IDS={ids}", f"LIGHTCRAFT_LIBRARY={lib}"]
if pg_ok == "1":
    lines.append(f"PG_DSN={pg_dsn}")
path.write_text("\n".join(lines) + "\n")
path.chmod(0o600)
print(f"wrote {path}")
PY
fi
