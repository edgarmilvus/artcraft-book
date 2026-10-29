#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
# scripts/forge.sh — one job, one process, capability-scoped roots.
#
# The read/write roots are the engine's own filesystem sandbox. They are NOT
# advisory: a `command_run` that reads outside the read root is rejected by
# the engine, and no amount of clever prompt engineering changes that.
#
# CHAPTER RUN NOTE — the book's version calls three helpers that are not part
# of the chapter's source tree:
#     node ./dist/bin/validate-recipe.js
#     node ./dist/bin/forge.js
#     node ./dist/bin/verify-ledger.js
# There is no validate-recipe.ts / verify-ledger.ts and no build step that
# produces dist/, so those three paths can never resolve. This version runs the
# real entry point (src/bin/forge.ts) through tsx and performs the equivalent
# checks inline: recipe shape, then ledger + master existence.
# ═══════════════════════════════════════════════════════════════════════════
set -Eeuo pipefail

JOB="${1:?usage: forge.sh <job.json>}"
JOB_DIR="$(dirname "$JOB")"
TSX_BIN="${TSX:-./node_modules/.bin/tsx}"

# 1. Validate the recipe before touching an engine. Cheap, and it keeps
#    obviously broken jobs out of the engine's logs.
node -e '
  const fs = require("node:fs");
  const recipe = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  for (const key of ["canvas", "sources", "stack", "delivery"]) {
    if (!recipe[key]) { console.error("recipe is missing: " + key); process.exit(1); }
  }
  console.log(`recipe ok: ${recipe.id} — ${recipe.stack.length} layer(s), ${recipe.delivery.length} deliverable(s)`);
' "$JOB_DIR/recipe.json"

# 2. Run the headless forge. `--no-window` guarantees no GUI dependency,
#    which is what makes this containerisable.
"$TSX_BIN" src/bin/forge.ts \
  --job "$JOB" \
  --photocraft-bin "${PHOTOCRAFT_BIN:-photocraft-cli}" \
  --filmcraft-bin   "${FILMCRAFT_BIN:-filmcraft-cli}" \
  --vectorcraft-bin "${VECTORCRAFT_BIN:-vectorcraft-cli}" \
  --no-window \
  2>&1 | tee "$JOB_DIR/forge.log"

# 3. Verify the ledger and the master, so a partial write is detected here
#    rather than three services downstream.
node -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const job = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
  const ledgerPath = path.resolve(job.writeRoot, `${job.jobId}.provenance.json`);
  const ledger = JSON.parse(fs.readFileSync(ledgerPath, "utf8"));
  if (!ledger.recipeDigest) throw new Error("ledger carries no recipeDigest");
  if (!fs.existsSync(ledger.masterPath)) throw new Error("master is missing: " + ledger.masterPath);
  for (const d of ledger.deliverables || []) {
    if (!fs.existsSync(d.path)) throw new Error("deliverable is missing: " + d.path);
  }
  console.log(`ledger ok: ${ledgerPath} — ${ledger.phases.length} phase(s), ${(ledger.deliverables || []).length} deliverable(s)`);
' "$JOB"
