#!/usr/bin/env bash
# E2E for backend-owned OpenCode↔Kortix session mapping.
#
# Drives the real HTTP API (POST /v1/projects/:id/sessions/:sid/ensure-opencode)
# against a LIVE session's sandbox and proves:
#   1. ensure pins a real OpenCode root id (server-side authority).
#   2. it is idempotent (second call = unchanged).
#   3. it HEALS: corrupt the pin → ensure restores the genuine present root.
#
# Safe: captures the original pin and always restores it on exit. Mints a
# throwaway PAT (like e2e-change-requests.sh) and deletes it on exit.
set -euo pipefail

API="${API:-http://localhost:8008}"
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"
ENV_FILE="${ENV_FILE:-$(cd "$(dirname "$0")/.." && pwd)/.env}"
PROJECT_ID="${PROJECT_ID:-f383e165-749c-41c1-8341-569009089762}"
SESSION_ID="${SESSION_ID:-f7cc59b8-5142-4659-b942-d486871851d4}"

bold(){ printf '\n\033[1m%s\033[0m\n' "$*"; }
ok(){ printf '  \033[32m✓\033[0m %s\n' "$*"; }
dim(){ printf '  \033[2m%-10s\033[0m %s\n' "$1" "$2"; }
fail(){ printf '  \033[31m✗ %s\033[0m\n' "$*"; exit 1; }

psql_one(){ PGPASSWORD=postgres psql "$DB_URL" -t -A -q -c "$1" | grep -v -e '^$' -e 'UPDATE ' -e 'INSERT ' -e 'DELETE ' || true; }

ORIG_PIN=""; PAT_HASH=""
cleanup(){
  # Restore the original pin no matter what, so we never leave the live session corrupted.
  if [[ -n "$ORIG_PIN" ]]; then
    psql_one "update kortix.project_sessions set opencode_session_id='$ORIG_PIN' where session_id='$SESSION_ID';" >/dev/null || true
  fi
  if [[ -n "$PAT_HASH" ]]; then
    psql_one "delete from kortix.account_tokens where secret_key_hash='$PAT_HASH';" >/dev/null || true
  fi
}
trap cleanup EXIT

bold "1. Resolve account/user for the project + mint a PAT"
ROW="$(psql_one "select p.account_id || '|' || (select user_id from kortix.account_members m where m.account_id=p.account_id order by joined_at limit 1) from kortix.projects p where p.project_id='$PROJECT_ID';")"
ACCOUNT_ID="${ROW%%|*}"; USER_ID="${ROW##*|}"
[[ -z "$ACCOUNT_ID" || -z "$USER_ID" ]] && fail "could not resolve account/user for project"
dim account "$ACCOUNT_ID"; dim user "$USER_ID"

