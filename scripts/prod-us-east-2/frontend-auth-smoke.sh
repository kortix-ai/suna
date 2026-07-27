#!/usr/bin/env bash
set -Eeuo pipefail

TARGET_SECRET_ID="${TARGET_SECRET_ID:-kortix/prod-us-east-2-migration}"
TARGET_AWS_REGION="${TARGET_AWS_REGION:-us-east-2}"
TARGET_FRONTEND_URL="${TARGET_FRONTEND_URL:-https://us.kortix.com}"
TARGET_API_URL="${TARGET_API_URL:-https://api-use2-shadow.kortix.com/v1}"
TARGET_AUTH_SEQUENCE_HEADROOM="${TARGET_AUTH_SEQUENCE_HEADROOM:-100000000}"
REPOSITORY_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

for command_name in aws base64 curl jq openssl psql; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Missing required command: $command_name" >&2
    exit 1
  }
done

if ! [[ "$TARGET_AUTH_SEQUENCE_HEADROOM" =~ ^[1-9][0-9]*$ ]]; then
  echo "TARGET_AUTH_SEQUENCE_HEADROOM must be a positive integer." >&2
  exit 1
fi

playwright_command="$REPOSITORY_ROOT/tests/node_modules/.bin/playwright"
if [[ ! -x "$playwright_command" ]]; then
  echo "Install tests dependencies before running the frontend Auth smoke." >&2
  exit 1
fi

target_secret_json="$(
  aws secretsmanager get-secret-value \
    --secret-id "$TARGET_SECRET_ID" \
    --region "$TARGET_AWS_REGION" \
    --query SecretString \
    --output text
)"

target_database_url="$(
  jq -er '.target_database_url // .DATABASE_URL' <<<"$target_secret_json"
)"
target_supabase_url="${TARGET_SUPABASE_URL_OVERRIDE:-$(
  jq -er '.target_supabase_url // .SUPABASE_URL' <<<"$target_secret_json"
)}"
target_anon_key="$(
  jq -er '.target_anon_key // .SUPABASE_ANON_KEY' <<<"$target_secret_json"
)"
target_service_role_key="$(
  jq -er '.target_service_role_key // .SUPABASE_SERVICE_ROLE_KEY' \
    <<<"$target_secret_json"
)"

smoke_email="use2-browser-smoke-$(date +%s)-$(openssl rand -hex 4)@invalid.kortix.test"
smoke_password="$(openssl rand -base64 36 | tr -d '\n')aA1!"
smoke_user_id=""
smoke_account_ids="{}"
original_webhook_url="$(
  psql "$target_database_url" -X -qAt -v ON_ERROR_STOP=1 \
    -c "SELECT backend_url FROM public.webhook_config WHERE id = 1"
)"
encoded_webhook_url="$(printf '%s' "$original_webhook_url" | base64)"

restore_webhook() {
  psql "$target_database_url" -X -q -v ON_ERROR_STOP=1 \
    -c "UPDATE public.webhook_config
        SET backend_url = convert_from(
          decode('$encoded_webhook_url', 'base64'),
          'UTF8'
        )
        WHERE id = 1" || true
}

cleanup() {
  restore_webhook
  if [[ -z "$smoke_user_id" ]]; then
    return
  fi

  if [[ "$smoke_account_ids" == "{}" ]]; then
    smoke_account_ids="$(
      psql "$target_database_url" -X -qAt -v ON_ERROR_STOP=1 \
        -v smoke_user_id="$smoke_user_id" <<'SQL'
SELECT COALESCE(
  array_agg(account_id ORDER BY account_id),
  ARRAY[]::uuid[]
)
FROM (
  SELECT account_id
  FROM kortix.account_members
  WHERE user_id = :'smoke_user_id'::uuid
  UNION
  SELECT account_id
  FROM kortix.accounts
  WHERE account_id = :'smoke_user_id'::uuid
) AS smoke_accounts;
SQL
    )"
  fi

  curl -sS -o /dev/null \
    -X DELETE \
    -H "Authorization: Bearer $target_service_role_key" \
    -H "apikey: $target_service_role_key" \
    "$target_supabase_url/auth/v1/admin/users/$smoke_user_id" || true

  psql "$target_database_url" -X -q -v ON_ERROR_STOP=1 \
    -v smoke_user_id="$smoke_user_id" \
    -v smoke_account_ids="$smoke_account_ids" \
    -v sequence_headroom="$TARGET_AUTH_SEQUENCE_HEADROOM" \
    >/dev/null <<'SQL' || true
DELETE FROM kortix.audit_events
WHERE actor_user_id = :'smoke_user_id'::uuid;

DELETE FROM kortix.credit_ledger
WHERE account_id = ANY(:'smoke_account_ids'::uuid[]);

DELETE FROM kortix.credit_accounts
WHERE account_id = ANY(:'smoke_account_ids'::uuid[]);

DELETE FROM kortix.accounts
WHERE account_id = ANY(:'smoke_account_ids'::uuid[]);

DELETE FROM auth.audit_log_entries
WHERE payload::text LIKE '%' || :'smoke_user_id' || '%';

