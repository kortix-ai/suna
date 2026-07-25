#!/usr/bin/env bash
set -Eeuo pipefail

SOURCE_DATABASE_URL="${SOURCE_DATABASE_URL:?SOURCE_DATABASE_URL is required}"
TARGET_DATABASE_URL="${TARGET_DATABASE_URL:?TARGET_DATABASE_URL is required}"
PUBLICATION="${PUBLICATION:-kortix_us_west_2_20260725}"
SUBSCRIPTION="${SUBSCRIPTION:-kortix_us_west_2_20260725}"

if [[ "${ALLOW_REPLICATION_REFRESH:-}" != "1" ]]; then
  echo "Set ALLOW_REPLICATION_REFRESH=1 to refresh the US shadow publication." >&2
  exit 64
fi

for command_name in comm cut mktemp psql sort; do
  command -v "$command_name" >/dev/null 2>&1 || {
    echo "Missing required command: $command_name" >&2
    exit 1
  }
done

temporary_directory="$(mktemp -d "${TMPDIR:-/tmp}/kortix-usw2-publication.XXXXXX")"
source_manifest="$temporary_directory/source.tsv"
target_manifest="$temporary_directory/target.tsv"

# shellcheck disable=SC2329 # The EXIT trap invokes this function.
cleanup() {
  find "$temporary_directory" -type f -exec unlink {} + 2>/dev/null || true
  rmdir "$temporary_directory" 2>/dev/null || true
}
trap cleanup EXIT

write_manifest() {
  local database_url="$1"
  local output_file="$2"

  psql "$database_url" -X -qAt -F $'\t' -v ON_ERROR_STOP=1 >"$output_file" <<'SQL'
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
  format('%I.%I', selected_tables.table_schema, selected_tables.table_name),
  columns.column_name
FROM selected_tables
JOIN information_schema.columns AS columns
  USING (table_schema, table_name)
WHERE columns.is_generated = 'NEVER'
  AND NOT (
    selected_tables.table_schema = 'kortix'
    AND selected_tables.table_name = 'accounts'
    AND columns.column_name = 'personal_account'
  )
ORDER BY
  selected_tables.table_schema COLLATE "C",
  selected_tables.table_name COLLATE "C",
  columns.column_name COLLATE "C";
SQL
}

write_manifest "$SOURCE_DATABASE_URL" "$source_manifest" &
source_manifest_pid=$!
write_manifest "$TARGET_DATABASE_URL" "$target_manifest" &
target_manifest_pid=$!
wait "$source_manifest_pid"
wait "$target_manifest_pid"

missing_target_columns="$(comm -23 "$source_manifest" "$target_manifest")"
if [[ -n "$missing_target_columns" ]]; then
  echo "The target lacks selected source columns:" >&2
  printf '%s\n' "$missing_target_columns" >&2
  echo "The publication was not changed." >&2
  exit 1
fi

source_relation_count="$(cut -f1 "$source_manifest" | sort -u | wc -l | tr -d '[:space:]')"
if [[ "$source_relation_count" -eq 0 ]]; then
  echo "The selected publication relation set is empty." >&2
  exit 1
fi

unsafe_relations="$(
  psql "$SOURCE_DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 <<'SQL'
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
SELECT string_agg(
  format('%I.%I', selected_tables.table_schema, selected_tables.table_name),
  ', ' ORDER BY selected_tables.table_schema, selected_tables.table_name
)
FROM selected_tables
JOIN pg_namespace
  ON pg_namespace.nspname = selected_tables.table_schema
JOIN pg_class
  ON pg_class.relnamespace = pg_namespace.oid
 AND pg_class.relname = selected_tables.table_name
WHERE pg_class.relreplident = 'n'
   OR (
     pg_class.relreplident = 'd'
     AND NOT EXISTS (
       SELECT 1
       FROM pg_index
       WHERE pg_index.indrelid = pg_class.oid
         AND pg_index.indisprimary
         AND pg_index.indisvalid
         AND pg_index.indisready
     )
   );
SQL
)"

if [[ -n "$unsafe_relations" ]]; then
  echo "Selected relations lack a usable replica identity: $unsafe_relations" >&2
  exit 1
fi

psql "$SOURCE_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 \
  -v publication="$PUBLICATION" <<'SQL'
