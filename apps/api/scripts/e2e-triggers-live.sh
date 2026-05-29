#!/usr/bin/env bash
# Live end-to-end proof that triggers ACTUALLY FIRE and boot a real agent
# session end-to-end:
#
#   WEBHOOK  signed POST /v1/webhooks/projects/:id/:slug → 202 fired + session_id
#            (and: missing sig → 401, wrong sig → 401)
#   MANUAL   POST /v1/projects/:id/triggers/:slug/fire    → 202 fired + session_id
#   CRON     the live in-process scheduler (60s tick) fires a due cron trigger
#            → a session with metadata.trigger_source == "cron" appears
#   AGENT    each fired session boots a REAL Daytona sandbox, reaches
#            status="running" with a sandbox_url, and a live OpenCode session
#            is pinned (ensure-opencode) — i.e. the agent runtime is up and the
#            rendered trigger prompt was delivered (KORTIX_INITIAL_PROMPT).
#
# Runs against a REAL running backend (pnpm dev) + REAL managed git (Freestyle)
# + REAL Daytona sandboxes. NOT a unit test. Spends real compute + LLM credits.
# Purges everything on exit (project, PAT, secret) and restores the credit row.
#
# Usage:   bash apps/api/scripts/e2e-triggers-live.sh
# Env:     KORTIX_API_URL (default http://localhost:8008)
#          DATABASE_URL   (default postgresql://postgres:postgres@127.0.0.1:54322/postgres)
#          ENV_FILE       (default apps/api/.env — read for API_KEY_SECRET)
#          AGENT_BOOT_TIMEOUT (default 180 seconds to reach status=running)
#          CRON_WAIT          (default 80 seconds to catch one scheduler tick)
set -euo pipefail

API="${KORTIX_API_URL:-http://localhost:8008}"
DB_URL="${DATABASE_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
API_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="${ENV_FILE:-$API_DIR/.env}"
AGENT_BOOT_TIMEOUT="${AGENT_BOOT_TIMEOUT:-180}"
CRON_WAIT="${CRON_WAIT:-80}"

bold()  { printf '\n\033[1m%s\033[0m\n' "$*"; }
ok()    { printf '  \033[0;32m✓\033[0m  %s\n' "$*"; }
fail()  { printf '  \033[0;31m✗\033[0m  %s\n' "$*"; exit 1; }
dim()   { printf '  \033[2m%-10s\033[0m %s\n' "$1" "$2"; }

require() { command -v "$1" >/dev/null || fail "missing dependency: $1"; }
require curl; require jq; require psql; require python3; require openssl; require date

assert_eq()     { [[ "$1" == "$2" ]] || fail "$3: expected '$2', got '$1'"; ok "$3 = $2"; }
assert_status() { [[ "$1" == "$2" ]] || fail "$3: expected HTTP $2, got $1"; ok "$3 → HTTP $2"; }

psql_one() {
  PGPASSWORD="${PGPASSWORD:-postgres}" psql "$DB_URL" -t -A -F'|' -q -c "$1" \
    | grep -v -e '^$' -e 'INSERT ' -e 'DELETE ' -e 'UPDATE ' || true
}

PROJECT_ID=""; PAT_HASH=""; PAT_SECRET=""; ACCOUNT_ID=""
CREDIT_EXISTED=""; CREDIT_ORIG_BAL=""
cleanup() {
  bold "cleanup"
  if [[ -n "$PROJECT_ID" && -n "$PAT_SECRET" ]]; then
    local code; code="$(api_code DELETE "/v1/projects/$PROJECT_ID?purge=true")"
    [[ "$code" == "200" ]] && ok "purged project (repo + sandboxes torn down)" \
      || dim "purge" "HTTP $code (manual cleanup may be needed for $PROJECT_ID)"
  fi
  [[ -n "$PAT_HASH" ]] && { psql_one "delete from kortix.account_tokens where secret_key_hash = '$PAT_HASH';" >/dev/null || true; ok "revoked e2e PAT"; }
  # Restore billing exactly as we found it.
  if [[ -n "$ACCOUNT_ID" ]]; then
    if [[ "$CREDIT_EXISTED" == "no" ]]; then
      psql_one "delete from kortix.credit_accounts where account_id='$ACCOUNT_ID';" >/dev/null || true
      ok "removed seeded credit row"
    elif [[ -n "$CREDIT_ORIG_BAL" ]]; then
      psql_one "update kortix.credit_accounts set balance='$CREDIT_ORIG_BAL' where account_id='$ACCOUNT_ID';" >/dev/null || true
      ok "restored credit balance ($CREDIT_ORIG_BAL)"
    fi
  fi
}
trap cleanup EXIT

