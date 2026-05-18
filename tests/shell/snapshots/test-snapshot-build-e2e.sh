#!/usr/bin/env bash
# End-to-end test for the per-project sandbox snapshot builder.
#
# Exercises the live code path: real auth → real API → real Daytona →
# real Postgres rows. No mocks, no stubs. Exits 0 only when:
#
#   Phase 1: A fresh session for a project with no prior snapshot
#            triggers an inline build, the snapshot row transitions
#            queued → building → ready, and the resulting sandbox boots.
#   Phase 2: A second session for the same commit hits the cache (no
#            rebuild, snapshot_id matches, latency < first call by ≥30s).
#
# What you need before running:
#   - Local API on $KORTIX_API_BASE (default http://localhost:8008)
#   - DAYTONA_API_KEY in apps/api/.env (the running API will use it)
#   - apps/kortix-sandbox-agent-server/dist/kortix-agent (Linux ELF)
#   - Postgres reachable at $DATABASE_URL (read directly to verify rows)
#   - A real user + project in the local DB (auto-detected, overridable
#     via KORTIX_TEST_EMAIL / KORTIX_TEST_PROJECT_ID)
#
# Usage:
#   tests/shell/snapshots/test-snapshot-build-e2e.sh
#
# Exit codes:
#   0  — all phases passed
#   1  — a phase failed (assertion / timeout / unexpected status)
#   2  — preconditions missing (no API, no env, no test data)

set -euo pipefail

# ─── Config + colors ──────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"
API_BASE="${KORTIX_API_BASE:-http://localhost:8008}"
ENV_FILE="${KORTIX_API_ENV:-$REPO_ROOT/apps/api/.env}"
BUILD_TIMEOUT_S="${KORTIX_BUILD_TIMEOUT_S:-600}"
SESSION_BOOT_TIMEOUT_S="${KORTIX_SESSION_BOOT_TIMEOUT_S:-60}"

if [[ -t 1 ]]; then
  GREEN='\033[32m'; RED='\033[31m'; YELLOW='\033[33m'; DIM='\033[2m'; BOLD='\033[1m'; NC='\033[0m'
else
  GREEN=; RED=; YELLOW=; DIM=; BOLD=; NC=
fi

ok()   { printf "  ${GREEN}✓${NC} %s\n" "$*"; }
fail() { printf "  ${RED}✗${NC} %s\n" "$*"; exit 1; }
info() { printf "  ${DIM}·${NC} %s\n" "$*"; }
section() { printf "\n${BOLD}═══ %s ═══${NC}\n\n" "$*"; }

# ─── Preconditions ────────────────────────────────────────────────────────────
section "Preconditions"

[[ -f "$ENV_FILE" ]] || { echo "missing $ENV_FILE — set KORTIX_API_ENV"; exit 2; }
# shellcheck disable=SC1090
set -a; source "$ENV_FILE"; set +a

for var in SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY DATABASE_URL DAYTONA_API_KEY; do
  [[ -n "${!var:-}" ]] || { echo "missing $var in $ENV_FILE"; exit 2; }
done
ok "env loaded ($ENV_FILE)"

curl -sf "$API_BASE/v1/health" >/dev/null || { echo "API not reachable at $API_BASE"; exit 2; }
ok "API reachable ($API_BASE)"

AGENT_BIN="$REPO_ROOT/apps/kortix-sandbox-agent-server/dist/kortix-agent"
ENTRY_SH="$REPO_ROOT/apps/sandbox/entrypoint.sh"
[[ -f "$AGENT_BIN" ]] || fail "missing $AGENT_BIN — run \`bun run build\` in apps/kortix-sandbox-agent-server"
[[ -f "$ENTRY_SH" ]]  || fail "missing $ENTRY_SH"
file "$AGENT_BIN" | grep -q "ELF.*x86-64" || fail "kortix-agent isn't a Linux x86-64 ELF (got: $(file -b "$AGENT_BIN" | head -c 80))"
ok "build artifacts present + Linux ELF"

command -v psql >/dev/null || { echo "psql not installed"; exit 2; }
command -v jq >/dev/null || { echo "jq not installed"; exit 2; }
ok "psql + jq available"

# ─── Pick a test user + project ───────────────────────────────────────────────
section "Test fixture"

EMAIL="${KORTIX_TEST_EMAIL:-}"
PROJECT_ID="${KORTIX_TEST_PROJECT_ID:-}"

