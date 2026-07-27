#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_SECRET_ID="${SOURCE_SECRET_ID:-kortix-prod-env}"
SOURCE_AWS_REGION="${SOURCE_AWS_REGION:-eu-west-2}"
TARGET_SECRET_ID="${TARGET_SECRET_ID:-kortix/prod-us-east-2-migration}"
TARGET_AWS_REGION="${TARGET_AWS_REGION:-us-east-2}"
PUBLICATION="${PUBLICATION:-kortix_us_east_2_20260725}"
SUBSCRIPTION="${SUBSCRIPTION:-kortix_us_east_2_20260725}"
AUTH_SUBSCRIPTION="${AUTH_SUBSCRIPTION:-kortix_use2_auth_20260725}"
SHADOW_AUDIT_START_AT="${SHADOW_AUDIT_START_AT:-2026-07-25 00:00:00+00}"

require_command() {
  command -v "$1" >/dev/null 2>&1 || {
    echo "Missing required command: $1" >&2
    exit 1
  }
}

for command_name in aws jq node psql; do
  require_command "$command_name"
done

source_secret_json="$(
  aws secretsmanager get-secret-value \
    --secret-id "$SOURCE_SECRET_ID" \
    --region "$SOURCE_AWS_REGION" \
    --query SecretString \
    --output text
)"
target_secret_json="$(
  aws secretsmanager get-secret-value \
    --secret-id "$TARGET_SECRET_ID" \
    --region "$TARGET_AWS_REGION" \
    --query SecretString \
    --output text
)"

source_database_url="$(jq -er '.DATABASE_URL' <<<"$source_secret_json")"
target_database_url="${TARGET_DATABASE_URL_OVERRIDE:-$(jq -er '.target_database_url' <<<"$target_secret_json")}"
replication_username="$(jq -er '.replication_username' <<<"$target_secret_json")"
replication_password="$(jq -er '.replication_password' <<<"$target_secret_json")"

prepare_source() {
  require_command supabase

  supabase postgres-config update \
    --experimental \
    --project-ref jbriwassebxdwoieikga \
    --config max_slot_wal_keep_size=32GB \
    --no-restart \
    --yes \
    -o json >/dev/null

  {
    printf "\\set replication_password '%s'\n" "${replication_password//\'/\'\'}"
    cat <<'SQL'
SELECT format(
  'CREATE ROLE kortix_use2_repl WITH LOGIN REPLICATION PASSWORD %L',
  :'replication_password'
)
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_roles
  WHERE rolname = 'kortix_use2_repl'
)
\gexec
SELECT format(
  'ALTER ROLE kortix_use2_repl WITH LOGIN REPLICATION PASSWORD %L',
  :'replication_password'
)
\gexec
ALTER ROLE kortix_use2_repl SET statement_timeout = 0;
ALTER ROLE kortix_use2_repl BYPASSRLS;
GRANT CONNECT ON DATABASE postgres TO kortix_use2_repl;
GRANT USAGE ON SCHEMA kortix, public TO kortix_use2_repl;
GRANT SELECT ON ALL TABLES IN SCHEMA kortix TO kortix_use2_repl;
GRANT SELECT ON
  public.daily_refresh_tracking,
  public.renewal_processing,
  public.contact_forms,
  public.webhook_config
TO kortix_use2_repl;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres
  IN SCHEMA kortix
  GRANT SELECT ON TABLES TO kortix_use2_repl;
SQL
  } | psql "$source_database_url" -X -v ON_ERROR_STOP=1

  psql "$source_database_url" -X -v ON_ERROR_STOP=1 -v publication="$PUBLICATION" <<'SQL'
SET lock_timeout = '5s';
SELECT set_config('kortix.migration_publication', :'publication', false);

ALTER TABLE kortix.account_members
  REPLICA IDENTITY USING INDEX idx_account_members_user_account;
ALTER TABLE kortix.project_members
  REPLICA IDENTITY USING INDEX idx_project_members_project_user;
ALTER TABLE kortix.sandbox_members
  REPLICA IDENTITY USING INDEX idx_sandbox_members_unique;
ALTER TABLE kortix.sandbox_member_scopes
  REPLICA IDENTITY USING INDEX idx_sandbox_member_scopes_unique;

SELECT format(
  'CREATE PUBLICATION %I WITH (publish = %L)',
  :'publication',
  'insert,update,delete'
)
WHERE NOT EXISTS (
  SELECT 1
  FROM pg_publication
  WHERE pubname = :'publication'
)
\gexec

DO $do$
DECLARE
  publication_name text := current_setting('kortix.migration_publication');
  relation record;
BEGIN
  FOR relation IN
    WITH selected_tables AS (
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema = 'kortix'
        AND table_type = 'BASE TABLE'
        AND table_name NOT IN (
          'channel_configs',
          'integration_credentials',
          'integrations',
          'sandbox_integrations',
          'schema_migrations'
        )
      UNION ALL
      SELECT 'public', table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
        AND table_type = 'BASE TABLE'
        AND table_name IN (
          'daily_refresh_tracking',
          'renewal_processing',
          'contact_forms',
          'webhook_config'
        )
    )
    SELECT
      selected_tables.table_schema,
      selected_tables.table_name,
      string_agg(
        format('%I', columns.column_name),
        ', ' ORDER BY columns.ordinal_position
      ) FILTER (
        WHERE NOT (
          selected_tables.table_schema = 'kortix'
          AND selected_tables.table_name = 'accounts'
          AND columns.column_name = 'personal_account'
        )
      ) AS column_list
    FROM selected_tables
    JOIN information_schema.columns AS columns
      USING (table_schema, table_name)
    GROUP BY selected_tables.table_schema, selected_tables.table_name
    ORDER BY selected_tables.table_schema, selected_tables.table_name
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_rel
      JOIN pg_publication
        ON pg_publication.oid = pg_publication_rel.prpubid
      WHERE pg_publication.pubname = publication_name
        AND pg_publication_rel.prrelid = format(
          '%I.%I',
          relation.table_schema,
          relation.table_name
        )::regclass
    ) THEN
      EXECUTE format(
        'ALTER PUBLICATION %I ADD TABLE %I.%I (%s)',
        publication_name,
        relation.table_schema,
        relation.table_name,
        relation.column_list
      );
    END IF;
  END LOOP;
END
$do$;

SELECT
  pg_publication.pubname,
  count(*) AS published_tables
FROM pg_publication
JOIN pg_publication_rel
  ON pg_publication_rel.prpubid = pg_publication.oid
WHERE pg_publication.pubname = :'publication'
GROUP BY pg_publication.pubname;
SQL
}