SECRET_KEY="$(awk -F'=' '/^API_KEY_SECRET=/ {sub(/^"/,"",$2); sub(/"$/,"",$2); print $2; exit}' "$ENV_FILE")"
[[ -z "$SECRET_KEY" ]] && fail "API_KEY_SECRET missing from $ENV_FILE"
mapfile -t PAT < <(API_KEY_SECRET="$SECRET_KEY" python3 - <<'PY'
import hmac, hashlib, os, secrets
chars='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
r=lambda n:''.join(chars[secrets.randbelow(len(chars))] for _ in range(n))
public='pk_'+r(32); secret='kortix_pat_'+r(32)
print(public); print(secret)
print(hmac.new(os.environ['API_KEY_SECRET'].encode(), secret.encode(), hashlib.sha256).hexdigest())
PY
)
PAT_PUBLIC="${PAT[0]}"; PAT_SECRET="${PAT[1]}"; PAT_HASH="${PAT[2]}"
psql_one "insert into kortix.account_tokens (account_id,user_id,name,public_key,secret_key_hash) values ('$ACCOUNT_ID','$USER_ID','e2e-oc-mapping','$PAT_PUBLIC','$PAT_HASH');" >/dev/null
dim pat "${PAT_SECRET:0:18}…"

ensure(){ curl -sS -X POST -H "Authorization: Bearer $PAT_SECRET" -H 'Content-Type: application/json' \
  -w '\n%{http_code}' "$API/v1/projects/$PROJECT_ID/sessions/$SESSION_ID/ensure-opencode"; }
db_pin(){ psql_one "select coalesce(opencode_session_id,'') from kortix.project_sessions where session_id='$SESSION_ID';"; }

ORIG_PIN="$(db_pin)"
dim "orig pin" "${ORIG_PIN:-<null>}"

bold "2. Call ensure-opencode (route + auth + server-side resolve)"
RESP="$(ensure)"; CODE="$(tail -n1 <<<"$RESP")"; BODY="$(sed '$d' <<<"$RESP")"
[[ "$CODE" == "200" ]] || fail "ensure returned HTTP $CODE: $BODY"
REASON="$(jq -r '.ensure.reason' <<<"$BODY")"
PIN1="$(jq -r '.ensure.pin // ""' <<<"$BODY")"
SERIAL_PIN="$(jq -r '.opencode_session_id // ""' <<<"$BODY")"
dim reason "$REASON"; dim "pin" "${PIN1:-<null>}"
ok "endpoint reachable + authorized (HTTP 200)"

if [[ "$REASON" == "unreachable" || "$REASON" == "not_ready" ]]; then
  printf '\n  \033[33m⚠ sandbox not reachable from the dev API (reason=%s).\033[0m\n' "$REASON"
  printf '  The endpoint/auth/plumbing work, but the live OpenCode runtime\n'
  printf '  could not be reached to resolve the canonical root in this env.\n'
  printf '  (Daytona reachability from local dev — not a logic failure.)\n'
  exit 2
fi

[[ -n "$PIN1" && "$PIN1" == ses_* ]] || fail "expected a real OpenCode session id, got '$PIN1'"
[[ "$SERIAL_PIN" == "$PIN1" ]] || fail "serialized opencode_session_id ($SERIAL_PIN) != ensure pin ($PIN1)"
[[ "$(db_pin)" == "$PIN1" ]] || fail "DB pin ($(db_pin)) != ensure pin ($PIN1)"
ok "pinned a real root and persisted it to the DB"

bold "3. Idempotency — second call must be a no-op"
RESP2="$(ensure)"; BODY2="$(sed '$d' <<<"$RESP2")"
REASON2="$(jq -r '.ensure.reason' <<<"$BODY2")"; PIN2="$(jq -r '.ensure.pin // ""' <<<"$BODY2")"
dim reason "$REASON2"; dim pin "$PIN2"
[[ "$PIN2" == "$PIN1" ]] || fail "pin changed across idempotent calls ($PIN1 -> $PIN2)"
[[ "$REASON2" == "unchanged" ]] || fail "expected reason=unchanged on 2nd call, got $REASON2"
ok "idempotent — stable pin, no thrash"

bold "4. Heal — corrupt the pin, ensure must restore the genuine present root"
psql_one "update kortix.project_sessions set opencode_session_id='ses_BOGUSdeadbeef0000' where session_id='$SESSION_ID';" >/dev/null
[[ "$(db_pin)" == "ses_BOGUSdeadbeef0000" ]] || fail "failed to set bogus pin"
RESP3="$(ensure)"; BODY3="$(sed '$d' <<<"$RESP3")"
REASON3="$(jq -r '.ensure.reason' <<<"$BODY3")"; PIN3="$(jq -r '.ensure.pin // ""' <<<"$BODY3")"
dim reason "$REASON3"; dim "healed pin" "$PIN3"
[[ "$REASON3" == "healed" ]] || fail "expected reason=healed after corruption, got $REASON3"
[[ "$PIN3" == "$PIN1" ]] || fail "heal restored the WRONG root ($PIN3), expected the genuine $PIN1"
[[ "$(db_pin)" == "$PIN1" ]] || fail "DB not healed (still $(db_pin))"
ok "stale pin healed back to the genuine live root: $PIN3"

bold "5. Pin is server-managed — client PATCH of opencode_session_id must be rejected"
PATCH_RESP="$(curl -sS -X PATCH -H "Authorization: Bearer $PAT_SECRET" -H 'Content-Type: application/json' \
  -d '{"opencode_session_id":"ses_clientforged"}' -w '\n%{http_code}' \
  "$API/v1/projects/$PROJECT_ID/sessions/$SESSION_ID")"
PATCH_CODE="$(tail -n1 <<<"$PATCH_RESP")"; PATCH_BODY="$(sed '$d' <<<"$PATCH_RESP")"
dim http "$PATCH_CODE"; dim body "$PATCH_BODY"
[[ "$PATCH_CODE" == "400" ]] || fail "expected 400 rejecting client pin write, got $PATCH_CODE"
grep -q "server-managed" <<<"$PATCH_BODY" || fail "expected 'server-managed' rejection, got: $PATCH_BODY"
[[ "$(db_pin)" == "$PIN1" ]] || fail "client PATCH altered the pin! now $(db_pin)"
ok "client cannot write the pin (400 server-managed); pin unchanged"

bold "ALL CHECKS PASSED ✅  — mapping is backend-owned, accurate, idempotent, self-healing"
