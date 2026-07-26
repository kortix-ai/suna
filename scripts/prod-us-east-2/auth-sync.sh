#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_SECRET_ID="${SOURCE_SECRET_ID:-kortix-prod-env}"
SOURCE_AWS_REGION="${SOURCE_AWS_REGION:-eu-west-2}"
TARGET_SECRET_ID="${TARGET_SECRET_ID:-kortix/prod-us-east-2-migration}"
TARGET_AWS_REGION="${TARGET_AWS_REGION:-us-east-2}"
PUBLICATION="${AUTH_PUBLICATION:-kortix_use2_auth_20260725}"
SUBSCRIPTION="${AUTH_SUBSCRIPTION:-kortix_use2_auth_20260725}"

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
target_database_url="$(jq -er '.target_database_url' <<<"$target_secret_json")"
replication_username="$(jq -er '.replication_username' <<<"$target_secret_json")"
replication_password="$(jq -er '.replication_password' <<<"$target_secret_json")"

prepare_source() {
  psql "$source_database_url" -X -v ON_ERROR_STOP=1 -v publication="$PUBLICATION" <<'SQL'
GRANT pg_read_all_data TO kortix_use2_repl;
ALTER ROLE kortix_use2_repl BYPASSRLS;

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

SELECT set_config('kortix.auth_migration_publication', :'publication', false);

DO $do$
DECLARE
  publication_name text := current_setting('kortix.auth_migration_publication');
  relation record;
BEGIN
  FOR relation IN
    SELECT
      table_name,
      string_agg(
        format('%I', column_name),
        ', ' ORDER BY ordinal_position
      ) AS column_list
    FROM information_schema.columns
    WHERE table_schema = 'auth'
      AND table_name <> 'schema_migrations'
      AND is_generated = 'NEVER'
    GROUP BY table_name
    ORDER BY table_name
  LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM pg_publication_rel
      JOIN pg_publication
        ON pg_publication.oid = pg_publication_rel.prpubid
      WHERE pg_publication.pubname = publication_name
        AND pg_publication_rel.prrelid = format(
          'auth.%I',
          relation.table_name
        )::regclass
    ) THEN
      EXECUTE format(
        'ALTER PUBLICATION %I ADD TABLE auth.%I (%s)',
        publication_name,
        relation.table_name,
        relation.column_list
      );
    END IF;
  END LOOP;
END
$do$;

SELECT pg_publication.pubname, count(*) AS published_tables
FROM pg_publication
JOIN pg_publication_rel
  ON pg_publication_rel.prpubid = pg_publication.oid
WHERE pg_publication.pubname = :'publication'
GROUP BY pg_publication.pubname;
SQL
}

reset_target() {
  if [[ "${ALLOW_TARGET_AUTH_RESET:-}" != "1" ]]; then
    echo "Set ALLOW_TARGET_AUTH_RESET=1 to reset replicated Auth data on the US target." >&2
    exit 64
  fi

  psql "$target_database_url" -X -v ON_ERROR_STOP=1 \
    -v subscription="$SUBSCRIPTION" <<'SQL'
SELECT format('DROP SUBSCRIPTION %I', :'subscription')
WHERE EXISTS (
  SELECT 1
  FROM pg_subscription
  WHERE subname = :'subscription'
)
\gexec

DO $do$
DECLARE
  relation_list text;
BEGIN
  SELECT string_agg(
    format('%I.%I', table_schema, table_name),
    ', ' ORDER BY table_name
  )
  INTO relation_list
  FROM information_schema.tables
  WHERE table_schema = 'auth'
    AND table_type = 'BASE TABLE'
    AND table_name <> 'schema_migrations';

  IF relation_list IS NULL THEN
    RAISE EXCEPTION 'No Auth tables found on the target';
  END IF;

  EXECUTE format('TRUNCATE TABLE %s CASCADE', relation_list);
END
$do$;
SQL

  echo "Reset replicated Auth data on the US target."
}

