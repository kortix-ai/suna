#!/usr/bin/env bash
# End-to-end test for the `kortix cr` subcommand surface.
#
# Boots a fresh local bare git repo, registers it as a Kortix project, mints
# a PAT, then drives the CLI through every CR subcommand against a live API.
# Asserts on the CLI's text output (stripping ANSI) so we cover both the
# transport (API call) and the rendering layer.
#
# Usage:
#   bash apps/cli/scripts/e2e-cr.sh
#
# Env overrides:
#   KORTIX_API_URL   default http://localhost:8008
#   DATABASE_URL     default postgresql://postgres:postgres@127.0.0.1:54322/postgres

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/../../.." && pwd)"
CLI_DIR="$ROOT_DIR/apps/cli"
API_DIR="$ROOT_DIR/apps/api"
API_URL="${KORTIX_API_URL:-http://localhost:8008}"
DB_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
ENV_FILE="${ENV_FILE:-$API_DIR/.env}"

REPO_ROOT="${REPO_ROOT:-/tmp/kortix-cli-cr-e2e-$$}"

bold()  { printf '\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[0;32m✓\033[0m  %s\n' "$*"; }
fail()  { printf '  \033[0;31m✗\033[0m  %s\n' "$*"; exit 1; }
dim()   { printf '  \033[2m%-10s\033[0m  %s\n' "$1" "$2"; }

require()  { command -v "$1" >/dev/null || fail "missing dependency: $1"; }
require git
require psql
require python3
require bun

strip_ansi() {
  # ESC [ ... m  → drop
  python3 -c "import re,sys; sys.stdout.write(re.sub(r'\x1b\[[0-9;]*m','', sys.stdin.read()))"
}

contains() {
  # $1 = haystack file path, $2 = needle (regex). Whole-file grep against
  # ANSI-stripped content.
  local file="$1" needle="$2"
  if ! strip_ansi <"$file" | grep -Eq -- "$needle"; then
    fail "expected output to match '$needle' — saw:"
    cat "$file" >&2
    return 1
  fi
}

