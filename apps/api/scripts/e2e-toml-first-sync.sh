#!/usr/bin/env bash
# Live end-to-end proof that /customize entities (schedules, webhooks,
# connectors) are ALWAYS config-first — written to kortix.toml before they
# exist anywhere else — and that the manifest is the single source of truth the
# DB is reconciled against. There is no path where an entity lands in the DB
# first (no DB-first race).
#
# Runs against a REAL backend + REAL managed git: it provisions a
# throwaway project, drives the real HTTP API with curl, and purges everything
# on exit. NOT a unit test.
#
# What it asserts:
#   SCHED  POST /triggers (cron)      → entry present in committed kortix.toml
#   HOOK   POST /triggers (webhook)   → entry present in committed kortix.toml
#   CONN-1 POST /executor/.../connectors → present in kortix.toml AND in the DB
#          materialized view (config-first create, then synced — never DB-first)
#   CONN-2 SOURCE OF TRUTH: delete the DB row out-of-band, POST .../connectors/sync
#          → row is REBUILT from the manifest (TOML drives DB)
#   CONN-3 NO DB-FIRST: insert a rogue DB row that is NOT in the manifest, sync
#          → row is DELETED (nothing survives in the DB unless it is in TOML)
#   CONN-4 DELETE /executor/.../connectors/:slug → gone from BOTH toml and DB
#   CONN-5 a connector added to kortix.toml on a branch and landed via a real
#          CR merge auto-reconciles into the DB with NO manual sync call
#
# Usage:
#   bash apps/api/scripts/e2e-toml-first-sync.sh
#
# Env overrides:
#   KORTIX_API_URL  (default http://localhost:8008)
#   DATABASE_URL    (default postgresql://postgres:postgres@127.0.0.1:54322/postgres)
#   ENV_FILE        (default apps/api/.env — read for API_KEY_SECRET)
#
# Exits non-zero on the first failed assertion.

set -euo pipefail

API="${KORTIX_API_URL:-http://localhost:8008}"
DB_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
API_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$API_DIR/.env}"