start_subscription() {
  duplicate_active_deletions="$(
    psql "$source_database_url" -X -At -v ON_ERROR_STOP=1 -c "
      SELECT count(*)
      FROM (
        SELECT account_id
        FROM kortix.account_deletion_requests
        WHERE is_cancelled = false
          AND is_deleted = false
        GROUP BY account_id
        HAVING count(*) > 1
      ) AS duplicate_accounts
    "
  )"

  if [[ "$duplicate_active_deletions" -gt 0 ]]; then
    psql "$target_database_url" -X -v ON_ERROR_STOP=1 -c \
      'DROP INDEX IF EXISTS kortix.unique_active_deletion_request'
  fi

  source_replication_url="$(
    REPLICATION_USERNAME="$replication_username" \
      REPLICATION_PASSWORD="$replication_password" \
      node -e '
      const url = new URL(process.argv[1])
      url.username = process.env.REPLICATION_USERNAME
      url.password = process.env.REPLICATION_PASSWORD
      url.searchParams.set("sslmode", "require")
      url.searchParams.set("application_name", process.argv[2])
      url.searchParams.set("options", "-c statement_timeout=0")
      process.stdout.write(url.toString())
    ' "$source_database_url" "$SUBSCRIPTION"
  )"

  subscription_exists="$(
    psql "$target_database_url" -X -At -v ON_ERROR_STOP=1 \
      -v subscription="$SUBSCRIPTION" <<'SQL'
SELECT EXISTS (
  SELECT 1
  FROM pg_subscription
  WHERE subname = :'subscription'
);
SQL
  )"

  if [[ "$subscription_exists" == "t" ]]; then
    psql "$target_database_url" -X -v ON_ERROR_STOP=1 \
      -v subscription="$SUBSCRIPTION" <<'SQL'
SELECT format('ALTER SUBSCRIPTION %I ENABLE', :'subscription')
\gexec
SQL
    return
  fi

  escaped_replication_url="${source_replication_url//\'/\'\'}"
  {
    printf "\\set source_replication_url '%s'\n" "$escaped_replication_url"
    printf "\\set publication '%s'\n" "$PUBLICATION"
    printf "\\set subscription '%s'\n" "$SUBSCRIPTION"
    cat <<'SQL'
SET statement_timeout = 0;
SELECT format(
  'CREATE SUBSCRIPTION %I CONNECTION %L PUBLICATION %I WITH (copy_data = true, create_slot = true, enabled = true, binary = false, streaming = %L, two_phase = false, disable_on_error = true, origin = %L)',
  :'subscription',
  :'source_replication_url',
  :'publication',
  'parallel',
  'none'
)
\gexec
SQL
  } | psql "$target_database_url" -X -v ON_ERROR_STOP=1
}

status() {
  echo "Subscriber:"
  psql "$target_database_url" -X -P pager=off -A -F $'\t' \
    -v subscription="$SUBSCRIPTION" <<'SQL'
SELECT
  pg_subscription.subname,
  pg_subscription.subenabled,
  pg_stat_subscription.pid,
  pg_stat_subscription.worker_type,
  pg_stat_subscription.relid::regclass AS relation,
  pg_stat_subscription.received_lsn,
  pg_stat_subscription.latest_end_lsn,
  pg_stat_subscription.last_msg_receipt_time
FROM pg_subscription
LEFT JOIN pg_stat_subscription
  ON pg_stat_subscription.subid = pg_subscription.oid
WHERE pg_subscription.subname = :'subscription'
ORDER BY pg_stat_subscription.worker_type, pg_stat_subscription.relid::regclass::text;

SELECT
  pg_subscription_rel.srsubstate,
  count(*)
FROM pg_subscription_rel
WHERE pg_subscription_rel.srsubid = (
  SELECT oid
  FROM pg_subscription
  WHERE subname = :'subscription'
)
GROUP BY pg_subscription_rel.srsubstate
ORDER BY pg_subscription_rel.srsubstate;

SELECT *
FROM pg_stat_subscription_stats
WHERE subname = :'subscription';
SQL

  echo "Publisher:"
  psql "$source_database_url" -X -P pager=off -A -F $'\t' \
    -v subscription="$SUBSCRIPTION" <<'SQL'
SELECT
  slot_name,
  active,
  confirmed_flush_lsn,
  pg_size_pretty(
    pg_wal_lsn_diff(pg_current_wal_lsn(), restart_lsn)
  ) AS retained_wal
FROM pg_replication_slots
WHERE slot_name = :'subscription';

SELECT name, setting, unit, pending_restart
FROM pg_settings
WHERE name = 'max_slot_wal_keep_size';
SQL
}

wait_caught_up() {
  local source_lsn
  local caught_up
  local latest_end_lsn

  source_lsn="$(
    psql "$source_database_url" -X -qAt -v ON_ERROR_STOP=1 \
      -c 'SELECT pg_current_wal_lsn()'
  )"
  if [[ -z "$source_lsn" ]]; then
    echo "Could not read the source WAL position." >&2
    exit 1
  fi

  for attempt in $(seq 1 180); do
    IFS=$'\t' read -r caught_up latest_end_lsn < <(
      psql "$target_database_url" -X -qAt -F $'\t' -v ON_ERROR_STOP=1 \
        -v subscription="$SUBSCRIPTION" \
        -v source_lsn="$source_lsn" <<'SQL'
SELECT
  COALESCE(bool_and(latest_end_lsn >= :'source_lsn'::pg_lsn), false),
  COALESCE(max(latest_end_lsn)::text, '')
FROM pg_stat_subscription
WHERE subname = :'subscription'
  AND worker_type = 'apply';
SQL
    )
    if [[ "$caught_up" == "t" ]]; then
      echo "Application subscription reached source WAL position $source_lsn."
      return
    fi
    echo "Application catch-up $attempt/180: target=${latest_end_lsn:-missing} source=$source_lsn"
    sleep 2
  done

  echo "Application subscription did not reach source WAL position $source_lsn within six minutes." >&2
  exit 1
}

set_subscription_enabled() {
  local enabled="$1"
  local guard_name
  local guard_value
  local action
  local actual
  local expected

  if [[ "$enabled" == "true" ]]; then
    guard_name="ALLOW_ENABLE_APPLICATION_SUBSCRIPTION"
    guard_value="${ALLOW_ENABLE_APPLICATION_SUBSCRIPTION:-}"
    action="ENABLE"
  else
    guard_name="ALLOW_DISABLE_APPLICATION_SUBSCRIPTION"
    guard_value="${ALLOW_DISABLE_APPLICATION_SUBSCRIPTION:-}"
    action="DISABLE"
  fi
  if [[ "$guard_value" != "1" ]]; then
    echo "Set $guard_name=1 to ${action,,} the application subscription." >&2
    exit 64
  fi

  psql "$target_database_url" -X -q -v ON_ERROR_STOP=1 \
    -v subscription="$SUBSCRIPTION" \
    -v action="$action" <<'SQL'
SELECT format('ALTER SUBSCRIPTION %I %s', :'subscription', :'action')
\gexec
SQL

  actual="$(
    psql "$target_database_url" -X -qAt -v ON_ERROR_STOP=1 \
      -v subscription="$SUBSCRIPTION" <<'SQL'
SELECT subenabled
FROM pg_subscription
WHERE subname = :'subscription';
SQL
  )"
  expected="f"
  [[ "$enabled" == "true" ]] && expected="t"
  if [[ "$actual" != "$expected" ]]; then
    echo "Application subscription state is $actual, expected $expected." >&2
    exit 1
  fi
  echo "Application subscription is $([[ "$enabled" == "true" ]] && echo enabled || echo disabled)."
}