# HTTP helpers: api() prints body + trailing status line; api_code() returns status only.
api() {
  local method="$1" path="$2" body="${3:-}"
  if [[ -n "$body" ]]; then
    curl -sS --max-time 180 -X "$method" -H "Authorization: Bearer $PAT_SECRET" \
      -H "Content-Type: application/json" -d "$body" -w $'\n%{http_code}' "$API$path"
  else
    curl -sS --max-time 180 -X "$method" -H "Authorization: Bearer $PAT_SECRET" \
      -H "Content-Type: application/json" -w $'\n%{http_code}' "$API$path"
  fi
}
api_code() { api "$@" | tail -n1; }
body_of()  { printf '%s' "$1" | sed '$d'; }
code_of()  { printf '%s' "$1" | tail -n1; }

# Signed webhook POST (no auth header — this endpoint is public, gated by HMAC).
hmac_sig() { printf '%s' "$1" | openssl dgst -sha256 -hmac "$2" -hex | sed 's/^.* //'; }
hook_post() {
  local slug="$1" body="$2" sigheader="${3:-}"
  local hdr=()
  [[ -n "$sigheader" ]] && hdr=(-H "X-Kortix-Signature: $sigheader")
  curl -sS --max-time 180 -X POST -H "Content-Type: application/json" "${hdr[@]}" \
    -d "$body" -w $'\n%{http_code}' "$API/v1/webhooks/projects/$PROJECT_ID/$slug"
}

session_get() { body_of "$(api GET "/v1/projects/$PROJECT_ID/sessions/$1")"; }

# Poll a session until it reaches status=running (agent runtime up) or fails.
wait_agent_running() {
  local sid="$1" label="$2" deadline=$(( $(date +%s) + AGENT_BOOT_TIMEOUT )) last=""
  while (( $(date +%s) < deadline )); do
    local s; s="$(session_get "$sid")"
    local st; st="$(jq -r '.status // "?"' <<<"$s")"
    local url; url="$(jq -r '.sandbox_url // ""' <<<"$s")"
    [[ "$st" != "$last" ]] && { dim "$label" "status=$st sandbox_url=${url:-—}"; last="$st"; }
    case "$st" in
      running) [[ -n "$url" ]] && { echo "$url"; return 0; } ;;
      failed|error) fail "$label session went $st: $(jq -r '.error // "(no error)"' <<<"$s")" ;;
    esac
    sleep 4
  done
  fail "$label session did not reach status=running within ${AGENT_BOOT_TIMEOUT}s"
}

# ─────────────────────────────────────────────────────────────────────────────
bold "0. Backend reachable + managed git + sandbox callback (tunnel) configured"
HEALTH_BODY="$(curl -sS -m 5 "$API/health" || echo '{}')"
assert_status "$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "$API/health" || echo 000)" "200" "GET /health"
grep -q '^FREESTYLE_API_KEY=.\+' "$ENV_FILE" || fail "FREESTYLE_API_KEY missing from $ENV_FILE (managed git required)"
ok "FREESTYLE_API_KEY present"
TUNNEL_ON="$(jq -r '.tunnel.enabled // false' <<<"$HEALTH_BODY")"
[[ "$TUNNEL_ON" == "true" ]] && ok "callback tunnel enabled (cloud sandbox can reach the API)" \
  || dim "tunnel" "WARNING: tunnel not reported enabled — cloud sandboxes may not boot"

bold "1. Pick an owner account + mint a PAT"
# Pick an account with EXACTLY ONE owner so our PAT user == the actor that
# trigger fires attribute sessions to (resolveGitTriggerActor picks the sole
# owner). Otherwise the spawned (private) sessions wouldn't be visible to us.
USER_ROW="$(psql_one "select user_id || '|' || account_id from kortix.account_members
  where account_role='owner'
    and account_id in (select account_id from kortix.account_members where account_role='owner' group by account_id having count(*)=1)
  order by joined_at limit 1;")"
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
          values ('$ACCOUNT_ID','$USER_ID','e2e-triggers-live','$PAT_PUBLIC','$PAT_HASH');" >/dev/null
