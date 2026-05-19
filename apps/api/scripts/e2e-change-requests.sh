#!/usr/bin/env bash
# End-to-end test for the Kortix Change Request system.
#
# Sets up a local bare git repo, registers it as a Kortix project, mints a
# user PAT, then drives the CR API through every state. v1 of the CR system
# is intentionally minimal — no reviews, no comments — so the assertions cover
# just the core lifecycle:
#   1. open CR    → 201, status=open, head/base SHAs anchored
#   2. detail     → 200, returns the CR row only
#   3. diff       → 200, non-empty patch + files list against base
#   4. preview    → can_merge=true on clean branch
#   5. preview    → can_merge=false + conflicts list on conflict branch
#   6. merge      → 200, status=merged, merge_commit_sha set
#   7. base moved → main now points at the merge commit on disk
#   8. merged diff → still renders (via captured base/head SHAs)
#   9. conflict merge → 409
#  10. close + reopen lifecycle
#
# Usage:
#   bash apps/api/scripts/e2e-change-requests.sh
#
# Env overrides:
#   KORTIX_API_URL  (default http://localhost:8008)
#   DATABASE_URL    (default postgresql://postgres:postgres@127.0.0.1:54322/postgres)
#
# Exits non-zero on the first failed assertion.

set -euo pipefail

API="${KORTIX_API_URL:-http://localhost:8008}"
DB_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