repair_public_rls_tables() {
  if [[ "${ALLOW_TARGET_PUBLIC_REPAIR:-}" != "1" ]]; then
    echo "Set ALLOW_TARGET_PUBLIC_REPAIR=1 to repair the RLS-protected public tables on the US target." >&2
    exit 64
  fi

  local temporary_directory
  local source_read_fd
  local source_write_fd
  local source_session_pid
  local snapshot_lsn
  local marker
  local line
  local caught_up=false
  local subscription_disabled=false

  temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/kortix-use2-public-repair.XXXXXX")"

  coproc SOURCE_SESSION {
    psql "$source_database_url" -X -qAt -v ON_ERROR_STOP=1
  }
  source_read_fd="${SOURCE_SESSION[0]}"
  source_write_fd="${SOURCE_SESSION[1]}"
  # shellcheck disable=SC2153 # Bash creates <coproc-name>_PID dynamically.
  source_session_pid="$SOURCE_SESSION_PID"

  cleanup_public_repair() {
    if [[ "$subscription_disabled" == "true" ]]; then
      psql "$target_database_url" -X -q -v ON_ERROR_STOP=1 \
        -v subscription="$SUBSCRIPTION" <<'SQL' || true
SELECT format('ALTER SUBSCRIPTION %I ENABLE', :'subscription')
\gexec
SQL
    fi

    if [[ -n "${source_write_fd:-}" ]]; then
      printf 'ROLLBACK;\n\\q\n' 1>&"$source_write_fd" 2>/dev/null || true
    fi
    if [[ -n "${source_session_pid:-}" ]]; then
      wait "$source_session_pid" 2>/dev/null || true
    fi

    find "$temporary_directory" -type f -exec unlink {} + 2>/dev/null || true
    rmdir "$temporary_directory" 2>/dev/null || true
  }
  trap cleanup_public_repair EXIT

  {
    printf 'BEGIN ISOLATION LEVEL REPEATABLE READ;\n'
    printf 'LOCK TABLE public.contact_forms, public.renewal_processing, public.webhook_config IN SHARE MODE;\n'
    printf "SELECT 'LOCKED' || E'\\\\t' || pg_current_wal_lsn();\n"
  } >&"$source_write_fd"

  IFS=$'\t' read -r marker snapshot_lsn <&"$source_read_fd"
  if [[ "$marker" != "LOCKED" || -z "$snapshot_lsn" ]]; then
    echo "Failed to lock the source public tables." >&2
    exit 1
  fi

  {
    printf "\\copy public.contact_forms TO '%s/contact_forms.csv' WITH (FORMAT csv)\n" "$temporary_directory"
    printf "\\copy public.renewal_processing TO '%s/renewal_processing.csv' WITH (FORMAT csv)\n" "$temporary_directory"
    printf "\\copy public.webhook_config TO '%s/webhook_config.csv' WITH (FORMAT csv)\n" "$temporary_directory"
    printf '\\echo SNAPSHOT_READY\n'
  } >&"$source_write_fd"

  while IFS= read -r line <&"$source_read_fd"; do
    if [[ "$line" == "SNAPSHOT_READY" ]]; then
      break
    fi
  done
  if [[ "$line" != "SNAPSHOT_READY" ]]; then
    echo "Failed to export the locked source public tables." >&2
    exit 1
  fi

  for _ in $(seq 1 120); do
    caught_up="$(
      psql "$target_database_url" -X -qAt -v ON_ERROR_STOP=1 \
        -v subscription="$SUBSCRIPTION" \
        -v snapshot_lsn="$snapshot_lsn" <<'SQL'
SELECT COALESCE(
  bool_and(latest_end_lsn >= :'snapshot_lsn'::pg_lsn),
  false
)
FROM pg_stat_subscription
WHERE subname = :'subscription'
  AND worker_type = 'apply';
SQL
    )"
    if [[ "$caught_up" == "t" ]]; then
      break
    fi
    sleep 1
  done
  if [[ "$caught_up" != "t" ]]; then
    echo "The application subscription did not reach the locked source snapshot." >&2
    exit 1
  fi

  psql "$target_database_url" -X -q -v ON_ERROR_STOP=1 \
    -v subscription="$SUBSCRIPTION" <<'SQL'
SELECT format('ALTER SUBSCRIPTION %I DISABLE', :'subscription')
\gexec
SQL
  subscription_disabled=true

  {
    printf 'BEGIN;\n'
    printf 'DELETE FROM public.contact_forms;\n'
    printf 'DELETE FROM public.renewal_processing;\n'
    printf 'DELETE FROM public.webhook_config;\n'
    printf "\\copy public.contact_forms FROM '%s/contact_forms.csv' WITH (FORMAT csv)\n" "$temporary_directory"
    printf "\\copy public.renewal_processing FROM '%s/renewal_processing.csv' WITH (FORMAT csv)\n" "$temporary_directory"
    printf "\\copy public.webhook_config FROM '%s/webhook_config.csv' WITH (FORMAT csv)\n" "$temporary_directory"
    printf 'COMMIT;\n'
  } | psql "$target_database_url" -X -q -v ON_ERROR_STOP=1

  psql "$target_database_url" -X -q -v ON_ERROR_STOP=1 \
    -v subscription="$SUBSCRIPTION" <<'SQL'
SELECT format('ALTER SUBSCRIPTION %I ENABLE', :'subscription')
\gexec
SQL
  subscription_disabled=false

  printf 'ROLLBACK;\n\\q\n' >&"$source_write_fd"
  wait "$source_session_pid"
  source_session_pid=""
  source_write_fd=""

  trap - EXIT
  cleanup_public_repair
  echo "Repaired the RLS-protected public tables from a locked source snapshot."
}

repair_shadow_mutations() {
  if [[ "${ALLOW_TARGET_SHADOW_REPAIR:-}" != "1" ]]; then
    echo "Set ALLOW_TARGET_SHADOW_REPAIR=1 to replace target-only shadow mutations." >&2
    exit 64
  fi

  local temporary_directory
  local subscription_was_enabled
  local cleanup_trap
  local credit_account_columns
  temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/kortix-use2-shadow-repair.XXXXXX")"
  subscription_was_enabled="$(
    psql "$target_database_url" -X -qAt -v ON_ERROR_STOP=1 \
      -v subscription="$SUBSCRIPTION" <<'SQL'
SELECT subenabled
FROM pg_subscription
WHERE subname = :'subscription';
SQL
  )"

  cleanup_shadow_repair() {
    local directory="$1"
    local should_enable_subscription="$2"
    if [[ "$should_enable_subscription" == "t" ]]; then
      psql "$target_database_url" -X -q -v ON_ERROR_STOP=1 \
        -v subscription="$SUBSCRIPTION" <<'SQL' || true
SELECT format('ALTER SUBSCRIPTION %I ENABLE', :'subscription')
\gexec
SQL
    fi
    find "$directory" -type f -exec unlink {} \; 2>/dev/null || true
    rmdir "$directory" 2>/dev/null || true
  }
  printf -v cleanup_trap 'cleanup_shadow_repair %q %q' \
    "$temporary_directory" "$subscription_was_enabled"
  # shellcheck disable=SC2064 # The caller supplies the complete deferred cleanup command.
  trap "$cleanup_trap" EXIT

  if [[ "$subscription_was_enabled" == "t" ]]; then
    psql "$target_database_url" -X -q -v ON_ERROR_STOP=1 \
      -v subscription="$SUBSCRIPTION" <<'SQL'