SELECT set_config('kortix.migration_publication', :'publication', false)
\gset

DO $do$
DECLARE
  publication_name text := current_setting('kortix.migration_publication');
  relation_list text;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_publication
    WHERE pubname = publication_name
  ) THEN
    RAISE EXCEPTION 'Publication % does not exist', publication_name;
  END IF;

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
  ),
  relation_columns AS (
    SELECT
      selected_tables.table_schema,
      selected_tables.table_name,
      string_agg(
        format('%I', columns.column_name),
        ', ' ORDER BY columns.ordinal_position
      ) FILTER (
        WHERE columns.is_generated = 'NEVER'
          AND NOT (
            selected_tables.table_schema = 'kortix'
            AND selected_tables.table_name = 'accounts'
            AND columns.column_name = 'personal_account'
          )
      ) AS column_list
    FROM selected_tables
    JOIN information_schema.columns AS columns
      USING (table_schema, table_name)
    GROUP BY selected_tables.table_schema, selected_tables.table_name
  )
  SELECT string_agg(
    format('%I.%I (%s)', table_schema, table_name, column_list),
    ', ' ORDER BY table_schema COLLATE "C", table_name COLLATE "C"
  )
  INTO relation_list
  FROM relation_columns;

  EXECUTE format(
    'ALTER PUBLICATION %I SET TABLE %s',
    publication_name,
    relation_list
  );
END
$do$;
SQL

psql "$TARGET_DATABASE_URL" -X -q -v ON_ERROR_STOP=1 \
  -v subscription="$SUBSCRIPTION" <<'SQL'
SELECT set_config('kortix.migration_subscription', :'subscription', false)
\gset

SELECT format(
  'ALTER SUBSCRIPTION %I REFRESH PUBLICATION WITH (copy_data = true)',
  :'subscription'
)
WHERE EXISTS (
  SELECT 1
  FROM pg_subscription
  WHERE subname = :'subscription'
    AND subenabled
)
\gexec

DO $do$
DECLARE
  subscription_name text := current_setting('kortix.migration_subscription');
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_subscription
    WHERE subname = subscription_name
      AND subenabled
  ) THEN
    RAISE EXCEPTION 'Subscription % is missing or disabled', subscription_name;
  END IF;
END
$do$;
SQL

for attempt in $(seq 1 240); do
  read -r ready_relations total_relations apply_errors sync_errors apply_workers < <(
    psql "$TARGET_DATABASE_URL" -X -qAt -F ' ' -v ON_ERROR_STOP=1 \
      -v subscription="$SUBSCRIPTION" <<'SQL'
SELECT
  count(*) FILTER (WHERE pg_subscription_rel.srsubstate = 'r'),
  count(*),
  COALESCE(pg_stat_subscription_stats.apply_error_count, 0),
  COALESCE(pg_stat_subscription_stats.sync_error_count, 0),
  (
    SELECT count(*)
    FROM pg_stat_subscription
    WHERE pg_stat_subscription.subid = pg_subscription.oid
      AND pg_stat_subscription.worker_type = 'apply'
  )
FROM pg_subscription
JOIN pg_subscription_rel
  ON pg_subscription_rel.srsubid = pg_subscription.oid
LEFT JOIN pg_stat_subscription_stats
  ON pg_stat_subscription_stats.subid = pg_subscription.oid
WHERE pg_subscription.subname = :'subscription'
GROUP BY
  pg_subscription.oid,
  pg_stat_subscription_stats.apply_error_count,
  pg_stat_subscription_stats.sync_error_count;
SQL
  )

  if [[ "$apply_errors" != "0" || "$sync_errors" != "0" ]]; then
    echo "Replication errors detected: apply=$apply_errors sync=$sync_errors" >&2
    exit 1
  fi

  if [[ "$ready_relations" == "$total_relations" \
    && "$total_relations" == "$source_relation_count" \
    && "$apply_workers" -ge 1 ]]; then
    echo "US shadow replication is ready: $ready_relations/$total_relations relations."
    exit 0
  fi

  echo "Replication refresh $attempt/240: ready=$ready_relations/$total_relations apply_workers=$apply_workers"
  sleep 5
done

echo "US shadow replication did not become ready within 20 minutes." >&2
exit 1