start_subscription() {
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
SELECT format('ALTER SUBSCRIPTION %I SET (run_as_owner = true)', :'subscription')
\gexec
SELECT format('ALTER SUBSCRIPTION %I ENABLE', :'subscription')
\gexec
SQL
    return
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
  escaped_replication_url="${source_replication_url//\'/\'\'}"
  {
    printf "\\set source_replication_url '%s'\n" "$escaped_replication_url"
    printf "\\set publication '%s'\n" "$PUBLICATION"
    printf "\\set subscription '%s'\n" "$SUBSCRIPTION"
    cat <<'SQL'
SELECT format(
  'CREATE SUBSCRIPTION %I CONNECTION %L PUBLICATION %I WITH (copy_data = true, create_slot = true, enabled = true, binary = false, streaming = %L, two_phase = false, disable_on_error = true, origin = %L, run_as_owner = true)',
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

SELECT pg_subscription_rel.srsubstate, count(*)
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

SELECT 'users', count(*) FROM auth.users
UNION ALL
SELECT 'identities', count(*) FROM auth.identities
UNION ALL
SELECT 'mfa_factors', count(*) FROM auth.mfa_factors
UNION ALL
SELECT 'refresh_tokens', count(*) FROM auth.refresh_tokens;
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
SQL
}

write_counts() {
  local database_url="$1"
  local output_file="$2"

  psql "$database_url" -X -qAt -F $'\t' -v ON_ERROR_STOP=1 >"$output_file" <<'SQL'
BEGIN;
CREATE TEMP TABLE auth_migration_counts (
  table_name text NOT NULL,
  row_count bigint NOT NULL
) ON COMMIT DROP;

DO $do$
DECLARE
  relation record;
BEGIN
  FOR relation IN
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'auth'
      AND table_name <> 'schema_migrations'
    ORDER BY table_name
  LOOP
    EXECUTE format(
      'INSERT INTO auth_migration_counts SELECT %L, count(*) FROM auth.%I',
      relation.table_name,
      relation.table_name
    );
  END LOOP;
END
$do$;

SELECT table_name, row_count
FROM auth_migration_counts
ORDER BY table_name COLLATE "C";
COMMIT;
SQL
}

reconcile_counts() {
  temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/kortix-use2-auth-counts.XXXXXX")"
  source_counts="$temporary_directory/source.tsv"
  target_counts="$temporary_directory/target.tsv"
  cleanup_counts() {
    [[ -f "$source_counts" ]] && unlink "$source_counts"
    [[ -f "$target_counts" ]] && unlink "$target_counts"
    [[ -d "$temporary_directory" ]] && rmdir "$temporary_directory"
  }
  trap cleanup_counts EXIT

  write_counts "$source_database_url" "$source_counts" &
  source_count_pid=$!
  write_counts "$target_database_url" "$target_counts" &
  target_count_pid=$!
  wait "$source_count_pid"
  wait "$target_count_pid"

  if diff -u "$source_counts" "$target_counts"; then
    echo "All replicated Auth table row counts match."
  else
    echo "Replicated Auth table row counts differ." >&2
    exit 1
  fi
}

write_key_hashes() {
  local database_url="$1"
  local output_file="$2"

  psql "$database_url" -X -qAt -F $'\t' -v ON_ERROR_STOP=1 >"$output_file" <<'SQL'
BEGIN;
SET LOCAL TIME ZONE 'UTC';
CREATE TEMP TABLE auth_migration_key_hashes (
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
      information_schema.tables.table_name,
      string_agg(
        format('%I', key_attribute.attname),
        ', ' ORDER BY key_column.ordinality
      ) AS key_columns
    FROM information_schema.tables
    JOIN pg_namespace
      ON pg_namespace.nspname = information_schema.tables.table_schema
    JOIN pg_class
      ON pg_class.relnamespace = pg_namespace.oid
     AND pg_class.relname = information_schema.tables.table_name
    JOIN pg_index
      ON pg_index.indrelid = pg_class.oid
     AND pg_index.indisprimary
     AND pg_index.indisvalid
     AND pg_index.indisready
    JOIN LATERAL unnest(pg_index.indkey)
      WITH ORDINALITY AS key_column(attnum, ordinality)
      ON key_column.ordinality <= pg_index.indnkeyatts
    JOIN pg_attribute AS key_attribute
      ON key_attribute.attrelid = pg_class.oid
     AND key_attribute.attnum = key_column.attnum
    WHERE information_schema.tables.table_schema = 'auth'
      AND information_schema.tables.table_type = 'BASE TABLE'
      AND information_schema.tables.table_name <> 'schema_migrations'
    GROUP BY information_schema.tables.table_name
    ORDER BY information_schema.tables.table_name COLLATE "C"
  LOOP
    EXECUTE format(
      $query$
      INSERT INTO auth_migration_key_hashes
      SELECT
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
        FROM auth.%I
      ) AS relation_keys
      $query$,
      relation.table_name,
      relation.key_columns,
      relation.table_name
    );
  END LOOP;
END
$do$;

SELECT table_name, row_count, hash_a, hash_b
FROM auth_migration_key_hashes
ORDER BY table_name COLLATE "C";
COMMIT;
SQL
}

write_critical_hashes() {
  local database_url="$1"
  local output_file="$2"

  psql "$database_url" -X -qAt -F $'\t' -v ON_ERROR_STOP=1 >"$output_file" <<'SQL'
BEGIN;
SET LOCAL TIME ZONE 'UTC';
CREATE TEMP TABLE auth_migration_critical_hashes (
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
      information_schema.columns.table_name,
      string_agg(
        format('%I', information_schema.columns.column_name),
        ', ' ORDER BY information_schema.columns.column_name COLLATE "C"
      ) AS row_columns
    FROM information_schema.columns
    WHERE information_schema.columns.table_schema = 'auth'
      AND information_schema.columns.is_generated = 'NEVER'
      AND information_schema.columns.table_name IN (
        'identities',
        'mfa_factors',
        'one_time_tokens',
        'sessions',
        'sso_domains',
        'sso_providers',
        'users'
      )
    GROUP BY information_schema.columns.table_name
    ORDER BY information_schema.columns.table_name COLLATE "C"
  LOOP
    EXECUTE format(
      $query$
      INSERT INTO auth_migration_critical_hashes
      SELECT
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
        FROM auth.%I
      ) AS relation_rows
      $query$,
      relation.table_name,
      relation.row_columns,
      relation.table_name
    );
  END LOOP;
END
$do$;

SELECT table_name, row_count, hash_a, hash_b
FROM auth_migration_critical_hashes
ORDER BY table_name COLLATE "C";
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
      label="primary-key"
      ;;
    critical)
      writer=write_critical_hashes
      label="critical row"
      ;;
    *)
      echo "Unknown Auth hash reconciliation mode: $mode" >&2
      exit 64
      ;;
  esac

  temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/kortix-use2-auth-hashes.XXXXXX")"
  source_hashes="$temporary_directory/source.tsv"
  target_hashes="$temporary_directory/target.tsv"
  cleanup_hashes() {
    [[ -f "$source_hashes" ]] && unlink "$source_hashes"
    [[ -f "$target_hashes" ]] && unlink "$target_hashes"
    [[ -d "$temporary_directory" ]] && rmdir "$temporary_directory"
  }
  trap cleanup_hashes EXIT

  "$writer" "$source_database_url" "$source_hashes" &
  source_hash_pid=$!
  "$writer" "$target_database_url" "$target_hashes" &
  target_hash_pid=$!
  wait "$source_hash_pid"
  wait "$target_hash_pid"

  if diff -u "$source_hashes" "$target_hashes"; then
    echo "All replicated Auth $label hashes match."
  else
    echo "Replicated Auth $label hashes differ." >&2
    exit 1
  fi
}