SELECT format('ALTER SUBSCRIPTION %I DISABLE', :'subscription')
\gexec
SQL
  fi

  credit_account_columns="$(
    psql "$source_database_url" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
SELECT string_agg(format('%I', column_name), ', ' ORDER BY ordinal_position)
FROM information_schema.columns
WHERE table_schema = 'kortix'
  AND table_name = 'credit_accounts'
  AND is_generated = 'NEVER';
SQL
  )"

  psql "$source_database_url" -X -q -v ON_ERROR_STOP=1 \
    -c "\\copy (SELECT key_id, last_used_at FROM kortix.api_keys ORDER BY key_id) TO '$temporary_directory/api_keys.csv' WITH (FORMAT csv)"
  psql "$source_database_url" -X -q -v ON_ERROR_STOP=1 \
    -c "\\copy (SELECT $credit_account_columns FROM kortix.credit_accounts ORDER BY account_id) TO '$temporary_directory/credit_accounts.csv' WITH (FORMAT csv)"
  psql "$source_database_url" -X -q -v ON_ERROR_STOP=1 \
    -c "\\copy (SELECT id FROM kortix.credit_ledger ORDER BY id) TO '$temporary_directory/credit_ledger_ids.csv' WITH (FORMAT csv)"
  psql "$source_database_url" -X -q -v ON_ERROR_STOP=1 \
    -c "\\copy (SELECT session_id, last_used_at, metadata, updated_at FROM kortix.session_sandboxes ORDER BY session_id COLLATE \"C\") TO '$temporary_directory/session_sandboxes.csv' WITH (FORMAT csv)"
  psql "$source_database_url" -X -q -v ON_ERROR_STOP=1 \
    -v shadow_audit_start_at="$SHADOW_AUDIT_START_AT" \
    >"$temporary_directory/audit_event_ids.csv" <<'SQL'
COPY (
  SELECT event_id
  FROM kortix.audit_events
  WHERE occurred_at >= :'shadow_audit_start_at'::timestamptz
  ORDER BY event_id
) TO STDOUT WITH (FORMAT csv);
SQL

  {
    cat <<'SQL'
	BEGIN;
	SET LOCAL statement_timeout = 0;
	SET LOCAL session_replication_role = replica;
CREATE TEMP TABLE repair_api_keys (
  key_id uuid PRIMARY KEY,
  last_used_at timestamptz
) ON COMMIT DROP;
CREATE TEMP TABLE repair_session_sandboxes (
  session_id text PRIMARY KEY,
  last_used_at timestamptz,
  metadata jsonb,
  updated_at timestamptz
) ON COMMIT DROP;
CREATE TEMP TABLE repair_credit_ledger_ids (
  id uuid PRIMARY KEY
) ON COMMIT DROP;
CREATE TEMP TABLE repair_audit_event_ids (
  event_id uuid PRIMARY KEY
) ON COMMIT DROP;
SQL
    printf "CREATE TEMP TABLE repair_credit_accounts AS SELECT %s FROM kortix.credit_accounts WITH NO DATA;\n" \
      "$credit_account_columns"
    printf "\\copy repair_api_keys FROM '%s/api_keys.csv' WITH (FORMAT csv)\n" "$temporary_directory"
    printf "\\copy repair_credit_accounts FROM '%s/credit_accounts.csv' WITH (FORMAT csv)\n" "$temporary_directory"
    printf "\\copy repair_credit_ledger_ids FROM '%s/credit_ledger_ids.csv' WITH (FORMAT csv)\n" "$temporary_directory"
    printf "\\copy repair_session_sandboxes FROM '%s/session_sandboxes.csv' WITH (FORMAT csv)\n" "$temporary_directory"
    printf "\\copy repair_audit_event_ids FROM '%s/audit_event_ids.csv' WITH (FORMAT csv)\n" "$temporary_directory"
    cat <<'SQL'
UPDATE kortix.api_keys AS target
SET last_used_at = source.last_used_at
FROM repair_api_keys AS source
WHERE target.key_id = source.key_id
  AND target.last_used_at IS DISTINCT FROM source.last_used_at;

	DO $do$
DECLARE
  all_column_list text;
  column_list text;
  source_column_list text;
  target_column_list text;
BEGIN
  SELECT
    string_agg(format('%I', attname), ', ' ORDER BY attnum),
    string_agg(format('%I', attname), ', ' ORDER BY attnum)
      FILTER (WHERE attname <> 'account_id'),
    string_agg(format('source.%I', attname), ', ' ORDER BY attnum)
      FILTER (WHERE attname <> 'account_id'),
    string_agg(format('target.%I', attname), ', ' ORDER BY attnum)
      FILTER (WHERE attname <> 'account_id')
  INTO all_column_list, column_list, source_column_list, target_column_list
  FROM pg_attribute
  WHERE attrelid = 'repair_credit_accounts'::regclass
    AND attnum > 0
    AND NOT attisdropped;

  EXECUTE format(
	    'UPDATE kortix.credit_accounts AS target
	       SET (%1$s) = (%2$s)
	      FROM repair_credit_accounts AS source
	     WHERE target.account_id = source.account_id
	       AND ROW(%3$s) IS DISTINCT FROM ROW(%2$s)',
	    column_list,
	    source_column_list,
    target_column_list
  );

  EXECUTE format(
    'INSERT INTO kortix.credit_accounts (%1$s)
     SELECT %1$s
       FROM repair_credit_accounts AS source
      WHERE NOT EXISTS (
        SELECT 1
          FROM kortix.credit_accounts AS target
         WHERE target.account_id = source.account_id
      )',
    all_column_list
  );
END
$do$;

UPDATE kortix.credit_accounts AS target
SET
  balance_precise = source.balance,
  lifetime_granted_precise = source.lifetime_granted,
  lifetime_purchased_precise = source.lifetime_purchased,
  lifetime_used_precise = source.lifetime_used,
  expiring_credits_precise = source.expiring_credits,
  non_expiring_credits_precise = source.non_expiring_credits,
  daily_credits_balance_precise = source.daily_credits_balance
FROM repair_credit_accounts AS source
WHERE target.account_id = source.account_id
  AND ROW(
    target.balance_precise,
    target.lifetime_granted_precise,
    target.lifetime_purchased_precise,
    target.lifetime_used_precise,
    target.expiring_credits_precise,
    target.non_expiring_credits_precise,
    target.daily_credits_balance_precise
  ) IS DISTINCT FROM ROW(
    source.balance,
    source.lifetime_granted,
    source.lifetime_purchased,
    source.lifetime_used,
    source.expiring_credits,
    source.non_expiring_credits,
    source.daily_credits_balance
  );

	DELETE FROM kortix.credit_accounts AS target
	WHERE NOT EXISTS (
	  SELECT 1
	  FROM repair_credit_accounts AS source
	  WHERE source.account_id = target.account_id
	);

DELETE FROM kortix.credit_ledger AS target
WHERE NOT EXISTS (
  SELECT 1
  FROM repair_credit_ledger_ids AS source
  WHERE source.id = target.id
);

UPDATE kortix.session_sandboxes AS target
SET
  last_used_at = source.last_used_at,
  metadata = source.metadata,
  updated_at = source.updated_at
FROM repair_session_sandboxes AS source
WHERE target.session_id = source.session_id
  AND (
    target.last_used_at,
    target.metadata,
    target.updated_at
  ) IS DISTINCT FROM (
    source.last_used_at,
    source.metadata,
    source.updated_at
  );

DELETE FROM kortix.audit_events AS target
WHERE target.occurred_at >= :'shadow_audit_start_at'::timestamptz
  AND target.occurred_at < now() - interval '15 minutes'
  AND NOT EXISTS (
    SELECT 1
    FROM repair_audit_event_ids AS source
    WHERE source.event_id = target.event_id
  );
COMMIT;
SQL
  } | psql "$target_database_url" -X -q -v ON_ERROR_STOP=1 \
    -v shadow_audit_start_at="$SHADOW_AUDIT_START_AT"

  if [[ "$subscription_was_enabled" == "t" ]]; then
    psql "$target_database_url" -X -q -v ON_ERROR_STOP=1 \
      -v subscription="$SUBSCRIPTION" <<'SQL'