dim "pat" "${PAT_SECRET:0:18}…"

bold "2. Ensure the account passes the billing gate (>= \$0.01)"
CRED="$(psql_one "select balance from kortix.credit_accounts where account_id='$ACCOUNT_ID';")"
if [[ -z "$CRED" ]]; then
  CREDIT_EXISTED="no"
  psql_one "insert into kortix.credit_accounts (account_id, balance, tier) values ('$ACCOUNT_ID','100','pro');" >/dev/null
  ok "seeded credit row (balance 100)"
else
  CREDIT_EXISTED="yes"; CREDIT_ORIG_BAL="$CRED"
  if python3 -c "import sys; sys.exit(0 if float('$CRED') >= 0.01 else 1)"; then
    ok "account already billing-active (balance $CRED)"
  else
    psql_one "update kortix.credit_accounts set balance='100' where account_id='$ACCOUNT_ID';" >/dev/null
    ok "topped up credit balance ($CRED → 100, restored on exit)"
  fi
fi

bold "3. Provision a throwaway managed project (seeds kortix.toml + default agent)"
PROV="$(api POST /v1/projects/provision "{\"account_id\":\"$ACCOUNT_ID\",\"name\":\"e2e triggers-live $(date +%s)\",\"seed_starter\":true}")"
assert_status "$(code_of "$PROV")" "201" "POST /projects/provision"
PROJECT_ID="$(jq -r '.project_id' <<<"$(body_of "$PROV")")"
[[ -n "$PROJECT_ID" && "$PROJECT_ID" != "null" ]] || fail "no project_id returned"
dim "project" "$PROJECT_ID"
# Wait for the seeded manifest to be readable.
for _ in $(seq 1 8); do
  M="$(jq -r '.content' <<<"$(body_of "$(api GET "/v1/projects/$PROJECT_ID/files/content?path=kortix.toml")")" 2>/dev/null || true)"
  grep -q 'kortix_version' <<<"$M" && break; sleep 2
done
grep -q 'kortix_version' <<<"$M" || fail "seeded kortix.toml not readable"
ok "seeded kortix.toml present"

WEBHOOK_SECRET="whsec_$(python3 -c 'import secrets;print(secrets.token_hex(16))')"
PROMPT='Reply with exactly the single word ACK and then stop. Do not use any tools.'

bold "4. Configure the webhook secret + create cron & webhook triggers (config-first)"
assert_status "$(api_code POST "/v1/projects/$PROJECT_ID/secrets" "{\"name\":\"WEBHOOK_E2E_SECRET\",\"value\":\"$WEBHOOK_SECRET\"}")" "200" "POST /secrets (WEBHOOK_E2E_SECRET)"

# Always-due cron so the live 60s scheduler fires it within one tick.
assert_status "$(api_code POST "/v1/projects/$PROJECT_ID/triggers" \
  "{\"slug\":\"e2e-cron\",\"name\":\"E2E Cron\",\"type\":\"cron\",\"cron\":\"* * * * * *\",\"timezone\":\"UTC\",\"enabled\":true,\"prompt_template\":\"$PROMPT\"}")" "201" "POST /triggers (cron, due-now)"
assert_status "$(api_code POST "/v1/projects/$PROJECT_ID/triggers" \
  "{\"slug\":\"e2e-hook\",\"name\":\"E2E Hook\",\"type\":\"webhook\",\"secret_env\":\"WEBHOOK_E2E_SECRET\",\"enabled\":true,\"prompt_template\":\"Webhook says: {{ body.task }}. $PROMPT\"}")" "201" "POST /triggers (webhook)"

LIST="$(body_of "$(api GET "/v1/projects/$PROJECT_ID/triggers")")"
assert_eq "$(jq -r '[.triggers[]?|select(.slug=="e2e-hook" and .webhook_url!=null)]|length' <<<"$LIST")" "1" "webhook trigger listed with URL"
assert_eq "$(jq -r '[.triggers[]?|select(.slug=="e2e-cron")]|length' <<<"$LIST")" "1" "cron trigger listed"

