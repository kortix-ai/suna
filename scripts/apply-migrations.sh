#!/usr/bin/env bash
#
# Apply supabase/migrations/*.sql to $DATABASE_URL, tracked in
# kortix.schema_migrations, idempotently. This is the prod migration mechanism:
# deploy-prod runs it BEFORE rolling the API image, so new code never serves
# against a DB that's missing its columns/tables (the class of bug that caused
# the /triggers 500 on 2026-06-21 when migration 122 was never applied).
#
# Guarantees:
#   - Only files NOT already recorded in kortix.schema_migrations are applied.
#   - Each file is applied AND stamped into the ledger in ONE transaction
#     (psql -1): either the whole file commits together with its ledger row, or
#     everything rolls back and we record nothing. There is no apply-but-
#     unrecorded window, and no half-applied file.
#   - The ledger is the ONLY source of truth for "already applied". We never
#     infer success from an error message: under a single transaction a
#     duplicate-object error rolls the WHOLE file back (losing new objects
#     created earlier in it), so recording it on "already exists" would silently
#     leave prod missing schema while future deploys skip the file.
#   - Any failure HALTS with a clear error (exit 1) having recorded nothing, so
#     the deploy stops instead of rolling new code against a half-migrated DB.
#     Migrations are expected to be idempotent (IF NOT EXISTS / DO-block guards,
#     see e.g. 00000000000121_project_access_requests.sql), so a legitimate
#     re-run commits cleanly; a genuine non-idempotent collision is a real
#     problem and SHOULD stop the deploy for a human. Re-running after a fix is
#     safe.
#   - The one-time bootstrap (00000000000000) is skipped — it needs superuser and
#     is applied at DB creation, not as an incremental migration.
#
# Usage: DATABASE_URL=postgres://… scripts/apply-migrations.sh
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_DIR="$ROOT/supabase/migrations"
PSQL=(psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1)

echo "[migrate] ensuring kortix.schema_migrations ledger…"
"${PSQL[@]}" -c "CREATE SCHEMA IF NOT EXISTS kortix;
CREATE TABLE IF NOT EXISTS kortix.schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);" || { echo "::error::[migrate] cannot create schema_migrations ledger"; exit 1; }

# Snapshot already-applied versions.
APPLIED_ROWS="$("${PSQL[@]}" -At -c "SELECT version FROM kortix.schema_migrations")"
mapfile -t APPLIED <<< "$APPLIED_ROWS"
declare -A SEEN=()
for a in "${APPLIED[@]:-}"; do [ -n "$a" ] && SEEN["$a"]=1; done

applied=0 skipped=0
shopt -s nullglob
for f in "$MIG_DIR"/*.sql; do
  v="$(basename "$f")"
  [ "$v" = "00000000000000_bootstrap.sql" ] && continue
  if [ -n "${SEEN[$v]:-}" ]; then skipped=$((skipped + 1)); continue; fi

  echo "[migrate] applying $v"
  # Apply the file AND stamp the ledger in a single transaction: the leading
  # `-1` wraps the `-f` (migration file) and the `-c` (ledger insert) so they
  # commit or roll back together. `$v` is a migration filename (safe charset,
  # shell-expanded here — psql never sees a variable to interpolate).
  if out="$("${PSQL[@]}" -1 \
              -f "$f" \
              -c "INSERT INTO kortix.schema_migrations (version) VALUES ('$v') ON CONFLICT DO NOTHING" 2>&1)"; then
    applied=$((applied + 1))
  else
    echo "::error::[migrate] $v FAILED — halting before deploy (nothing recorded; safe to re-run after fixing):"
    echo "$out"
    exit 1
  fi
done

echo "[migrate] done — applied=$applied skipped(already-recorded)=$skipped"