SELECT format('ALTER SUBSCRIPTION %I ENABLE', :'subscription')
\gexec
SQL
  fi

  trap - EXIT
  cleanup_shadow_repair "$temporary_directory" "f"
  echo "Replaced target-only shadow mutations and restored the prior replication state."
}

backfill_target_precision_columns() {
  if [[ "${ALLOW_TARGET_PRECISION_BACKFILL:-}" != "1" ]]; then
    echo "Set ALLOW_TARGET_PRECISION_BACKFILL=1 to backfill target-only precision columns." >&2
    exit 64
  fi

  psql "$target_database_url" -X -v ON_ERROR_STOP=1 <<'SQL'
BEGIN;
SET LOCAL statement_timeout = 0;

ALTER TABLE kortix.credit_accounts
  ENABLE ALWAYS TRIGGER sync_credit_account_precision_columns;
ALTER TABLE kortix.credit_ledger
  ENABLE ALWAYS TRIGGER sync_credit_ledger_precision_columns;
ALTER TABLE kortix.gateway_request_logs
  ENABLE ALWAYS TRIGGER sync_gateway_request_log_cost_precision;
ALTER TABLE kortix.usage_events
  ENABLE ALWAYS TRIGGER sync_usage_event_cost_precision;

UPDATE kortix.credit_accounts
SET
  balance_precise = balance,
  lifetime_granted_precise = lifetime_granted,
  lifetime_purchased_precise = lifetime_purchased,
  lifetime_used_precise = lifetime_used,
  expiring_credits_precise = expiring_credits,
  non_expiring_credits_precise = non_expiring_credits,
  daily_credits_balance_precise = daily_credits_balance
WHERE ROW(
  balance_precise,
  lifetime_granted_precise,
  lifetime_purchased_precise,
  lifetime_used_precise,
  expiring_credits_precise,
  non_expiring_credits_precise,
  daily_credits_balance_precise
) IS DISTINCT FROM ROW(
  balance,
  lifetime_granted,
  lifetime_purchased,
  lifetime_used,
  expiring_credits,
  non_expiring_credits,
  daily_credits_balance
);

UPDATE kortix.credit_ledger
SET
  amount_precise = amount,
  balance_after_precise = balance_after
WHERE ROW(amount_precise, balance_after_precise)
  IS DISTINCT FROM ROW(amount, balance_after);

UPDATE kortix.gateway_request_logs
SET
  upstream_cost_precise = upstream_cost,
  final_cost_precise = final_cost
WHERE ROW(upstream_cost_precise, final_cost_precise)
  IS DISTINCT FROM ROW(upstream_cost, final_cost);

UPDATE kortix.usage_events
SET cost_usd_precise = cost_usd
WHERE cost_usd_precise IS DISTINCT FROM cost_usd;

COMMIT;

SELECT relation, mismatches
FROM (
  SELECT
    'kortix.credit_accounts' AS relation,
    count(*) FILTER (
      WHERE ROW(
        balance_precise,
        lifetime_granted_precise,
        lifetime_purchased_precise,
        lifetime_used_precise,
        expiring_credits_precise,
        non_expiring_credits_precise,
        daily_credits_balance_precise
      ) IS DISTINCT FROM ROW(
        balance,
        lifetime_granted,
        lifetime_purchased,
        lifetime_used,
        expiring_credits,
        non_expiring_credits,
        daily_credits_balance
      )
    ) AS mismatches
  FROM kortix.credit_accounts
  UNION ALL
  SELECT
    'kortix.credit_ledger',
    count(*) FILTER (
      WHERE ROW(amount_precise, balance_after_precise)
        IS DISTINCT FROM ROW(amount, balance_after)
    )
  FROM kortix.credit_ledger
  UNION ALL
  SELECT
    'kortix.gateway_request_logs',
    count(*) FILTER (
      WHERE ROW(upstream_cost_precise, final_cost_precise)
        IS DISTINCT FROM ROW(upstream_cost, final_cost)
    )
  FROM kortix.gateway_request_logs
  UNION ALL
  SELECT
    'kortix.usage_events',
    count(*) FILTER (
      WHERE cost_usd_precise IS DISTINCT FROM cost_usd
    )
  FROM kortix.usage_events
) AS precision_state
ORDER BY relation;
SQL
}

write_counts() {
  local database_url="$1"
  local output_file="$2"
  local database_side="$3"

  psql "$database_url" -X -qAt -F $'\t' -v ON_ERROR_STOP=1 \
    -v database_side="$database_side" \
    -v publication="$PUBLICATION" \
    -v subscription="$SUBSCRIPTION" \
    >"$output_file" <<'SQL'
BEGIN;
CREATE TEMP TABLE migration_counts (
  schema_name text NOT NULL,
  table_name text NOT NULL,
  row_count bigint NOT NULL
) ON COMMIT DROP;

SELECT
  set_config('kortix.migration_database_side', :'database_side', true),
  set_config('kortix.migration_publication', :'publication', true),
  set_config('kortix.migration_subscription', :'subscription', true)
\gset

DO $do$
DECLARE
  database_side text := current_setting('kortix.migration_database_side');
  publication_name text := current_setting('kortix.migration_publication');
  subscription_name text := current_setting('kortix.migration_subscription');
  relation record;
BEGIN
  FOR relation IN
    WITH replicated_tables AS (
      SELECT
        pg_namespace.nspname AS table_schema,
        pg_class.relname AS table_name
      FROM pg_publication
      JOIN pg_publication_rel
        ON pg_publication_rel.prpubid = pg_publication.oid
      JOIN pg_class
        ON pg_class.oid = pg_publication_rel.prrelid
      JOIN pg_namespace
        ON pg_namespace.oid = pg_class.relnamespace
      WHERE database_side = 'source'
        AND pg_publication.pubname = publication_name

      UNION ALL

      SELECT
        pg_namespace.nspname AS table_schema,
        pg_class.relname AS table_name
      FROM pg_subscription
      JOIN pg_subscription_rel
        ON pg_subscription_rel.srsubid = pg_subscription.oid
      JOIN pg_class
        ON pg_class.oid = pg_subscription_rel.srrelid
      JOIN pg_namespace
        ON pg_namespace.oid = pg_class.relnamespace
      WHERE database_side = 'target'
        AND pg_subscription.subname = subscription_name
    )
    SELECT table_schema, table_name
    FROM replicated_tables
    ORDER BY table_schema, table_name
  LOOP
    EXECUTE format(
      'INSERT INTO migration_counts SELECT %L, %L, count(*) FROM %I.%I',
      relation.table_schema,
      relation.table_name,
      relation.table_schema,
      relation.table_name
    );
  END LOOP;
END
$do$;

SELECT schema_name, table_name, row_count
FROM migration_counts
ORDER BY schema_name COLLATE "C", table_name COLLATE "C";
COMMIT;
SQL
}