write_sequence_state() {
  local database_url="$1"
  local output_file="$2"

  psql "$database_url" -X -qAt -F $'\t' -v ON_ERROR_STOP=1 >"$output_file" <<'SQL'
BEGIN;
CREATE TEMP TABLE auth_migration_sequence_state (
  schema_name text NOT NULL,
  sequence_name text NOT NULL,
  last_value bigint NOT NULL,
  is_called boolean NOT NULL
) ON COMMIT DROP;

SELECT format(
  'INSERT INTO auth_migration_sequence_state SELECT %L, %L, last_value, is_called FROM %I.%I',
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
  AND table_namespace.nspname = 'auth'
  AND table_class.relname <> 'schema_migrations'
ORDER BY sequence_namespace.nspname, sequence_class.relname
\gexec

SELECT schema_name, sequence_name, last_value, is_called
FROM auth_migration_sequence_state
ORDER BY schema_name COLLATE "C", sequence_name COLLATE "C";
COMMIT;
SQL
}

reconcile_sequences() {
  sequence_state_file="$(mktemp "${TMPDIR:-/tmp}/kortix-use2-auth-sequences.XXXXXX")"
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

  echo "Auth sequence state matches the source."
}

repair_shadow_mutations() {
  if [[ "${ALLOW_TARGET_AUTH_SHADOW_REPAIR:-}" != "1" ]]; then
    echo "Set ALLOW_TARGET_AUTH_SHADOW_REPAIR=1 to remove target-only Auth test state." >&2
    exit 64
  fi

  local temporary_directory
  local source_flow_state_ids
  temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/kortix-use2-auth-shadow-repair.XXXXXX")"
  source_flow_state_ids="$temporary_directory/source-flow-state-ids.csv"

  cleanup_auth_shadow_repair() {
    [[ -f "$source_flow_state_ids" ]] && unlink "$source_flow_state_ids"
    [[ -d "$temporary_directory" ]] && rmdir "$temporary_directory"
  }
  trap cleanup_auth_shadow_repair EXIT

  psql "$source_database_url" -X -q -v ON_ERROR_STOP=1 \
    -c "\\copy (SELECT id FROM auth.flow_state ORDER BY id) TO '$source_flow_state_ids' WITH (FORMAT csv)"

  {
    cat <<'SQL'
BEGIN;
CREATE TEMP TABLE source_flow_state_ids (
  id uuid PRIMARY KEY
) ON COMMIT DROP;
SQL
    printf "\\copy source_flow_state_ids FROM '%s' WITH (FORMAT csv)\n" "$source_flow_state_ids"
    cat <<'SQL'
DELETE FROM auth.flow_state AS target
WHERE target.created_at < now() - interval '15 minutes'
  AND NOT EXISTS (
    SELECT 1
    FROM source_flow_state_ids AS source
    WHERE source.id = target.id
  );
COMMIT;
SQL
  } | psql "$target_database_url" -X -v ON_ERROR_STOP=1

  trap - EXIT
  cleanup_auth_shadow_repair
  echo "Removed target-only Auth flow state older than 15 minutes."
}

case "${1:-}" in
  prepare-source)
    prepare_source
    ;;
  reset-target)
    reset_target
    ;;
  start)
    start_subscription
    ;;
  status)
    status
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
  repair-shadow-mutations)
    repair_shadow_mutations
    ;;
  *)
    echo "Usage: scripts/prod-us-east-2/auth-sync.sh {prepare-source|reset-target|start|status|reconcile-counts|reconcile-key-hashes|reconcile-critical-hashes|reconcile-sequences|repair-shadow-mutations}" >&2
    exit 64
    ;;
esac