psql_one() {
  PGPASSWORD="${PGPASSWORD:-postgres}" psql "$DB_URL" -t -A -F'|' -q -c "$1" \
    | grep -v -e '^$' -e 'INSERT ' -e 'DELETE ' -e 'UPDATE ' || true
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

# ───────────────────────────────────────────────────────────────────────────
bold "1. Setting up local bare git repo with 2 branches"
mkdir -p "$REPO_ROOT"
(
  cd "$REPO_ROOT"
  git init --bare origin.git -b main >/dev/null
  git clone origin.git work >/dev/null 2>&1
  cd work
  git config user.name  "Kortix CLI E2E"
  git config user.email "cli-e2e@kortix.ai"

  cat > README.md <<EOF
# CLI CR e2e
Used by apps/cli/scripts/e2e-cr.sh.
EOF
  mkdir -p src
  cat > src/hello.ts <<'EOF'
export function hello(name: string): string {
  return 'Hello, ' + name + '!';
}
EOF
  git add -A && git commit -q -m "Initial commit"
  git push -q origin main

  git checkout -q -b feature/farewell main
  cat > src/farewell.ts <<'EOF'
export function farewell(name: string): string {
  return 'Goodbye, ' + name + '!';
}
EOF
  git add -A && git commit -q -m "feat: add farewell"
  git push -q origin feature/farewell

  git checkout -q -b feature/typo main
  echo "" >> README.md
  echo "Status: active" >> README.md
  git add -A && git commit -q -m "docs: add status"
  git push -q origin feature/typo
)
dim "remote" "file://$REPO_ROOT/origin.git"

bold "2. Picking a user, minting a PAT"
USER_ROW="$(psql_one "select user_id || '|' || account_id from kortix.account_members order by joined_at limit 1;")"
USER_ID="${USER_ROW%%|*}"
ACCOUNT_ID="${USER_ROW##*|}"
[[ -z "$USER_ID" || -z "$ACCOUNT_ID" ]] && fail "no account_members row found"
dim "user"    "$USER_ID"
dim "account" "$ACCOUNT_ID"

SECRET_KEY="$(awk -F'=' '/^API_KEY_SECRET=/ {sub(/^"/,"",$2); sub(/"$/,"",$2); print $2; exit}' "$ENV_FILE")"
[[ -z "$SECRET_KEY" ]] && fail "API_KEY_SECRET missing from $ENV_FILE"

mapfile -t PAT_PARTS < <(API_KEY_SECRET="$SECRET_KEY" python3 - <<'PY'
import hmac, hashlib, os, secrets
chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
def rand(n):
    return ''.join(chars[secrets.randbelow(len(chars))] for _ in range(n))
public = 'pk_' + rand(32)
secret = 'kortix_pat_' + rand(32)
key = os.environ['API_KEY_SECRET'].encode()
print(public)
print(secret)
print(hmac.new(key, secret.encode(), hashlib.sha256).hexdigest())
PY
)
PAT_PUBLIC="${PAT_PARTS[0]}"
PAT_SECRET="${PAT_PARTS[1]}"
PAT_HASH="${PAT_PARTS[2]}"

psql_one "
  insert into kortix.account_tokens (account_id, user_id, name, public_key, secret_key_hash)
  values ('$ACCOUNT_ID', '$USER_ID', 'cli-cr-e2e', '$PAT_PUBLIC', '$PAT_HASH');
" >/dev/null
dim "pat" "${PAT_SECRET:0:18}…"

bold "3. Registering the test project"
PROJECT_ID="$(psql_one "
  insert into kortix.projects (account_id, name, repo_url, default_branch, manifest_path)
  values ('$ACCOUNT_ID', 'CLI CR e2e', 'file://$REPO_ROOT/origin.git', 'main', 'kortix.toml')
  returning project_id;
")"
[[ -z "$PROJECT_ID" ]] && fail "failed to insert project"
dim "project" "$PROJECT_ID"

# ───────────────────────────────────────────────────────────────────────────

export KORTIX_CLI_TOKEN="$PAT_SECRET"
export KORTIX_API_URL="$API_URL"
export KORTIX_PROJECT_ID="$PROJECT_ID"

cli() {
  bun run "$CLI_DIR/src/index.ts" "$@"
}

WORK_DIR="$(mktemp -d)"

bold "4. cr ls (empty)"
cli cr ls --status all >"$WORK_DIR/ls-empty.out" 2>&1 || fail "cr ls failed"
contains "$WORK_DIR/ls-empty.out" "No (open |merged |closed )?change requests"
ok "empty list rendered cleanly"

bold "5. cr open --head feature/farewell"
cli cr open --head feature/farewell --title "Add farewell" \
  --description "via CLI" >"$WORK_DIR/open1.out" 2>&1 || fail "cr open failed"
contains "$WORK_DIR/open1.out" "Opened CR #1"
ok "opened CR #1 via CLI"

bold "6. cr open --head feature/typo (second one)"
cli cr open --head feature/typo --title "docs: status line" >"$WORK_DIR/open2.out" 2>&1 \
  || fail "cr open 2 failed"
contains "$WORK_DIR/open2.out" "Opened CR #2"
ok "opened CR #2 via CLI"

bold "7. cr ls shows both"
cli cr ls --status open >"$WORK_DIR/ls-open.out" 2>&1
contains "$WORK_DIR/ls-open.out" "Add farewell"
contains "$WORK_DIR/ls-open.out" "docs: status line"
contains "$WORK_DIR/ls-open.out" "2 change requests"
ok "both CRs surfaced in the list"

bold "8. cr show 1 includes metadata + merge preview"
cli cr show 1 >"$WORK_DIR/show1.out" 2>&1 || fail "cr show failed"
contains "$WORK_DIR/show1.out" "#1"
contains "$WORK_DIR/show1.out" "Add farewell"
contains "$WORK_DIR/show1.out" "Head feature/farewell"
contains "$WORK_DIR/show1.out" "Base main"
contains "$WORK_DIR/show1.out" "Mergeable cleanly"
ok "show renders title, branches, merge preview"

bold "9. cr diff 1 reports the added file"
cli cr diff 1 --no-color >"$WORK_DIR/diff1.out" 2>&1 || fail "cr diff failed"
contains "$WORK_DIR/diff1.out" "src/farewell.ts"
contains "$WORK_DIR/diff1.out" "\\+10 -0|1 file"
contains "$WORK_DIR/diff1.out" "diff --git a/src/farewell.ts"
ok "diff lists changed files + emits unified patch"

bold "10. cr merge 1 succeeds (fast-forward against main)"
cli cr merge 1 >"$WORK_DIR/merge1.out" 2>&1 || fail "cr merge failed"
contains "$WORK_DIR/merge1.out" "Merged CR #1"
ok "merge succeeded via CLI"

# Verify the merge actually advanced main in the origin repo.
ORIGIN_LOG="$(git --git-dir="$REPO_ROOT/origin.git" log --oneline main -n 3)"
echo "$ORIGIN_LOG" | grep -q "feat: add farewell" || fail "main does not include feature/farewell after merge"
ok "origin/main on disk advanced"

bold "11. cr close 2 (no merge)"
cli cr close 2 >"$WORK_DIR/close2.out" 2>&1 || fail "cr close failed"
contains "$WORK_DIR/close2.out" "Closed CR #2"
ok "closed CR #2"

bold "12. cr reopen 2 puts it back to open"
cli cr reopen 2 >"$WORK_DIR/reopen2.out" 2>&1 || fail "cr reopen failed"
contains "$WORK_DIR/reopen2.out" "Reopened CR #2"
ok "reopened CR #2"

bold "13. cr ls --status merged shows the merged CR only"
cli cr ls --status merged >"$WORK_DIR/ls-merged.out" 2>&1
contains "$WORK_DIR/ls-merged.out" "Add farewell"
strip_ansi <"$WORK_DIR/ls-merged.out" | grep -q "docs: status line" \
  && fail "merged-only list should not include open CRs"
ok "status filter works"

bold "14. cr show on a uuid (not just a number)"
CR2_ID="$(psql_one "select cr_id from kortix.change_requests where project_id='$PROJECT_ID' and number=2;")"
cli cr show "$CR2_ID" >"$WORK_DIR/show-uuid.out" 2>&1
contains "$WORK_DIR/show-uuid.out" "docs: status line"
ok "show accepts a uuid as well as a number"

bold "15. help text covers every subcommand"
cli cr --help >"$WORK_DIR/help.out" 2>&1
for sub in ls show diff open merge close reopen; do
  contains "$WORK_DIR/help.out" "$sub"
done
ok "help mentions every subcommand"

bold "PASSED — kortix cr lifecycle verified end-to-end"