bold()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[0;32m✓\033[0m  %s\n' "$*"; }
fail()  { printf '  \033[0;31m✗\033[0m  %s\n' "$*"; exit 1; }
dim()   { printf '  \033[2m%-9s\033[0m  %s\n' "$1" "$2"; }

require() { command -v "$1" >/dev/null || fail "missing dependency: $1"; }
require curl; require jq; require psql; require python3; require awk; require git; require mktemp; require bun

assert_eq() {
  local got="$1" want="$2" label="$3"
  [[ "$got" == "$want" ]] || fail "$label: expected '$want', got '$got'"
  ok "$label = $want"
}
assert_status() {
  local code="$1" want="$2" label="$3"
  [[ "$code" == "$want" ]] || fail "$label: expected HTTP $want, got $code"
  ok "$label → HTTP $want"
}

psql_one() {
  PGPASSWORD="${PGPASSWORD:-postgres}" psql "$DB_URL" -t -A -F'|' -q -c "$1" \
    | grep -v -e '^$' -e 'INSERT ' -e 'DELETE ' -e 'UPDATE ' || true
}

PROJECT_ID=""
PAT_HASH=""
TMP_DIR=""
cleanup() {
  bold "cleanup"
  if [[ -n "$PROJECT_ID" && -n "${PAT_SECRET:-}" ]]; then
    local resp code
    resp="$(api DELETE "/v1/projects/$PROJECT_ID?purge=true" || true)"
    code="$(code_of "$resp")"
    [[ "$code" == "200" ]] && ok "purged project (repo deleted)" || dim "purge" "HTTP $code (manual cleanup may be needed for $PROJECT_ID)"
  fi
  [[ -n "$PAT_HASH" ]] && { psql_one "delete from kortix.account_tokens where secret_key_hash = '$PAT_HASH';" >/dev/null || true; ok "revoked e2e PAT"; }
  [[ -n "$TMP_DIR" ]] && rm -rf "$TMP_DIR"
}
trap cleanup EXIT

# ── HTTP helper: prints body + a trailing line with the HTTP status ──────────
api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS --max-time 180 -X "$method" \
      -H "Authorization: Bearer $PAT_SECRET" -H "Content-Type: application/json" \
      -d "$body" -w $'\n%{http_code}' "$API$path"
  else
    curl -sS --max-time 180 -X "$method" \
      -H "Authorization: Bearer $PAT_SECRET" -H "Content-Type: application/json" \
      -w $'\n%{http_code}' "$API$path"
  fi
}
body_of() { printf '%s' "$1" | sed '$d'; }
code_of() { printf '%s' "$1" | tail -n1; }

# Fresh read of the committed manifest from git (proves it actually landed in
# the repo, not just a cache).
manifest() {
  local resp code
  resp="$(api GET "/v1/projects/$PROJECT_ID/files/content?path=kortix.toml")"
  code="$(code_of "$resp")"
  [[ "$code" == "200" ]] || { echo "__HTTP_$code__"; return 0; }
  jq -r '.content' <<<"$(body_of "$resp")"
}

# yes/no: is <slug> in the DB-materialized connector view (GET reads the DB)?
connector_in_db() {
  local resp code
  resp="$(api GET "/v1/executor/projects/$PROJECT_ID/connectors")"
  code="$(code_of "$resp")"
  [[ "$code" == "200" ]] || fail "GET connectors → HTTP $code: $(body_of "$resp")"
  if [[ "$(jq -r --arg s "$1" '[.connectors[]?|select(.slug==$s)]|length' <<<"$(body_of "$resp")")" -ge 1 ]]; then
    echo yes; else echo no; fi
}

sync_connectors() {
  local resp code
  resp="$(api POST "/v1/executor/projects/$PROJECT_ID/connectors/sync" '{}')"
  code="$(code_of "$resp")"
  assert_status "$code" "200" "POST /connectors/sync"
}

# git over HTTPS with the project push token (basic auth header), like the CLI/ship path.
git_auth_header() { printf 'AUTHORIZATION: basic %s' "$(printf '%s' "x-access-token:$1" | base64 | tr -d '\n')"; }

# Poll the DB-materialized connector view until <slug> appears (yes) or timeout.
wait_connector_in_db() {
  for _ in $(seq 1 20); do
    [[ "$(connector_in_db "$1")" == "yes" ]] && { echo yes; return; }
    sleep 1
  done
  echo no
}

# ─────────────────────────────────────────────────────────────────────────────
bold "0. Backend reachable + managed git configured"
HEALTH="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "$API/health" || echo 000)"
assert_status "$HEALTH" "200" "GET /health"
grep -q '^FREESTYLE_API_KEY=.\+' "$ENV_FILE" || fail "FREESTYLE_API_KEY missing from $ENV_FILE (managed git required)"
ok "FREESTYLE_API_KEY present"

bold "1. Pick an owner account + mint a PAT"
USER_ROW="$(psql_one "select user_id || '|' || account_id from kortix.account_members where account_role='owner' order by joined_at limit 1;")"
USER_ID="${USER_ROW%%|*}"; ACCOUNT_ID="${USER_ROW##*|}"
[[ -z "$USER_ID" || -z "$ACCOUNT_ID" ]] && fail "no owner account_members row found"
dim "account" "$ACCOUNT_ID"

mapfile -t PAT < <(
  API_KEY_SECRET="$(awk -F'=' '/^API_KEY_SECRET=/ {sub(/^"/,"",$2); sub(/"$/,"",$2); print $2; exit}' "$ENV_FILE")" \
  python3 - <<'PY'
import hmac, hashlib, os, secrets
chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
rand = lambda n: ''.join(chars[secrets.randbelow(len(chars))] for _ in range(n))
public, secret = 'pk_' + rand(32), 'kortix_pat_' + rand(32)
key = os.environ['API_KEY_SECRET'].encode()
print(public); print(secret); print(hmac.new(key, secret.encode(), hashlib.sha256).hexdigest())
PY
)
PAT_PUBLIC="${PAT[0]}"; PAT_SECRET="${PAT[1]}"; PAT_HASH="${PAT[2]}"
[[ -z "$PAT_HASH" ]] && fail "PAT mint failed (is API_KEY_SECRET set in $ENV_FILE?)"
psql_one "insert into kortix.account_tokens (account_id, user_id, name, public_key, secret_key_hash)
          values ('$ACCOUNT_ID','$USER_ID','e2e-toml-first','$PAT_PUBLIC','$PAT_HASH');" >/dev/null
dim "pat" "${PAT_SECRET:0:18}…"

bold "2. Provision a throwaway managed project (seeds kortix.toml)"
PROV="$(api POST /v1/projects/provision "{\"account_id\":\"$ACCOUNT_ID\",\"name\":\"e2e toml-first $(date +%s)\",\"seed_starter\":true}")"
assert_status "$(code_of "$PROV")" "201" "POST /projects/provision"
PROV_BODY="$(body_of "$PROV")"
PROJECT_ID="$(jq -r '.project_id' <<<"$PROV_BODY")"
REPO_URL="$(jq -r '.repo_url' <<<"$PROV_BODY")"
assert_eq "$(jq -r '.metadata.git.provider' <<<"$PROV_BODY")" "github" "git provider"
[[ -n "$PROJECT_ID" && "$PROJECT_ID" != "null" ]] || fail "no project_id returned"
dim "project" "$PROJECT_ID"

# Seeded manifest should be readable; retry briefly for repo settle.
SEED=""
for _ in 1 2 3 4 5 6; do SEED="$(manifest)"; grep -q 'kortix_version' <<<"$SEED" && break; sleep 2; done
grep -q 'kortix_version' <<<"$SEED" || fail "seeded kortix.toml not readable: ${SEED:0:80}"
ok "seeded kortix.toml present (config baseline)"

bold "3. SCHED — create a cron schedule → must land in kortix.toml"
R="$(api POST "/v1/projects/$PROJECT_ID/triggers" \
  '{"slug":"e2e-schedule","name":"E2E Schedule","type":"cron","cron":"0 0 9 * * *","timezone":"UTC","enabled":false,"prompt_template":"Run the e2e scheduled job."}')"
assert_status "$(code_of "$R")" "201" "POST /triggers (cron)"
M="$(manifest)"
grep -q 'slug = "e2e-schedule"' <<<"$M" || fail "schedule not in committed kortix.toml"
grep -q 'type = "cron"'          <<<"$M" || fail "schedule type not in kortix.toml"
ok "schedule written to kortix.toml (config-first)"
LIST="$(body_of "$(api GET "/v1/projects/$PROJECT_ID/triggers")")"
assert_eq "$(jq -r '[.triggers[]?|select(.slug=="e2e-schedule")]|length' <<<"$LIST")" "1" "schedule via API (read from toml)"

bold "4. HOOK — create a webhook → must land in kortix.toml"
R="$(api POST "/v1/projects/$PROJECT_ID/triggers" \
  '{"slug":"e2e-webhook","name":"E2E Webhook","type":"webhook","secret_env":"WEBHOOK_E2E_SECRET","enabled":true,"prompt_template":"Handle {{ event }}."}')"
assert_status "$(code_of "$R")" "201" "POST /triggers (webhook)"
M="$(manifest)"
grep -q 'slug = "e2e-webhook"'               <<<"$M" || fail "webhook not in committed kortix.toml"
grep -q 'secret_env = "WEBHOOK_E2E_SECRET"'   <<<"$M" || fail "webhook secret_env not in kortix.toml"
ok "webhook written to kortix.toml (config-first)"
LIST="$(body_of "$(api GET "/v1/projects/$PROJECT_ID/triggers")")"
assert_eq "$(jq -r '[.triggers[]?|select(.slug=="e2e-webhook" and .webhook_url!=null)]|length' <<<"$LIST")" "1" "webhook via API (url minted)"

bold "5. CONN-1 — create a connector → kortix.toml FIRST, then synced to DB"
R="$(api POST "/v1/executor/projects/$PROJECT_ID/connectors" \
  '{"slug":"e2e-http","provider":"http","baseUrl":"https://example.com"}')"
assert_status "$(code_of "$R")" "200" "POST /connectors"
assert_eq "$(jq -r '.ok' <<<"$(body_of "$R")")" "true" "connector create ok"
grep -q 'slug = "e2e-http"' <<<"$(manifest)" || fail "connector not in committed kortix.toml"
ok "connector written to kortix.toml (config-first)"
assert_eq "$(connector_in_db e2e-http)" "yes" "connector materialized into DB (synced from toml)"

bold "6. CONN-2 — SOURCE OF TRUTH: delete the DB row, sync rebuilds it from toml"
psql_one "delete from kortix.executor_connectors where project_id='$PROJECT_ID' and slug='e2e-http';" >/dev/null
assert_eq "$(connector_in_db e2e-http)" "no"  "DB row gone (out-of-band delete)"
sync_connectors
assert_eq "$(connector_in_db e2e-http)" "yes" "sync REBUILT the row from kortix.toml"

bold "7. CONN-3 — NO DB-FIRST: a rogue DB row not in toml is purged by sync"
psql_one "insert into kortix.executor_connectors (account_id, project_id, slug, name, provider_type)
          values ('$ACCOUNT_ID','$PROJECT_ID','rogue-db-first','rogue','http');" >/dev/null
assert_eq "$(connector_in_db rogue-db-first)" "yes" "rogue DB row inserted (simulating a DB-first leak)"
grep -q 'slug = "rogue-db-first"' <<<"$(manifest)" && fail "rogue slug unexpectedly in toml" || ok "rogue slug is NOT in kortix.toml"
sync_connectors
assert_eq "$(connector_in_db rogue-db-first)" "no"  "sync DELETED the rogue row (toml is authoritative)"
assert_eq "$(connector_in_db e2e-http)"       "yes" "real toml-backed connector survived sync"

bold "8. CONN-4 — delete via API removes it from BOTH toml and DB"
R="$(api DELETE "/v1/executor/projects/$PROJECT_ID/connectors/e2e-http")"
assert_status "$(code_of "$R")" "200" "DELETE /connectors/:slug"
grep -q 'slug = "e2e-http"' <<<"$(manifest)" && fail "connector still in kortix.toml after delete" || ok "connector removed from kortix.toml"
assert_eq "$(connector_in_db e2e-http)" "no" "connector removed from DB"

bold "9. CONN-5 — a connector landed via a real CR merge auto-syncs (no manual sync)"
TK="$(api POST "/v1/projects/$PROJECT_ID/git-token" '{}')"
assert_status "$(code_of "$TK")" "200" "POST /git-token"
PUSH_TOKEN="$(jq -r '.push_token' <<<"$(body_of "$TK")")"
[[ -n "$PUSH_TOKEN" && "$PUSH_TOKEN" != "null" ]] || fail "no push_token"
TMP_DIR="$(mktemp -d)"
HDR="$(git_auth_header "$PUSH_TOKEN")"
git -c http.extraheader="$HDR" clone -q "$REPO_URL" "$TMP_DIR/repo" || fail "clone failed"
git -C "$TMP_DIR/repo" config user.email e2e@kortix.ai
git -C "$TMP_DIR/repo" config user.name  e2e
git -C "$TMP_DIR/repo" checkout -q -b cr-conn
# Edit kortix.toml on the branch (NOT via the API) — the CR-merge hook must
# reconcile this into the DB with no manual sync call. Edit via smol-toml (the
# platform's own parser) so the result is valid regardless of prior shape.
( cd "$API_DIR" && TF="$TMP_DIR/repo/kortix.toml" bun -e '
import { parse, stringify } from "smol-toml";
import { readFileSync, writeFileSync } from "node:fs";
const f = process.env.TF;
const m = parse(readFileSync(f, "utf8"));
const c = Array.isArray(m.connectors) ? m.connectors : [];
c.push({ slug: "e2e-cr-http", provider: "http", base_url: "https://cr.example.com" });
m.connectors = c;
writeFileSync(f, stringify(m));
' ) || fail "failed to edit kortix.toml on branch"
grep -q 'slug = "e2e-cr-http"' "$TMP_DIR/repo/kortix.toml" || fail "branch manifest edit did not take"
git -C "$TMP_DIR/repo" add -A
git -C "$TMP_DIR/repo" commit -q -m "feat: add e2e-cr-http connector via CR"
git -C "$TMP_DIR/repo" -c http.extraheader="$HDR" push -q origin cr-conn
ok "pushed branch cr-conn with a new [[connectors]] entry"
assert_eq "$(connector_in_db e2e-cr-http)" "no" "branch edit NOT in DB before merge (main unchanged)"
# The server mirrors the repo behind a refresh throttle, so a just-pushed
# branch can take up to the throttle window to become resolvable. Poll CR-open
# through it (the call itself forces the fetch once the window elapses).
CR_CODE=""; CR_BODY=""
for _ in $(seq 1 18); do
  CR="$(api POST "/v1/projects/$PROJECT_ID/change-requests" '{"title":"Add e2e-cr-http","head_ref":"cr-conn","base_ref":"main"}')"
  CR_CODE="$(code_of "$CR")"; CR_BODY="$(body_of "$CR")"
  [[ "$CR_CODE" == "201" ]] && break
  sleep 5
done
assert_status "$CR_CODE" "201" "POST /change-requests"
CR_ID="$(jq -r '.cr_id' <<<"$CR_BODY")"
MG="$(api POST "/v1/projects/$PROJECT_ID/change-requests/$CR_ID/merge" '{}')"
assert_status "$(code_of "$MG")" "200" "POST /change-requests/:id/merge"
assert_eq "$(wait_connector_in_db e2e-cr-http)" "yes" "CR-merge auto-reconciled connector into DB (no manual sync)"

bold "PASSED — config-first creation + toml-as-source-of-truth verified end-to-end against $API"
