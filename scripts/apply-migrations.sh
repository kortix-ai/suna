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
#   - Each file runs in a single transaction (--single-transaction) → a failing
#     file rolls back wholly and is NOT recorded.
#   - A real failure HALTS with a clear error (exit 1) so the deploy stops
#     instead of rolling new code against a half-migrated DB. Re-running is safe.
#   - The one-time bootstrap (00000000000000) is skipped — it needs superuser and
#     is applied at DB creation, not as an incremental migration.
#
# Usage: DATABASE_URL=postgres://… scripts/apply-migrations.sh
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MIG_DIR="$ROOT/supabase/migrations"
PSQL=(psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1)

record_applied() {
  local version="$1"
  "${PSQL[@]}" -v migration_version="$version" >/dev/null <<'SQL'
INSERT INTO kortix.schema_migrations (version)
VALUES (:'migration_version')
ON CONFLICT DO NOTHING;
SQL
}

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
  if out="$("${PSQL[@]}" --single-transaction -f "$f" 2>&1)"; then
    record_applied "$v"
    applied=$((applied + 1))
  elif echo "$out" | grep -qiE "already exists|duplicate|already a member of"; then
    # The file's objects are already present (a safe re-run of an idempotent or
    # previously-applied migration). Record it and move on.
    echo "[migrate]   ↳ objects already present — recording $v as applied"
    record_applied "$v"
    applied=$((applied + 1))
  else
    echo "::error::[migrate] $v FAILED — halting before deploy:"
    echo "$out"
    exit 1
  fi
done

echo "[migrate] done — applied=$applied skipped(already-recorded)=$skipped"
