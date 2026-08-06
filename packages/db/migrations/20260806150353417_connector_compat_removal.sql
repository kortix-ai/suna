-- Migration: connector_compat_removal
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- mixed-version-safe: PR #6173 deployed canonical table and connection_id readers and writers before this contract migration; no running supported API build depends on these temporary views or profile_id mirror.

DROP VIEW kortix.executor_connection_policies;
DROP VIEW kortix.executor_oauth_sessions;
DROP VIEW kortix.executor_oauth_applications;
DROP VIEW kortix.executor_executions;
DROP VIEW kortix.executor_credentials;
DROP VIEW kortix.executor_connection_profiles;
DROP VIEW kortix.executor_attachments;
DROP VIEW kortix.executor_project_settings;
DROP VIEW kortix.executor_project_policies;
DROP VIEW kortix.executor_connector_policies;
DROP VIEW kortix.executor_connector_grants;
DROP VIEW kortix.executor_connector_actions;
DROP VIEW kortix.executor_connectors;

DROP TRIGGER sync_session_connector_binding_connection_ids
ON kortix.project_session_connector_bindings;
DROP FUNCTION kortix.sync_session_connector_binding_connection_ids();

-- Phase 1 backfilled connection_id and installed this validated check. PostgreSQL
-- can use it to set the physical NOT NULL flag without scanning the table.
ALTER TABLE kortix.project_session_connector_bindings
  VALIDATE CONSTRAINT project_session_connector_bindings_connection_not_null;
ALTER TABLE kortix.project_session_connector_bindings
  ALTER COLUMN connection_id SET NOT NULL;
ALTER TABLE kortix.project_session_connector_bindings
  DROP CONSTRAINT project_session_connector_bindings_profile_tenant_fk;
-- squawk-ignore ban-drop-column
ALTER TABLE kortix.project_session_connector_bindings DROP COLUMN profile_id;
ALTER TABLE kortix.project_session_connector_bindings
  DROP CONSTRAINT project_session_connector_bindings_connection_not_null;

-- PostgreSQL cannot remove one enum label in place. Canonicalize every stored
-- row before replacing the type with the exact active contract.
UPDATE kortix.project_secrets
SET consumer = 'connector'
WHERE consumer = 'executor';

ALTER TABLE kortix.project_secrets
  DROP CONSTRAINT project_secrets_egress_policy_required;
ALTER TABLE kortix.project_secrets
  ALTER COLUMN consumer DROP DEFAULT,
  -- squawk-ignore changing-column-type
  ALTER COLUMN consumer TYPE text USING consumer::text;
DROP TYPE kortix.project_secret_consumer;
CREATE TYPE kortix.project_secret_consumer AS ENUM (
  'sandbox',
  'llm_gateway',
  'connector',
  'git_proxy',
  'http_broker',
  'network'
);
ALTER TABLE kortix.project_secrets
  -- squawk-ignore changing-column-type
  ALTER COLUMN consumer TYPE kortix.project_secret_consumer
    USING consumer::kortix.project_secret_consumer,
  ALTER COLUMN consumer SET DEFAULT 'sandbox'::kortix.project_secret_consumer;
ALTER TABLE kortix.project_secrets
  ADD CONSTRAINT project_secrets_egress_policy_required
  CHECK (
    strategy IN ('runtime', 'denied')
    OR (
      strategy = 'broker'
      AND consumer IN ('llm_gateway', 'connector', 'git_proxy')
    )
    OR egress_policy IS NOT NULL
  ) NOT VALID;