reconcile_counts() {
  temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/kortix-use2-counts.XXXXXX")"
  source_counts="$temporary_directory/source.tsv"
  target_counts="$temporary_directory/target.tsv"
  cleanup_counts() {
    [[ -f "$source_counts" ]] && unlink "$source_counts"
    [[ -f "$target_counts" ]] && unlink "$target_counts"
    [[ -d "$temporary_directory" ]] && rmdir "$temporary_directory"
  }
  trap cleanup_counts EXIT

  write_counts "$source_database_url" "$source_counts" source &
  source_count_pid=$!
  write_counts "$target_database_url" "$target_counts" target &
  target_count_pid=$!
  wait "$source_count_pid"
  wait "$target_count_pid"

  if diff -u "$source_counts" "$target_counts"; then
    echo "All replicated table row counts match."
  else
    echo "Replicated table row counts differ." >&2
    exit 1
  fi
}

write_key_hashes() {
  local database_url="$1"
  local output_file="$2"
  local database_side="$3"

  psql "$database_url" -X -qAt -F $'\t' -v ON_ERROR_STOP=1 \
    -v database_side="$database_side" \
    -v publication="$PUBLICATION" \
    -v subscription="$SUBSCRIPTION" \
    >"$output_file" <<'SQL'
BEGIN;
SET LOCAL TIME ZONE 'UTC';
CREATE TEMP TABLE migration_key_hashes (
  schema_name text NOT NULL,
  table_name text NOT NULL,
  row_count bigint NOT NULL,
  hash_a numeric NOT NULL,
  hash_b numeric NOT NULL
) ON COMMIT DROP;

SELECT
  set_config('kortix.migration_database_side', :'database_side', true),
  set_config('kortix.migration_publication', :'publication', true),
  set_config('kortix.migration_subscription', :'subscription', true)
\gset

DO $do$
DECLARE
  database_side text := current_setting('kortix.migration_database_side');
  publication_name text := current_setting('kortix.migration_publication');
  subscription_name text := current_setting('kortix.migration_subscription');
  relation record;
BEGIN
  FOR relation IN
    WITH selected_tables AS (
      SELECT
        pg_namespace.nspname AS table_schema,
        pg_class.relname AS table_name
      FROM pg_publication
      JOIN pg_publication_rel
        ON pg_publication_rel.prpubid = pg_publication.oid
      JOIN pg_class
        ON pg_class.oid = pg_publication_rel.prrelid
      JOIN pg_namespace
        ON pg_namespace.oid = pg_class.relnamespace
      WHERE database_side = 'source'
        AND pg_publication.pubname = publication_name

      UNION ALL

      SELECT
        pg_namespace.nspname AS table_schema,
        pg_class.relname AS table_name
      FROM pg_subscription
      JOIN pg_subscription_rel
        ON pg_subscription_rel.srsubid = pg_subscription.oid
      JOIN pg_class
        ON pg_class.oid = pg_subscription_rel.srrelid
      JOIN pg_namespace
        ON pg_namespace.oid = pg_class.relnamespace
      WHERE database_side = 'target'
        AND pg_subscription.subname = subscription_name
    )
    SELECT
      selected_tables.table_schema,
      selected_tables.table_name,
      string_agg(
        format('%I', key_attribute.attname),
        ', ' ORDER BY key_column.ordinality
      ) AS key_columns
    FROM selected_tables
    JOIN pg_namespace
      ON pg_namespace.nspname = selected_tables.table_schema
    JOIN pg_class
      ON pg_class.relnamespace = pg_namespace.oid
     AND pg_class.relname = selected_tables.table_name
    JOIN LATERAL (
      SELECT pg_index.*
      FROM pg_index
      WHERE pg_index.indrelid = pg_class.oid
        AND pg_index.indisvalid
        AND pg_index.indisready
        AND (pg_index.indisprimary OR pg_index.indisunique)
        AND pg_index.indpred IS NULL
      ORDER BY
        pg_index.indisprimary DESC,
        pg_index.indisreplident DESC,
        pg_index.indexrelid::regclass::text COLLATE "C"
      LIMIT 1
    ) AS selected_index
      ON true
    JOIN LATERAL unnest(selected_index.indkey)
      WITH ORDINALITY AS key_column(attnum, ordinality)
      ON key_column.ordinality <= selected_index.indnkeyatts
    JOIN pg_attribute AS key_attribute
      ON key_attribute.attrelid = pg_class.oid
     AND key_attribute.attnum = key_column.attnum
    GROUP BY selected_tables.table_schema, selected_tables.table_name
    ORDER BY
      selected_tables.table_schema COLLATE "C",
      selected_tables.table_name COLLATE "C"
  LOOP
    EXECUTE format(
      $query$
      INSERT INTO migration_key_hashes
      SELECT
        %L,
        %L,
        count(*),
        COALESCE(
          sum(
            pg_catalog.jsonb_hash_extended(
              key_value,
              0
            )::numeric
          ),
          0
        ),
        COALESCE(
          sum(
            pg_catalog.jsonb_hash_extended(
              key_value,
              -7046029254386353131
            )::numeric
          ),
          0
        )
      FROM (
        SELECT jsonb_build_array(%s) AS key_value
        FROM %I.%I
      ) AS relation_keys
      $query$,
      relation.table_schema,
      relation.table_name,
      relation.key_columns,
      relation.table_schema,
      relation.table_name
    );
  END LOOP;
END
$do$;

SELECT schema_name, table_name, row_count, hash_a, hash_b
FROM migration_key_hashes
ORDER BY schema_name COLLATE "C", table_name COLLATE "C";
COMMIT;
SQL
}