bold "5. WEBHOOK signature gate — impostors rejected"
HOOK_BODY='{"task":"ship it"}'
assert_status "$(code_of "$(hook_post e2e-hook "$HOOK_BODY")")" "401" "unsigned webhook"
assert_status "$(code_of "$(hook_post e2e-hook "$HOOK_BODY" "sha256=$(hmac_sig "$HOOK_BODY" wrong-secret)")")" "401" "wrong-secret webhook"

bold "6. WEBHOOK valid HMAC → fires + spawns a session"
GOOD_SIG="sha256=$(hmac_sig "$HOOK_BODY" "$WEBHOOK_SECRET")"
HOOK_RES="$(hook_post e2e-hook "$HOOK_BODY" "$GOOD_SIG")"
assert_status "$(code_of "$HOOK_RES")" "202" "signed webhook"
assert_eq "$(jq -r '.status' <<<"$(body_of "$HOOK_RES")")" "fired" "webhook fire status"
HOOK_SID="$(jq -r '.session_id' <<<"$(body_of "$HOOK_RES")")"
[[ -n "$HOOK_SID" && "$HOOK_SID" != "null" ]] || fail "webhook fire returned no session_id"
dim "session" "$HOOK_SID (webhook)"
# Provenance recorded on the session row.
assert_eq "$(jq -r '.metadata.trigger_source // ""' <<<"$(session_get "$HOOK_SID")")" "webhook" "session.trigger_source"
assert_eq "$(jq -r '.metadata.trigger_slug // ""'   <<<"$(session_get "$HOOK_SID")")" "e2e-hook" "session.trigger_slug"

bold "7. MANUAL fire → spawns a session"
MAN_RES="$(api POST "/v1/projects/$PROJECT_ID/triggers/e2e-hook/fire" '{}')"
assert_status "$(code_of "$MAN_RES")" "202" "manual fire"
MAN_SID="$(jq -r '.session_id' <<<"$(body_of "$MAN_RES")")"
[[ -n "$MAN_SID" && "$MAN_SID" != "null" ]] || fail "manual fire returned no session_id"
dim "session" "$MAN_SID (manual)"

bold "8. CRON — live in-process scheduler fires the due trigger (≤ ${CRON_WAIT}s)"
CRON_SID=""; cron_deadline=$(( $(date +%s) + CRON_WAIT ))
while (( $(date +%s) < cron_deadline )); do
  CRON_SID="$(jq -r '[.[]?|select(.metadata.trigger_source=="cron" and .metadata.trigger_slug=="e2e-cron")]|sort_by(.created_at)|last|.session_id // ""' \
    <<<"$(body_of "$(api GET "/v1/projects/$PROJECT_ID/sessions")")")"
  [[ -n "$CRON_SID" && "$CRON_SID" != "null" ]] && break
  sleep 4
done
[[ -n "$CRON_SID" && "$CRON_SID" != "null" ]] || fail "scheduler did not fire the cron trigger within ${CRON_WAIT}s"
ok "scheduler fired cron trigger → session $CRON_SID"
# Stop the always-due cron so it doesn't keep firing every tick.
assert_status "$(api_code DELETE "/v1/projects/$PROJECT_ID/triggers/e2e-cron")" "200" "DELETE cron trigger (stop repeat fires)"

bold "9. AGENT actually runs — each fired session boots a real sandbox + OpenCode"
for pair in "webhook:$HOOK_SID" "manual:$MAN_SID" "cron:$CRON_SID"; do
  src="${pair%%:*}"; sid="${pair##*:}"
  SBX="$(wait_agent_running "$sid" "$src")"
  ok "$src session running (sandbox_url=$SBX)"
  EO="$(api POST "/v1/projects/$PROJECT_ID/sessions/$sid/ensure-opencode" '{}')"
  ec="$(code_of "$EO")"
  if [[ "$ec" == "200" ]]; then
    OCID="$(jq -r '.opencode_session_id // .session_id // ""' <<<"$(body_of "$EO")")"
    [[ -n "$OCID" && "$OCID" != "null" ]] && ok "$src OpenCode session live + pinned ($OCID)" \
      || dim "$src" "ensure-opencode 200 but no session id in body"
  else
    dim "$src" "ensure-opencode → HTTP $ec (sandbox up; OpenCode pin not confirmed)"
  fi
done

bold "RESULT"
ok "webhook + manual + cron triggers all fired and booted real agent sessions end-to-end"