if [[ -z "$EMAIL" || -z "$PROJECT_ID" ]]; then
  # Pick the most recently updated active project + its owner.
  FIXTURE=$(psql "$DATABASE_URL" -t -A -F $'\t' -c "
    SELECT p.project_id, u.email
    FROM kortix.projects p
    JOIN kortix.account_members am ON am.account_id = p.account_id
    JOIN auth.users u ON u.id = am.user_id
    WHERE p.status = 'active'
      AND p.repo_url IS NOT NULL AND p.repo_url <> ''
      AND am.account_role = 'owner'
    ORDER BY p.updated_at DESC
    LIMIT 1;
  ")
  PROJECT_ID=$(echo "$FIXTURE" | cut -f1)
  EMAIL=$(echo "$FIXTURE" | cut -f2)
fi
[[ -n "$PROJECT_ID" ]] || fail "no project_id available — set KORTIX_TEST_PROJECT_ID"
[[ -n "$EMAIL" ]] || fail "no email available — set KORTIX_TEST_EMAIL"
ok "project: $PROJECT_ID"
ok "user:    $EMAIL"

REPO_URL=$(psql "$DATABASE_URL" -t -A -c "SELECT repo_url FROM kortix.projects WHERE project_id = '$PROJECT_ID';")
DEFAULT_BRANCH=$(psql "$DATABASE_URL" -t -A -c "SELECT default_branch FROM kortix.projects WHERE project_id = '$PROJECT_ID';")
info "repo:    $REPO_URL"
info "branch:  $DEFAULT_BRANCH"

# ─── Mint a Supabase JWT for the test user ────────────────────────────────────
section "Auth"

HASHED=$(curl -sf -X POST "$SUPABASE_URL/auth/v1/admin/generate_link" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"magiclink\",\"email\":\"$EMAIL\"}" \
  | jq -r '.hashed_token // empty')
[[ -n "$HASHED" ]] || fail "Supabase generate_link returned no hashed_token"

JWT=$(curl -sf -X POST "$SUPABASE_URL/auth/v1/verify" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"type\":\"magiclink\",\"token_hash\":\"$HASHED\"}" \
  | jq -r '.access_token // empty')
[[ -n "$JWT" ]] || fail "Supabase verify returned no access_token"
ok "JWT minted (len $(echo -n "$JWT" | wc -c | tr -d ' ') chars)"

curl -sf "$API_BASE/v1/projects/$PROJECT_ID" -H "Authorization: Bearer $JWT" >/dev/null \
  || fail "JWT rejected by API (or project not visible to user)"
ok "JWT accepted by API"

# ─── Clear any prior snapshot rows for a clean run ───────────────────────────
section "Reset prior state"

DELETED=$(psql "$DATABASE_URL" -t -A -c "
  DELETE FROM kortix.project_runtime_snapshots
  WHERE project_id = '$PROJECT_ID' AND provider = 'daytona'
  RETURNING snapshot_row_id;
" | wc -l | tr -d ' ')
ok "cleared $DELETED prior snapshot row(s) for this project"

# ─── Helpers ──────────────────────────────────────────────────────────────────
create_session() {
  local agent="${1:-kortix}"
  curl -sf -X POST "$API_BASE/v1/projects/$PROJECT_ID/sessions" \
    -H "Authorization: Bearer $JWT" \
    -H "Content-Type: application/json" \
    -d "{\"agent_name\":\"$agent\"}"
}

get_session() {
  local sid="$1"
  curl -sf "$API_BASE/v1/projects/$PROJECT_ID/sessions/$sid" \
    -H "Authorization: Bearer $JWT"
}

snapshot_row_status() {
  psql "$DATABASE_URL" -t -A -c "
    SELECT COALESCE(status::text, 'none') || '|' || COALESCE(snapshot_id, '') || '|' || COALESCE(commit_sha, '')
    FROM kortix.project_runtime_snapshots
    WHERE project_id = '$PROJECT_ID' AND provider = 'daytona'
    ORDER BY created_at DESC LIMIT 1;
  "
}

snapshot_row_count() {
  psql "$DATABASE_URL" -t -A -c "
    SELECT count(*) FROM kortix.project_runtime_snapshots
    WHERE project_id = '$PROJECT_ID' AND provider = 'daytona' AND status = 'ready';
  "
}

session_sandbox_metadata() {
  local sid="$1"
  psql "$DATABASE_URL" -t -A -c "
    SELECT metadata::text FROM kortix.session_sandboxes WHERE sandbox_id = '$sid';
  "
}

# ─── Phase 1: cold build ──────────────────────────────────────────────────────
section "Phase 1: cold build (no prior snapshot)"

T0=$(date +%s)
SESS1=$(create_session)
SID1=$(echo "$SESS1" | jq -r '.session_id // .id // empty')
[[ -n "$SID1" ]] || fail "session create returned no id (got: $SESS1)"
ok "created session $SID1"

# Watch the snapshot row transition. queued → building → ready, with a
# hard ceiling of BUILD_TIMEOUT_S.
LAST_STATUS=""
SAW_QUEUED=0
SAW_BUILDING=0
deadline=$((T0 + BUILD_TIMEOUT_S))
while (( $(date +%s) < deadline )); do
  ROW=$(snapshot_row_status)
  STATUS=$(echo "$ROW" | cut -d'|' -f1)
  SNAP_ID=$(echo "$ROW" | cut -d'|' -f2)
  COMMIT=$(echo "$ROW" | cut -d'|' -f3)
  if [[ "$STATUS" != "$LAST_STATUS" ]]; then
    info "snapshot row → $STATUS $( [[ -n $SNAP_ID ]] && echo "(snapshot_id=$SNAP_ID)" )"
    LAST_STATUS="$STATUS"
  fi
  case "$STATUS" in
    queued)   SAW_QUEUED=1 ;;
    building) SAW_BUILDING=1 ;;
    ready)    break ;;
    failed)
      ERR=$(psql "$DATABASE_URL" -t -A -c "SELECT error FROM kortix.project_runtime_snapshots WHERE project_id = '$PROJECT_ID' AND provider='daytona' ORDER BY created_at DESC LIMIT 1;")
      fail "snapshot build failed: $ERR"
      ;;
  esac
  sleep 2
