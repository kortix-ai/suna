#!/usr/bin/env bash
#
# End-to-end test for the cloud-aware `kortix` CLI.
#
# Drives every project-scoped command against a live API + DB:
#
#   1. mint a PAT via direct DB insert (no dashboard needed)
#   2. login --token, whoami, projects ls/info/link/unlink/open
#   3. secrets ls/set/unset (multi + stdin)
#   4. env pull / env push
#   5. sessions ls / info
#   6. triggers ls (and info if any exist)
#   7. error paths (not-logged-in, no-project, bad token, unknown sub)
#   8. logout + verify auth file gone
#
# Cleans every secret it creates and removes the test PAT at exit.
#
# Required services:
#   * Kortix API on $KORTIX_API_URL (default http://localhost:8008)
#   * Postgres on $E2E_DATABASE_URL
#     (default postgres://postgres:postgres@127.0.0.1:54322/postgres)
#
# Usage:
#   apps/cli/scripts/e2e-cloud.sh

set -uo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLI_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
SUNA_ROOT=$(cd "$CLI_ROOT/../.." && pwd)

KORTIX_API_URL=${KORTIX_API_URL:-http://localhost:8008}
E2E_DATABASE_URL=${E2E_DATABASE_URL:-postgres://postgres:postgres@127.0.0.1:54322/postgres}
AUTH_FILE=/tmp/kortix-e2e-auth-$$.json
WORK_DIR=/tmp/kortix-e2e-work-$$
PUSH_FILE=/tmp/kortix-e2e-push-$$.env

unset KORTIX_TOKEN KORTIX_CLI_TOKEN KORTIX_PROJECT_ID
export KORTIX_API_URL
export KORTIX_AUTH_FILE="$AUTH_FILE"

CLI="bun run $CLI_ROOT/src/index.ts"

# ─── output ────────────────────────────────────────────────────────────────

GREEN=$'\033[0;32m'
RED=$'\033[0;31m'
YELLOW=$'\033[1;33m'
DIM=$'\033[2m'
BOLD=$'\033[1m'
RESET=$'\033[0m'

PASS=0
FAIL=0
FAILED_NAMES=()

section() { printf "\n${BOLD}── %s ──${RESET}\n" "$1"; }
ok()      { printf "  ${GREEN}✓${RESET} %s\n" "$1"; PASS=$((PASS+1)); }
bad()     { printf "  ${RED}✗${RESET} %s\n" "$1"; FAIL=$((FAIL+1)); FAILED_NAMES+=("$1"); }
note()    { printf "  ${DIM}%s${RESET}\n" "$1"; }

# Assert that the captured combined output contains a pattern.
assert_contains() {
  local desc="$1" pattern="$2" haystack="$3"
  if printf '%s' "$haystack" | grep -qF -- "$pattern"; then
    ok "$desc"
  else
    bad "$desc — expected substring: '$pattern'"
    printf "${DIM}      output:${RESET}\n%s\n" "$haystack" | head -8
  fi
}

# Assert that an exit code matches.
assert_exit() {
  local desc="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then
    ok "$desc"
  else
    bad "$desc — expected exit $expected, got $actual"
  fi
}

# ─── cleanup ───────────────────────────────────────────────────────────────

cleanup() {
  local rc=$?
  set +e
  rm -rf "$WORK_DIR" "$AUTH_FILE" "$PUSH_FILE"
  psql "$E2E_DATABASE_URL" -c "delete from kortix.account_tokens where name like 'cli-e2e-%' or name = 'cli-smoke'" >/dev/null 2>&1
  if [ ${rc} -ne 0 ] && [ ${FAIL} -eq 0 ]; then
    printf "\n${RED}aborted with exit $rc (no assertions failed yet)${RESET}\n"
  fi
  return $rc
}
trap cleanup EXIT

# ─── preflight ─────────────────────────────────────────────────────────────

section "Preflight"

curl -fsS -o /dev/null "$KORTIX_API_URL/" 2>/dev/null
if [ $? -ne 0 ]; then
  # The root may 404 but the server is up — try a known route to confirm.
  curl -fsS -o /dev/null "$KORTIX_API_URL/v1/accounts" 2>/dev/null
  if [ $? -ne 22 ] && [ $? -ne 0 ]; then
    bad "API not reachable at $KORTIX_API_URL"
    exit 1
  fi
fi
ok "API reachable at $KORTIX_API_URL"

psql "$E2E_DATABASE_URL" -t -c "select 1" >/dev/null 2>&1 || { bad "Postgres not reachable"; exit 1; }
ok "Postgres reachable"

mkdir -p "$WORK_DIR"
ok "Workdir prepared: $WORK_DIR"

# ─── mint PAT via direct DB insert ─────────────────────────────────────────

section "Mint PAT"

PAT=$(cd "$SUNA_ROOT/apps/api" && bun run src/__tests__/e2e-mint-cli-token.ts 2>/dev/null | tail -1)
if [ -z "$PAT" ] || [[ "$PAT" != kortix_pat_* ]]; then
  bad "Could not mint a PAT — got: $PAT"
  exit 1
fi
# Rename the row so cleanup targets us specifically.
psql "$E2E_DATABASE_URL" -c \
  "update kortix.account_tokens set name = 'cli-e2e-suite' where name = 'cli-smoke'" >/dev/null
ok "Minted PAT ${PAT:0:18}…"

# ─── auth ──────────────────────────────────────────────────────────────────

section "Auth"

out=$($CLI login --token "$PAT" 2>&1)
rc=$?
assert_exit "login --token returns 0" 0 "$rc"
assert_contains "login prints success line" "Logged in as" "$out"

out=$($CLI whoami 2>&1)
rc=$?
assert_exit "whoami returns 0" 0 "$rc"
assert_contains "whoami shows user_id row" "user_id" "$out"
assert_contains "whoami shows account row" "account" "$out"

# Capture the user_id for later assertions.
USER_ID=$(printf '%s' "$out" | grep "user_id" | head -1 | awk '{print $2}')

# ─── projects ──────────────────────────────────────────────────────────────

section "Projects"

out=$($CLI projects ls 2>&1)
rc=$?
assert_exit "projects ls returns 0" 0 "$rc"
assert_contains "projects ls prints header" "NAME" "$out"

# Pick a project — prefer one with sessions so the populated session/trigger
# code paths get exercised. Falls back to the first project otherwise.
PROJECT_ID=$(python3 <<PY
import json, urllib.request
req = urllib.request.Request(
    "$KORTIX_API_URL/v1/projects",
    headers={"Authorization": "Bearer $PAT"},
)
projects = json.loads(urllib.request.urlopen(req).read())
for p in projects:
    sreq = urllib.request.Request(
        f"$KORTIX_API_URL/v1/projects/{p['project_id']}/sessions",
        headers={"Authorization": "Bearer $PAT"},
    )
    try:
        sessions = json.loads(urllib.request.urlopen(sreq).read())
    except Exception:
        sessions = []
    if sessions:
        print(p['project_id'])
        break
else:
    if projects:
        print(projects[0]['project_id'])
PY
)
if [ -z "$PROJECT_ID" ]; then
  note "No projects on this account — skipping project-scoped tests."
  exit 0
fi
ok "Picked test project: $PROJECT_ID"

out=$($CLI projects info "$PROJECT_ID" 2>&1)
rc=$?
assert_exit "projects info <id> returns 0" 0 "$rc"
assert_contains "projects info shows project_id" "$PROJECT_ID" "$out"

cd "$WORK_DIR"
out=$($CLI projects link "$PROJECT_ID" 2>&1)
rc=$?
assert_exit "projects link <id> returns 0" 0 "$rc"
assert_contains "projects link writes link.json" "Linked" "$out"
[ -f .kortix/link.json ] && ok ".kortix/link.json exists" || bad ".kortix/link.json missing after link"

# Now projects info (no arg) should use the linked project.
out=$($CLI projects info 2>&1)
rc=$?
assert_exit "projects info (no arg) returns 0" 0 "$rc"
assert_contains "projects info (no arg) uses linked id" "$PROJECT_ID" "$out"

# projects open just prints the URL — don't actually open anything.
out=$($CLI projects open 2>&1)
rc=$?
assert_exit "projects open returns 0" 0 "$rc"
assert_contains "projects open prints URL" "/projects/$PROJECT_ID" "$out"

# ─── secrets ───────────────────────────────────────────────────────────────

section "Secrets"

out=$($CLI secrets ls 2>&1)
rc=$?
assert_exit "secrets ls returns 0" 0 "$rc"

# Multi-pair set.
out=$($CLI secrets set CLI_E2E_FOO=bar CLI_E2E_BAR=baz 2>&1)
rc=$?
assert_exit "secrets set NAME=VAL NAME=VAL returns 0" 0 "$rc"
assert_contains "secrets set prints CLI_E2E_FOO" "CLI_E2E_FOO" "$out"
assert_contains "secrets set prints 2/2" "2/2 set" "$out"

# Read VALUE from stdin via NAME=-.
out=$(printf 'piped-value-with-spaces' | $CLI secrets set CLI_E2E_STDIN=- 2>&1)
rc=$?
assert_exit "secrets set with stdin returns 0" 0 "$rc"
assert_contains "secrets set stdin prints CLI_E2E_STDIN" "CLI_E2E_STDIN" "$out"

# ls again should now show our names as 'undeclared'.
out=$($CLI secrets ls 2>&1)
assert_contains "secrets ls shows CLI_E2E_FOO" "CLI_E2E_FOO" "$out"
assert_contains "secrets ls shows CLI_E2E_BAR" "CLI_E2E_BAR" "$out"
assert_contains "secrets ls shows CLI_E2E_STDIN" "CLI_E2E_STDIN" "$out"

# ─── env pull / push ───────────────────────────────────────────────────────

section "Env (dotenv pull/push)"

rm -f "$WORK_DIR/.env"
out=$($CLI env pull 2>&1)
rc=$?
assert_exit "env pull returns 0" 0 "$rc"
assert_contains "env pull writes the file path" ".env" "$out"
[ -f .env ] && ok ".env file created" || bad ".env file missing"
grep -q "CLI_E2E_FOO=" .env && ok ".env contains CLI_E2E_FOO" || bad ".env missing CLI_E2E_FOO"

# Overwriting without --force should refuse.
out=$($CLI env pull 2>&1)
rc=$?
assert_exit "env pull refuses to overwrite without --force" 1 "$rc"
assert_contains "env pull warns about --force" "--force" "$out"

# With --force should succeed.
out=$($CLI env pull --force 2>&1)
rc=$?
assert_exit "env pull --force overwrites" 0 "$rc"

# Push a new dotenv.
cat > "$PUSH_FILE" <<EOF
# E2E push test
CLI_E2E_FOO=updated-via-push
CLI_E2E_NEW="quoted value with spaces"
export CLI_E2E_EXPORTED=works
EMPTY_LINE=
EOF
out=$($CLI env push --from "$PUSH_FILE" 2>&1)
rc=$?
assert_exit "env push --from returns 0" 0 "$rc"
assert_contains "env push lists CLI_E2E_FOO" "CLI_E2E_FOO" "$out"
assert_contains "env push lists CLI_E2E_NEW" "CLI_E2E_NEW" "$out"
assert_contains "env push lists CLI_E2E_EXPORTED" "CLI_E2E_EXPORTED" "$out"
assert_contains "env push prints 3/3 uploaded" "3/3 uploaded" "$out"

# unset cleanup
out=$($CLI secrets unset CLI_E2E_FOO CLI_E2E_BAR CLI_E2E_STDIN CLI_E2E_NEW CLI_E2E_EXPORTED 2>&1)
rc=$?
assert_exit "secrets unset returns 0" 0 "$rc"
assert_contains "secrets unset prints 5/5 removed" "5/5 removed" "$out"

# ─── sessions ──────────────────────────────────────────────────────────────

section "Sessions"

out=$($CLI sessions ls 2>&1)
rc=$?
assert_exit "sessions ls returns 0" 0 "$rc"

# Pick a session id if any exist for info test.
SESSION_ID=$(curl -fsS -H "Authorization: Bearer $PAT" "$KORTIX_API_URL/v1/projects/$PROJECT_ID/sessions" | \
  python3 -c "import json,sys; d=json.load(sys.stdin); print(d[0]['session_id'] if d else '')")
if [ -n "$SESSION_ID" ]; then
  out=$($CLI sessions info "$SESSION_ID" 2>&1)
  rc=$?
  assert_exit "sessions info <id> returns 0" 0 "$rc"
  assert_contains "sessions info shows session_id" "$SESSION_ID" "$out"
  assert_contains "sessions info shows status row" "status" "$out"
  assert_contains "sessions info shows branch row" "branch" "$out"
else
  note "No sessions on the project — skipping sessions info."
fi

# Missing arg → exit 2.
out=$($CLI sessions info 2>&1)
rc=$?
assert_exit "sessions info (no arg) exits 2" 2 "$rc"
assert_contains "sessions info (no arg) errors" "session id" "$out"

# ─── triggers ──────────────────────────────────────────────────────────────

section "Triggers"

out=$($CLI triggers ls 2>&1)
rc=$?
assert_exit "triggers ls returns 0" 0 "$rc"

# If any trigger exists, run an info on it.
TRIGGER_SLUG=$(curl -fsS -H "Authorization: Bearer $PAT" "$KORTIX_API_URL/v1/projects/$PROJECT_ID/triggers" | \
  python3 -c "import json,sys; d=json.load(sys.stdin).get('triggers', []); print(d[0]['slug'] if d else '')" 2>/dev/null)
if [ -n "$TRIGGER_SLUG" ]; then
  out=$($CLI triggers info "$TRIGGER_SLUG" 2>&1)
  rc=$?
  assert_exit "triggers info <slug> returns 0" 0 "$rc"
  assert_contains "triggers info shows type row" "type" "$out"
else
  note "No triggers on the project — info/fire/enable assertions skipped."
fi

# Missing arg → exit 2.
out=$($CLI triggers fire 2>&1)
rc=$?
assert_exit "triggers fire (no arg) exits 2" 2 "$rc"

# ─── --project flag override ───────────────────────────────────────────────

section "--project flag override"

# Unlink so the flag is the only way to resolve the project.
$CLI projects unlink >/dev/null
[ ! -f .kortix/link.json ] && ok "unlink removed link.json" || bad "unlink left link.json behind"

# secrets ls without flag → should error.
out=$($CLI secrets ls 2>&1)
rc=$?
assert_exit "secrets ls without link or flag exits 1" 1 "$rc"
assert_contains "secrets ls without link suggests --project" "--project" "$out"

# With flag → succeeds.
out=$($CLI secrets ls --project "$PROJECT_ID" 2>&1)
rc=$?
assert_exit "secrets ls --project <id> returns 0" 0 "$rc"

# KORTIX_PROJECT_ID env → succeeds.
out=$(KORTIX_PROJECT_ID="$PROJECT_ID" $CLI secrets ls 2>&1)
rc=$?
assert_exit "secrets ls with KORTIX_PROJECT_ID env returns 0" 0 "$rc"

# ─── error paths ───────────────────────────────────────────────────────────

section "Error paths"

# Bad subcommand.
out=$($CLI secrets fart 2>&1)
rc=$?
assert_exit "unknown subcommand exits 2" 2 "$rc"
assert_contains "unknown subcommand suggests usage" "Usage:" "$out"

# Bad token via --token.
out=$($CLI login --token "not-a-pat" 2>&1)
rc=$?
assert_exit "login --token without kortix_pat_ prefix exits 1" 1 "$rc"
assert_contains "login bad token mentions prefix" "kortix_pat_" "$out"

# Pretend we're logged in with a junk PAT and watch /me reject.
rm -f "$AUTH_FILE"
cat > "$AUTH_FILE" <<EOF
{"api_base":"$KORTIX_API_URL","token":"kortix_pat_definitelyNotARealOneThough123","user_id":"x","user_email":"","account_id":"","logged_in_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
chmod 0600 "$AUTH_FILE"
out=$($CLI whoami 2>&1)
rc=$?
assert_exit "whoami with bogus PAT exits 1" 1 "$rc"
assert_contains "whoami with bogus PAT says to re-auth" "kortix login" "$out"

# ─── logout ────────────────────────────────────────────────────────────────

section "Logout"

# Restore the real PAT, then logout.
$CLI login --token "$PAT" >/dev/null
[ -f "$AUTH_FILE" ] && ok "auth file present pre-logout" || bad "auth file missing pre-logout"

out=$($CLI logout 2>&1)
rc=$?
assert_exit "logout returns 0" 0 "$rc"
assert_contains "logout confirms removal" "Logged out" "$out"
[ ! -f "$AUTH_FILE" ] && ok "logout deletes the auth file" || bad "auth file still present after logout"

# whoami after logout → error.
out=$($CLI whoami 2>&1)
rc=$?
assert_exit "whoami after logout exits 1" 1 "$rc"
assert_contains "whoami after logout says to login" "kortix login" "$out"

# ─── summary ───────────────────────────────────────────────────────────────

printf "\n${BOLD}── Summary ──${RESET}\n"
printf "  Passed: ${GREEN}%d${RESET}\n" "$PASS"
if [ "$FAIL" -gt 0 ]; then
  printf "  Failed: ${RED}%d${RESET}\n" "$FAIL"
  for n in "${FAILED_NAMES[@]}"; do
    printf "    ${RED}-${RESET} %s\n" "$n"
  done
  exit 1
fi
printf "  Failed: 0\n"
exit 0
