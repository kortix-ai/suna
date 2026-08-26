-- Composio is a first-class connector provider. Fresh databases get this
-- value from packages/db/src/schema/kortix.ts. Existing and faked-baseline
-- databases need this forward-only expansion before connector sync can write
-- provider_type='composio'. Application writes happen in later transactions.
--
-- enum-value-checked: `composio` does not exist in the 2026-08-06 connector
-- physical-cutover migration or in any earlier connector-provider migration.
-- Every existing environment is therefore missing the value until this
-- post-baseline migration runs. ADD VALUE IF NOT EXISTS also keeps the fresh
-- schema path idempotent.
set statement_timeout = '5s';
set lock_timeout = '1s';
ALTER TYPE kortix.connector_provider ADD VALUE IF NOT EXISTS 'composio' AFTER 'pipedream';

-- PostgreSQL enum values are intentionally forward-only. Removing `composio`
-- would invalidate persisted connector rows and break mixed-version rollback.