DELETE FROM auth.refresh_tokens
WHERE user_id = :'smoke_user_id';

DELETE FROM auth.sessions
WHERE user_id = :'smoke_user_id'::uuid;

DELETE FROM auth.mfa_factors
WHERE user_id = :'smoke_user_id'::uuid;

DELETE FROM auth.flow_state
WHERE user_id = :'smoke_user_id'::uuid
   OR referrer LIKE '%kortix_use2_oauth_smoke%'
   OR referrer LIKE '%kortix_use2_github_oauth_smoke%';

DELETE FROM auth.identities
WHERE user_id = :'smoke_user_id'::uuid;

DELETE FROM auth.users
WHERE id = :'smoke_user_id'::uuid;

SELECT setval(
  'auth.refresh_tokens_id_seq'::regclass,
  COALESCE((SELECT max(id) FROM auth.refresh_tokens), 1)
    + :'sequence_headroom'::bigint,
  true
);
SQL
}
trap cleanup EXIT

psql "$target_database_url" -X -q -v ON_ERROR_STOP=1 \
  -v sequence_headroom="$TARGET_AUTH_SEQUENCE_HEADROOM" \
  >/dev/null <<'SQL'
SELECT setval(
  'auth.refresh_tokens_id_seq'::regclass,
  COALESCE((SELECT max(id) FROM auth.refresh_tokens), 1)
    + :'sequence_headroom'::bigint,
  true
);
SQL

psql "$target_database_url" -X -q -v ON_ERROR_STOP=1 \
  -c "UPDATE public.webhook_config SET backend_url = '' WHERE id = 1"

create_body="$(
  jq -cn \
    --arg email "$smoke_email" \
    --arg password "$smoke_password" \
    '{
      email: $email,
      password: $password,
      email_confirm: true,
      user_metadata: {kortix_use2_browser_smoke: true}
    }'
)"
create_response="$(
  curl -fsS \
    -X POST \
    -H "Authorization: Bearer $target_service_role_key" \
    -H "apikey: $target_service_role_key" \
    -H "Content-Type: application/json" \
    --data-binary "$create_body" \
    "$target_supabase_url/auth/v1/admin/users"
)"
smoke_user_id="$(jq -er '.id // .user.id' <<<"$create_response")"
restore_webhook

E2E_BASE_URL="$TARGET_FRONTEND_URL" \
E2E_API_URL="$TARGET_API_URL" \
E2E_SUPABASE_URL="$target_supabase_url" \
E2E_OWNER_EMAIL="$smoke_email" \
E2E_OWNER_PASSWORD="$smoke_password" \
E2E_OAUTH_PROVIDER_INITIATION=1 \
SUPABASE_ANON_KEY="$target_anon_key" \
NEXT_PUBLIC_SUPABASE_ANON_KEY="$target_anon_key" \
SUPABASE_SERVICE_ROLE_KEY="$target_service_role_key" \
  "$playwright_command" test \
    -c "$REPOSITORY_ROOT/tests/playwright.config.ts" \
    "$REPOSITORY_ROOT/tests/e2e/specs/03-frontend-config.spec.ts" \
    "$REPOSITORY_ROOT/tests/e2e/specs/04-auth-flow.spec.ts" \
    "$REPOSITORY_ROOT/tests/e2e/specs/17-oauth-provider-initiation.spec.ts" \
    --project chromium \
    --reporter=line

for attempt in 1 2 3; do
  cleanup
  cleanup_rows="$(
    psql "$target_database_url" -X -qAt -v ON_ERROR_STOP=1 \
      -v smoke_user_id="$smoke_user_id" \
      -v smoke_account_ids="$smoke_account_ids" <<'SQL'
SELECT
  (SELECT count(*) FROM auth.audit_log_entries
    WHERE payload::text LIKE '%' || :'smoke_user_id' || '%')
  + (SELECT count(*) FROM auth.users
    WHERE id = :'smoke_user_id'::uuid)
  + (SELECT count(*) FROM auth.flow_state
    WHERE user_id = :'smoke_user_id'::uuid)
  + (SELECT count(*) FROM kortix.audit_events
    WHERE actor_user_id = :'smoke_user_id'::uuid)
  + (SELECT count(*) FROM kortix.accounts
    WHERE account_id = ANY(:'smoke_account_ids'::uuid[]))
  + (SELECT count(*) FROM kortix.account_members
    WHERE account_id = ANY(:'smoke_account_ids'::uuid[]))
  + (SELECT count(*) FROM kortix.credit_accounts
    WHERE account_id = ANY(:'smoke_account_ids'::uuid[]))
  + (SELECT count(*) FROM kortix.credit_ledger
    WHERE account_id = ANY(:'smoke_account_ids'::uuid[]));
SQL
  )"
  if [[ "$cleanup_rows" == "0" ]]; then
    break
  fi
  sleep "$attempt"
done
trap - EXIT

if [[ "$cleanup_rows" != "0" ]]; then
  echo "Frontend Auth smoke cleanup left $cleanup_rows rows." >&2
  exit 1
fi

echo '{"supabasePasswordGrant":true,"browserPasswordLogin":true,"authenticatedShell":true,"cleanupRows":0}'