# Force a fresh local git remote to avoid colliding with any user-created CRs.
REPO_ROOT="${REPO_ROOT:-/tmp/kortix-cr-e2e-$$}"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[0;32m✓\033[0m  %s\n' "$*"; }
fail()  { printf '  \033[0;31m✗\033[0m  %s\n' "$*"; exit 1; }
dim()   { printf '  \033[2m%-10s\033[0m  %s\n' "$1" "$2"; }

require()  { command -v "$1" >/dev/null || fail "missing dependency: $1"; }
require git
require curl
require psql
require python3
require jq

assert_eq() {
  local got="$1" want="$2" label="$3"
  if [[ "$got" != "$want" ]]; then
    fail "$label: expected '$want', got '$got'"
  fi
  ok "$label = $want"
}

assert_status() {
  local code="$1" want="$2" label="$3"
  if [[ "$code" != "$want" ]]; then
    fail "$label: expected HTTP $want, got $code"
  fi
  ok "$label → HTTP $want"
}

psql_one() {
  PGPASSWORD="${PGPASSWORD:-postgres}" psql "$DB_URL" -t -A -F'|' -q -c "$1" | grep -v -e '^$' -e 'INSERT ' -e 'DELETE ' -e 'UPDATE ' || true
}

cleanup() {
  if [[ -n "${PAT_HASH:-}" ]]; then
    psql_one "delete from kortix.account_tokens where secret_key_hash = '$PAT_HASH';" >/dev/null || true
  fi
  if [[ -n "${PROJECT_ID:-}" ]]; then
    psql_one "delete from kortix.projects where project_id = '$PROJECT_ID';" >/dev/null || true
  fi
  rm -rf "$REPO_ROOT"
}
trap cleanup EXIT

bold "1. Setting up local bare git repo"
mkdir -p "$REPO_ROOT"
(
  cd "$REPO_ROOT"
  git init --bare origin.git -b main >/dev/null
  git clone origin.git work >/dev/null 2>&1
  cd work
  git config user.name  "Kortix E2E"
  git config user.email "e2e@kortix.ai"

  cat > README.md <<EOF
# E2E CR Project

Used by apps/api/scripts/e2e-change-requests.sh.
EOF
  mkdir -p src
  cat > src/index.ts <<'EOF'
export function greet(name: string): string {
  return 'Hello, ' + name + '!';
}
EOF
  git add -A
  git commit -q -m "Initial commit"
  git push -q origin main

  # feat/clean — adds a new file (no main divergence yet, clean 3-way)
  git checkout -q -b feat/clean main
  cat > src/farewell.ts <<'EOF'
export function farewell(name: string): string {
  return 'Goodbye, ' + name + '!';
}
EOF
  git add -A && git commit -q -m "feat: add farewell"
  git push -q origin feat/clean

  # main advances so we exercise the 3-way merge path
  git checkout -q main
  echo "Status: active" >> README.md
  git add -A && git commit -q -m "docs: status line"
  git push -q origin main

  # feat/conflict — modifies the same line on main
  git checkout -q -b feat/conflict main^
  echo "Status: archived" >> README.md
  git add -A && git commit -q -m "docs: conflicting status"
  git push -q origin feat/conflict
)
dim "remote" "file://$REPO_ROOT/origin.git"

bold "2. Picking a user and minting a PAT"
USER_ROW="$(psql_one "select user_id || '|' || account_id from kortix.account_members order by joined_at limit 1;")"
USER_ID="${USER_ROW%%|*}"
ACCOUNT_ID="${USER_ROW##*|}"
[[ -z "$USER_ID" || -z "$ACCOUNT_ID" ]] && fail "no account_members row found"
dim "user"    "$USER_ID"
dim "account" "$ACCOUNT_ID"

mint_pat() {
  # PATs are hashed via HMAC-SHA256(API_KEY_SECRET, secret). Read the key
  # from the same .env the API process uses so the hash matches.
  local secret_key
  secret_key="$(awk -F'=' '/^API_KEY_SECRET=/ {sub(/^"/,"",$2); sub(/"$/,"",$2); print $2; exit}' "$ENV_FILE")"
  [[ -z "$secret_key" ]] && fail "API_KEY_SECRET missing from $ENV_FILE"
  API_KEY_SECRET="$secret_key" python3 - <<'PY'
import hmac, hashlib, os, secrets
chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
def rand(n):
    out = []
    for _ in range(n):
        out.append(chars[secrets.randbelow(len(chars))])
    return ''.join(out)
public = 'pk_' + rand(32)
secret = 'kortix_pat_' + rand(32)
key = os.environ['API_KEY_SECRET'].encode()
print(public)
print(secret)
print(hmac.new(key, secret.encode(), hashlib.sha256).hexdigest())
PY
}

ENV_FILE="${ENV_FILE:-$(cd "$(dirname "$0")/.." && pwd)/.env}"

mapfile -t PAT_PARTS < <(mint_pat)
PAT_PUBLIC="${PAT_PARTS[0]}"
PAT_SECRET="${PAT_PARTS[1]}"
PAT_HASH="${PAT_PARTS[2]}"

psql_one "
  insert into kortix.account_tokens (account_id, user_id, name, public_key, secret_key_hash)
  values ('$ACCOUNT_ID', '$USER_ID', 'e2e-cr-test', '$PAT_PUBLIC', '$PAT_HASH');
" >/dev/null
dim "pat"     "${PAT_SECRET:0:18}…"

bold "3. Registering the test project"
PROJECT_ID="$(psql_one "
  insert into kortix.projects (account_id, name, repo_url, default_branch, manifest_path)
  values ('$ACCOUNT_ID', 'E2E CR Project', 'file://$REPO_ROOT/origin.git', 'main', 'kortix.toml')
  returning project_id;
")"
[[ -z "$PROJECT_ID" ]] && fail "failed to insert project"
dim "project" "$PROJECT_ID"

BASE="$API/v1/projects/$PROJECT_ID"

req() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS -X "$method" \
      -H "Authorization: Bearer $PAT_SECRET" \
      -H "Content-Type: application/json" \
      -d "$body" \
      -w '\n%{http_code}' "$BASE$path"
  else
    curl -sS -X "$method" \
      -H "Authorization: Bearer $PAT_SECRET" \
      -H "Content-Type: application/json" \
      -w '\n%{http_code}' "$BASE$path"
  fi
}

bold "4. Listing branches via API (confirms the project is wired up)"
BRANCH_RESP="$(req GET /branches)"
BRANCH_CODE="$(printf '%s' "$BRANCH_RESP" | tail -n1)"
BRANCH_BODY="$(printf '%s' "$BRANCH_RESP" | sed '$d')"
assert_status "$BRANCH_CODE" "200" "GET /branches"
BRANCH_COUNT="$(jq '.branches | length' <<<"$BRANCH_BODY")"
[[ "$BRANCH_COUNT" -ge "3" ]] || fail "expected 3 branches, got $BRANCH_COUNT"
ok "found $BRANCH_COUNT branches"

bold "5. Opening a clean CR"
CR_RESP="$(req POST /change-requests '{"title":"Add farewell","head_ref":"feat/clean","base_ref":"main","description":"Adds a goodbye helper."}')"
CR_CODE="$(printf '%s' "$CR_RESP" | tail -n1)"
CR_BODY="$(printf '%s' "$CR_RESP" | sed '$d')"
assert_status "$CR_CODE" "201" "POST /change-requests"
CR_ID="$(jq -r '.cr_id' <<<"$CR_BODY")"
CR_NUMBER="$(jq -r '.number' <<<"$CR_BODY")"
assert_eq "$(jq -r .status <<<"$CR_BODY")" "open" "CR.status"
dim "cr_id"   "$CR_ID"
dim "number"  "#$CR_NUMBER"

bold "6. Detail endpoint returns just the CR row"
DET_RESP="$(req GET /change-requests/$CR_ID)"
DET_CODE="$(printf '%s' "$DET_RESP" | tail -n1)"
DET_BODY="$(printf '%s' "$DET_RESP" | sed '$d')"
assert_status "$DET_CODE" "200" "GET /change-requests/:id"
DET_KEYS="$(jq -r '. | keys | join(",")' <<<"$DET_BODY")"
assert_eq "$DET_KEYS" "change_request" "detail body keys"
HEAD_SHA="$(jq -r '.change_request.head_commit_sha' <<<"$DET_BODY")"
[[ ${#HEAD_SHA} -eq 40 ]] || fail "head_commit_sha not anchored: '$HEAD_SHA'"
ok "head_commit_sha anchored at open time (${HEAD_SHA:0:7})"

bold "7. Diff endpoint reports the added file"
DIFF_RESP="$(req GET /change-requests/$CR_ID/diff)"
DIFF_CODE="$(printf '%s' "$DIFF_RESP" | tail -n1)"
DIFF_BODY="$(printf '%s' "$DIFF_RESP" | sed '$d')"
assert_status "$DIFF_CODE" "200" "GET /diff"
DIFF_PATH="$(jq -r '.files[0].path' <<<"$DIFF_BODY")"
assert_eq "$DIFF_PATH" "src/farewell.ts" "diff.files[0].path"
DIFF_STATUS="$(jq -r '.files[0].status' <<<"$DIFF_BODY")"
assert_eq "$DIFF_STATUS" "added" "diff.files[0].status"

bold "8. Merge-preview says the clean CR is mergeable"
PREV_RESP="$(req GET /change-requests/$CR_ID/merge-preview)"
PREV_BODY="$(printf '%s' "$PREV_RESP" | sed '$d')"
assert_eq "$(jq -r .can_merge <<<"$PREV_BODY")" "true"  "preview.can_merge (clean)"
assert_eq "$(jq '.conflicts | length' <<<"$PREV_BODY")" "0" "preview.conflicts (clean)"

bold "9. Merge the clean CR"
MERGE_RESP="$(req POST /change-requests/$CR_ID/merge '{}')"
MERGE_CODE="$(printf '%s' "$MERGE_RESP" | tail -n1)"
MERGE_BODY="$(printf '%s' "$MERGE_RESP" | sed '$d')"
assert_status "$MERGE_CODE" "200" "POST /merge"
assert_eq "$(jq -r .change_request.status <<<"$MERGE_BODY")" "merged" "CR.status post-merge"
MERGE_SHA="$(jq -r .merge.merge_commit_sha <<<"$MERGE_BODY")"
[[ ${#MERGE_SHA} -eq 40 ]] || fail "merge_commit_sha is not 40 chars: '$MERGE_SHA'"
ok "merge_commit_sha = ${MERGE_SHA:0:7}"

bold "10. Origin git has the merge commit"
LOG="$(git --git-dir="$REPO_ROOT/origin.git" log --oneline main -n 1)"
[[ "$LOG" == *"$MERGE_SHA"* || "$LOG" == *"${MERGE_SHA:0:7}"* ]] || fail "main tip is not the merge commit: $LOG"
ok "main now points at merge commit ($LOG)"
git --git-dir="$REPO_ROOT/origin.git" show "main:src/farewell.ts" >/dev/null || fail "src/farewell.ts missing on main"
ok "src/farewell.ts present on main"

bold "10b. Merged CR's diff still renders (uses captured snapshot SHAs)"
MERGED_DIFF_BODY="$(req GET /change-requests/$CR_ID/diff | sed '$d')"
MERGED_FILES="$(jq '.files_changed' <<<"$MERGED_DIFF_BODY")"
[[ "$MERGED_FILES" -ge 1 ]] || fail "merged CR diff is empty (got files=$MERGED_FILES)"
ok "merged CR diff still shows $MERGED_FILES file(s) of changes"

bold "11. Conflict path: merge-preview reports conflicts, merge returns 409"
CR2_RESP="$(req POST /change-requests '{"title":"Conflicting status","head_ref":"feat/conflict","base_ref":"main"}')"
CR2_BODY="$(printf '%s' "$CR2_RESP" | sed '$d')"
CR2_ID="$(jq -r .cr_id <<<"$CR2_BODY")"

PREV2_BODY="$(req GET /change-requests/$CR2_ID/merge-preview | sed '$d')"
assert_eq "$(jq -r .can_merge <<<"$PREV2_BODY")" "false" "preview.can_merge (conflict)"
CONFLICT_LEN="$(jq '.conflicts | length' <<<"$PREV2_BODY")"
[[ "$CONFLICT_LEN" -ge 1 ]] || fail "expected conflicts, got 0"
ok "preview.conflicts = $(jq -c .conflicts <<<"$PREV2_BODY")"

MERGE2_RESP="$(req POST /change-requests/$CR2_ID/merge '{}')"
MERGE2_CODE="$(printf '%s' "$MERGE2_RESP" | tail -n1)"
assert_status "$MERGE2_CODE" "409" "POST /merge (conflict)"

bold "12. Close + reopen lifecycle"
CLOSE_BODY="$(req POST /change-requests/$CR2_ID/close '{}' | sed '$d')"
assert_eq "$(jq -r .status <<<"$CLOSE_BODY")" "closed" "after close"

REOPEN_BODY="$(req POST /change-requests/$CR2_ID/reopen '{}' | sed '$d')"
assert_eq "$(jq -r .status <<<"$REOPEN_BODY")" "open" "after reopen"

bold "13. List endpoint filters by status"
OPEN_BODY="$(req GET '/change-requests?status=open' | sed '$d')"
OPEN_COUNT="$(jq '.change_requests | length' <<<"$OPEN_BODY")"
[[ "$OPEN_COUNT" -ge 1 ]] || fail "expected at least 1 open CR"
ok "open list count = $OPEN_COUNT"

MERGED_BODY="$(req GET '/change-requests?status=merged' | sed '$d')"
MERGED_COUNT="$(jq '.change_requests | length' <<<"$MERGED_BODY")"
[[ "$MERGED_COUNT" -ge 1 ]] || fail "expected at least 1 merged CR"
ok "merged list count = $MERGED_COUNT"

bold "PASSED — full CR lifecycle verified end-to-end against $API"