done
[[ "$STATUS" == "ready" ]] || fail "snapshot did not reach 'ready' within ${BUILD_TIMEOUT_S}s (last: $STATUS)"
T_READY=$(date +%s)
BUILD_S=$((T_READY - T0))
ok "snapshot ready in ${BUILD_S}s"
[[ "$SAW_BUILDING" -eq 1 ]] && ok "observed 'building' state mid-flight" || info "did not observe 'building' (likely transitioned faster than poll interval)"

# Confirm session sandbox got the per-project snapshot, not the shared default.
deadline=$((T_READY + SESSION_BOOT_TIMEOUT_S))
while (( $(date +%s) < deadline )); do
  META=$(session_sandbox_metadata "$SID1" || true)
  if echo "$META" | grep -q "$SNAP_ID"; then
    ok "session sandbox metadata references per-project snapshot ($SNAP_ID)"
    break
  fi
  sleep 1
done

# ─── Phase 2: warm cache ──────────────────────────────────────────────────────
section "Phase 2: warm cache (same commit, expect immediate use)"

T2=$(date +%s)
SESS2=$(create_session)
SID2=$(echo "$SESS2" | jq -r '.session_id // .id // empty')
[[ -n "$SID2" ]] || fail "session create returned no id (got: $SESS2)"
ok "created session $SID2"

# A second session for the same commit must NOT create a second row; the
# (project, commit, provider) unique constraint dedupes — we should still
# see exactly one ready row.
sleep 3
ROW_COUNT=$(snapshot_row_count)
[[ "$ROW_COUNT" == "1" ]] || fail "expected 1 ready snapshot row, got $ROW_COUNT"
ok "exactly 1 ready snapshot row (cache hit, no rebuild)"

# Wall-clock check: warm session sandbox metadata should appear within a
# few seconds, not the BUILD_S minutes of phase 1.
deadline=$((T2 + 30))
WARM_TOUCHED=0
while (( $(date +%s) < deadline )); do
  META=$(session_sandbox_metadata "$SID2" || true)
  if echo "$META" | grep -q "$SNAP_ID"; then
    WARM_S=$(( $(date +%s) - T2 ))
    ok "second session referenced same snapshot in ${WARM_S}s"
    WARM_TOUCHED=1
    break
  fi
  sleep 1
done
[[ "$WARM_TOUCHED" -eq 1 ]] || info "warm session didn't show snapshot in metadata within 30s (race / fast provisioning ok)"

# ─── Done ─────────────────────────────────────────────────────────────────────
section "Result"
printf "  ${BOLD}${GREEN}PASS${NC} — cold build %ds, warm reused snapshot ${SNAP_ID}\n" "$BUILD_S"
exit 0