write_critical_hashes() {
  local database_url="$1"
  local output_file="$2"

  psql "$database_url" -X -qAt -F $'\t' -v ON_ERROR_STOP=1 >"$output_file" <<'SQL'
BEGIN;
SET LOCAL TIME ZONE 'UTC';
CREATE TEMP TABLE migration_critical_hashes (
  schema_name text NOT NULL,
  table_name text NOT NULL,
  row_count bigint NOT NULL,
  hash_a numeric NOT NULL,
  hash_b numeric NOT NULL
) ON COMMIT DROP;

DO $do$
DECLARE
  relation record;
BEGIN
  FOR relation IN
    SELECT
      information_schema.columns.table_schema,
      information_schema.columns.table_name,
      string_agg(
        format('%I', information_schema.columns.column_name),
        ', ' ORDER BY information_schema.columns.column_name COLLATE "C"
      ) FILTER (
        WHERE NOT (
          information_schema.columns.table_name = 'accounts'
          AND information_schema.columns.column_name = 'personal_account'
        )
      ) AS row_columns
    FROM information_schema.columns
    WHERE information_schema.columns.table_schema = 'kortix'
      AND information_schema.columns.is_generated = 'NEVER'
      AND information_schema.columns.table_name IN (
        'account_members',
        'accounts',
        'api_keys',
        'billing_customer_aliases',
        'billing_customers',
        'billing_subscription_anchors',
        'billing_subscriptions',
        'credit_accounts',
        'credit_ledger',
        'credit_purchases',
        'gateway_api_keys',
        'project_members',
        'project_sessions',
        'projects',
        'sandboxes',
        'session_sandboxes',
        'stripe_webhook_events_processed'
      )
    GROUP BY
      information_schema.columns.table_schema,
      information_schema.columns.table_name
    ORDER BY
      information_schema.columns.table_schema COLLATE "C",
      information_schema.columns.table_name COLLATE "C"
  LOOP
    EXECUTE format(
      $query$
      INSERT INTO migration_critical_hashes
      SELECT
        %L,
        %L,
        count(*),
        COALESCE(
          sum(
            pg_catalog.jsonb_hash_extended(
              row_value,
              0
            )::numeric
          ),
          0
        ),
        COALESCE(
          sum(
            pg_catalog.jsonb_hash_extended(
              row_value,
              -7046029254386353131
            )::numeric
          ),
          0
        )
      FROM (
        SELECT jsonb_build_array(%s) AS row_value
        FROM %I.%I
      ) AS relation_rows
      $query$,
      relation.table_schema,
      relation.table_name,
      relation.row_columns,
      relation.table_schema,
      relation.table_name
    );
  END LOOP;
END
$do$;

SELECT schema_name, table_name, row_count, hash_a, hash_b
FROM migration_critical_hashes
ORDER BY schema_name COLLATE "C", table_name COLLATE "C";
COMMIT;
SQL
}

reconcile_hashes() {
  local mode="$1"
  local writer
  local label

  case "$mode" in
    keys)
      writer=write_key_hashes
      label="primary-key and replica-identity"
      ;;
    critical)
      writer=write_critical_hashes
      label="critical row"
      ;;
    *)
      echo "Unknown hash reconciliation mode: $mode" >&2
      exit 64
      ;;
  esac

  temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/kortix-use2-hashes.XXXXXX")"
  source_hashes="$temporary_directory/source.tsv"
  target_hashes="$temporary_directory/target.tsv"
  cleanup_hashes() {
    [[ -f "$source_hashes" ]] && unlink "$source_hashes"
    [[ -f "$target_hashes" ]] && unlink "$target_hashes"
    [[ -d "$temporary_directory" ]] && rmdir "$temporary_directory"
  }
  trap cleanup_hashes EXIT

  "$writer" "$source_database_url" "$source_hashes" source &
  source_hash_pid=$!
  "$writer" "$target_database_url" "$target_hashes" target &
  target_hash_pid=$!
  wait "$source_hash_pid"
  wait "$target_hash_pid"

  if diff -u "$source_hashes" "$target_hashes"; then
    echo "All replicated $label hashes match."
  else
    echo "Replicated $label hashes differ." >&2
    exit 1
  fi
}

write_sequence_state() {
  local database_url="$1"
  local output_file="$2"

  psql "$database_url" -X -qAt -F $'\t' -v ON_ERROR_STOP=1 >"$output_file" <<'SQL'
BEGIN;
CREATE TEMP TABLE migration_sequence_state (
  schema_name text NOT NULL,
  sequence_name text NOT NULL,
  last_value bigint NOT NULL,
  is_called boolean NOT NULL
) ON COMMIT DROP;

SELECT format(
  'INSERT INTO migration_sequence_state SELECT %L, %L, last_value, is_called FROM %I.%I',
  sequence_namespace.nspname,
  sequence_class.relname,
  sequence_namespace.nspname,
  sequence_class.relname
)
FROM pg_class AS sequence_class
JOIN pg_namespace AS sequence_namespace
  ON sequence_namespace.oid = sequence_class.relnamespace
JOIN pg_depend
  ON pg_depend.objid = sequence_class.oid
 AND pg_depend.deptype IN ('a', 'i')
JOIN pg_class AS table_class
  ON table_class.oid = pg_depend.refobjid
JOIN pg_namespace AS table_namespace
  ON table_namespace.oid = table_class.relnamespace
WHERE sequence_class.relkind = 'S'
  AND (
    (
      table_namespace.nspname = 'kortix'
      AND table_class.relname NOT IN (
        'channel_configs',
        'integration_credentials',
        'integrations',
        'sandbox_integrations',
        'schema_migrations'
      )
    ) OR (
      table_namespace.nspname = 'public'
      AND table_class.relname IN (
        'daily_refresh_tracking',
        'renewal_processing',
        'contact_forms',
        'webhook_config'
      )
    )
  )
ORDER BY sequence_namespace.nspname, sequence_class.relname
\gexec

SELECT schema_name, sequence_name, last_value, is_called
FROM migration_sequence_state
ORDER BY schema_name COLLATE "C", sequence_name COLLATE "C";
COMMIT;
SQL
}

reconcile_sequences() {
  sequence_state_file="$(mktemp "${TMPDIR:-/tmp}/kortix-use2-sequences.XXXXXX")"
  cleanup_sequence_state() {
    [[ -f "$sequence_state_file" ]] && unlink "$sequence_state_file"
  }
  trap cleanup_sequence_state EXIT

  write_sequence_state "$source_database_url" "$sequence_state_file"

  while IFS=$'\t' read -r schema_name sequence_name last_value is_called; do
    psql "$target_database_url" -X -q -v ON_ERROR_STOP=1 \
      -v schema_name="$schema_name" \
      -v sequence_name="$sequence_name" \
      -v last_value="$last_value" \
      -v is_called="$is_called" <<'SQL'
SELECT setval(
  format('%I.%I', :'schema_name', :'sequence_name')::regclass,
  :'last_value'::bigint,
  :'is_called'::boolean
)
\gset
SQL
  done <"$sequence_state_file"

  echo "Replicated sequence state matches the source."
}

