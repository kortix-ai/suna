#!/usr/bin/env bash
set -uo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "${SCRIPT_DIR}/../scripts/env.sh"
source "${SCRIPT_DIR}/../scripts/junit.sh"

# Example migration test: after migrate-up.sh has run, the schema must be
# non-empty and the key tables the application depends on must exist.
#
# To add a check: append a table name to KEY_TABLES, or add a junit_case block
# using psql_query "<SQL returning 1 on success>".

junit_init "migration.schema"

# 1. Schema is non-empty: there is at least one table in the kortix schema.
table_count="$(psql_query "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'kortix'")"
if [ "${table_count:-0}" -gt 0 ]; then
  junit_case "kortix schema is non-empty (${table_count} tables)" pass
else
  junit_case "kortix schema is non-empty" fail "expected >0 tables, got ${table_count:-0}"
fi

# 2. Key tables exist. Adjust this list as the schema evolves.
KEY_TABLES=(
  "kortix.accounts"
  "kortix.account_members"
  "kortix.api_keys"
  "kortix.deployments"
  "kortix.sandboxes"
  "kortix.credit_ledger"
)
for fq in "${KEY_TABLES[@]}"; do
  schema="${fq%%.*}"
  table="${fq##*.}"
  exists="$(psql_query "SELECT 1 FROM information_schema.tables WHERE table_schema = '${schema}' AND table_name = '${table}'")"
  if [ "${exists}" = "1" ]; then
    junit_case "table ${fq} exists" pass
  else
    junit_case "table ${fq} exists" fail "missing table ${fq}"
  fi
done

# 3. Enums from the bootstrap migration are present.
enum_count="$(psql_query "SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace WHERE n.nspname = 'kortix' AND t.typtype = 'e'")"
if [ "${enum_count:-0}" -gt 0 ]; then
  junit_case "kortix enum types exist (${enum_count})" pass
else
  junit_case "kortix enum types exist" fail "expected >0 enum types, got ${enum_count:-0}"
fi

# 4. Supabase grant roles can see kortix tables (table_grants migration applied).
grant_ok="$(psql_query "SELECT 1 FROM information_schema.role_table_grants WHERE table_schema = 'kortix' AND grantee = 'service_role' LIMIT 1")"
if [ "${grant_ok}" = "1" ]; then
  junit_case "service_role has grants on kortix tables" pass
else
  junit_case "service_role has grants on kortix tables" fail "no grants found for service_role"
fi

junit_write "${RESULTS_DIR}/schema.xml"
junit_exit_code