rotate_replication_password() {
  if [[ "${ALLOW_REPLICATION_PASSWORD_ROTATION:-}" != "1" ]]; then
    echo "Set ALLOW_REPLICATION_PASSWORD_ROTATION=1 to rotate the replication credential." >&2
    exit 64
  fi

  local new_password
  local updated_target_secret_json
  local application_connection_url
  local auth_connection_url
  local subscriptions_disabled=false

  new_password="$(
    node -e 'process.stdout.write(require("node:crypto").randomBytes(48).toString("base64url"))'
  )"
  updated_target_secret_json="$(
    jq -c --arg password "$new_password" \
      '.replication_password = $password' <<<"$target_secret_json"
  )"

  printf '%s' "$updated_target_secret_json" |
    aws secretsmanager put-secret-value \
      --secret-id "$TARGET_SECRET_ID" \
      --region "$TARGET_AWS_REGION" \
      --secret-string file:///dev/stdin \
      --output json >/dev/null

  build_replication_url() {
    local subscription_name="$1"
    REPLICATION_USERNAME="$replication_username" \
      REPLICATION_PASSWORD="$new_password" \
      node -e '
        const url = new URL(process.argv[1]);
        url.username = process.env.REPLICATION_USERNAME;
        url.password = process.env.REPLICATION_PASSWORD;
        url.searchParams.set("sslmode", "require");
        url.searchParams.set("application_name", process.argv[2]);
        url.searchParams.set("options", "-c statement_timeout=0");
        process.stdout.write(url.toString());
      ' "$source_database_url" "$subscription_name"
  }

  application_connection_url="$(build_replication_url "$SUBSCRIPTION")"
  auth_connection_url="$(build_replication_url "$AUTH_SUBSCRIPTION")"

  reenable_subscriptions() {
    if [[ "$subscriptions_disabled" != "true" ]]; then
      return
    fi
    psql "$target_database_url" -X -q -v ON_ERROR_STOP=1 \
      -v application_subscription="$SUBSCRIPTION" \
      -v auth_subscription="$AUTH_SUBSCRIPTION" <<'SQL' || true
SELECT format('ALTER SUBSCRIPTION %I ENABLE', subscription_name)
FROM unnest(
  ARRAY[:'application_subscription', :'auth_subscription']
) AS subscriptions(subscription_name)
\gexec
SQL
  }
  trap reenable_subscriptions EXIT

  psql "$target_database_url" -X -q -v ON_ERROR_STOP=1 \
    -v application_subscription="$SUBSCRIPTION" \
    -v auth_subscription="$AUTH_SUBSCRIPTION" <<'SQL'
SELECT format('ALTER SUBSCRIPTION %I DISABLE', subscription_name)
FROM unnest(
  ARRAY[:'application_subscription', :'auth_subscription']
) AS subscriptions(subscription_name)
\gexec
SQL
  subscriptions_disabled=true

  {
    printf "\\set replication_password '%s'\n" "${new_password//\'/\'\'}"
    cat <<'SQL'
SELECT format(
  'ALTER ROLE kortix_use2_repl WITH LOGIN REPLICATION PASSWORD %L',
  :'replication_password'
)
\gexec
SQL
  } | psql "$source_database_url" -X -q -v ON_ERROR_STOP=1

  set_subscription_connection() {
    local subscription_name="$1"
    local connection_url="$2"
    {
      printf "\\set subscription '%s'\n" "${subscription_name//\'/\'\'}"
      printf "\\set connection_url '%s'\n" "${connection_url//\'/\'\'}"
      cat <<'SQL'
SELECT format(
  'ALTER SUBSCRIPTION %I CONNECTION %L',
  :'subscription',
  :'connection_url'
)
\gexec
SQL
    } | psql "$target_database_url" -X -q -v ON_ERROR_STOP=1
  }

  set_subscription_connection "$SUBSCRIPTION" "$application_connection_url"
  set_subscription_connection "$AUTH_SUBSCRIPTION" "$auth_connection_url"
  reenable_subscriptions
  subscriptions_disabled=false
  trap - EXIT

  for attempt in $(seq 1 60); do
    read -r active_workers apply_errors sync_errors < <(
      psql "$target_database_url" -X -qAt -F ' ' -v ON_ERROR_STOP=1 \
        -v application_subscription="$SUBSCRIPTION" \
        -v auth_subscription="$AUTH_SUBSCRIPTION" <<'SQL'
SELECT
  (
    SELECT count(*)
    FROM pg_stat_subscription
    WHERE subname IN (
      :'application_subscription',
      :'auth_subscription'
    )
      AND worker_type = 'apply'
  ),
  COALESCE(sum(apply_error_count), 0),
  COALESCE(sum(sync_error_count), 0)
FROM pg_stat_subscription_stats
WHERE subname IN (
  :'application_subscription',
  :'auth_subscription'
);
SQL
    )

    if [[ "$apply_errors" != "0" || "$sync_errors" != "0" ]]; then
      echo "Replication errors detected after rotation: apply=$apply_errors sync=$sync_errors" >&2
      exit 1
    fi
    if [[ "$active_workers" -eq 2 ]]; then
      echo "Replication credential rotated. Both subscriptions have active apply workers."
      unset new_password updated_target_secret_json application_connection_url auth_connection_url
      return
    fi
    echo "Credential rotation verification $attempt/60: active apply workers=$active_workers/2"
    sleep 2
  done

  echo "Both replication subscriptions did not reconnect within two minutes." >&2
  exit 1
}

usage() {
  cat <<'EOF'
Usage: scripts/prod-us-east-2/db-sync.sh <command>

Commands:
  prepare-source     Set WAL retention, replica identities, and publication.
  start              Create or enable the target subscription.
  status             Show subscriber state, errors, slot state, and retained WAL.
  wait-caught-up     Wait until the target apply worker reaches the current source WAL position.
  disable-subscription Disable the target subscription after every final gate passes.
  enable-subscription Re-enable the target subscription during a pre-write rollback.
  repair-public-rls  Repair public control tables skipped by RLS during initial copy.
  repair-shadow-mutations Replace target-only mutations made during shadow verification.
  backfill-target-precision Backfill target-only precision columns and keep them synchronized during replication.
  reconcile-counts   Compare exact source and target row counts.
  reconcile-key-hashes Compare primary-key and replica-identity set hashes.
  reconcile-critical-hashes Compare full-row hashes for critical relations.
  reconcile-sequences Copy source sequence state to the target.
  rotate-replication-password Rotate the shared source replication credential.
EOF
}

case "${1:-}" in
  prepare-source)
    prepare_source
    ;;
  start)
    start_subscription
    ;;
  status)
    status
    ;;
  wait-caught-up)
    wait_caught_up
    ;;
  disable-subscription)
    set_subscription_enabled false
    ;;
  enable-subscription)
    set_subscription_enabled true
    ;;
  repair-public-rls)
    repair_public_rls_tables
    ;;
  repair-shadow-mutations)
    repair_shadow_mutations
    ;;
  backfill-target-precision)
    backfill_target_precision_columns
    ;;
  reconcile-counts)
    reconcile_counts
    ;;
  reconcile-key-hashes)
    reconcile_hashes keys
    ;;
  reconcile-critical-hashes)
    reconcile_hashes critical
    ;;
  reconcile-sequences)
    reconcile_sequences
    ;;
  rotate-replication-password)
    rotate_replication_password
    ;;
  *)
    usage >&2
    exit 64
    ;;
esac
