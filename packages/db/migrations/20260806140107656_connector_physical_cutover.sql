-- Migration: connector_physical_cutover
--
-- mixed-version-safe: The preceding release removed connector ON CONFLICT writes. Writable executor compatibility views keep old API pods operational until the contract migration.
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Runtime queries use enum values, not enum type names.
ALTER TYPE kortix.executor_connector_authorization_strategy RENAME TO connector_authorization_strategy;
ALTER TYPE kortix.executor_execution_status RENAME TO connector_call_status;
ALTER TYPE kortix.executor_connection_profile_owner_type RENAME TO connector_connection_owner_type;
ALTER TYPE kortix.executor_connection_profile_status RENAME TO connector_connection_status;
ALTER TYPE kortix.executor_credential_mode RENAME TO connector_credential_mode;
ALTER TYPE kortix.executor_default_mode RENAME TO connector_default_mode;
ALTER TYPE kortix.executor_policy_action RENAME TO connector_policy_action;
ALTER TYPE kortix.executor_connector_provider RENAME TO connector_provider;
ALTER TYPE kortix.executor_risk RENAME TO connector_risk;
ALTER TYPE kortix.executor_connector_status RENAME TO connector_status;

-- These metadata-only renames preserve all rows, privileges, and dependencies.
-- squawk-ignore renaming-table
ALTER TABLE kortix.executor_credentials RENAME TO connection_credentials;
-- squawk-ignore renaming-table
ALTER TABLE kortix.executor_oauth_applications RENAME TO connection_oauth_applications;
-- squawk-ignore renaming-table
ALTER TABLE kortix.executor_oauth_sessions RENAME TO connection_oauth_sessions;
-- squawk-ignore renaming-table
ALTER TABLE kortix.executor_connection_policies RENAME TO connection_policies;
-- squawk-ignore renaming-table
ALTER TABLE kortix.executor_connector_actions RENAME TO connector_actions;
-- squawk-ignore renaming-table
ALTER TABLE kortix.executor_attachments RENAME TO connector_attachments;
-- squawk-ignore renaming-table
ALTER TABLE kortix.executor_executions RENAME TO connector_calls;
-- squawk-ignore renaming-table
ALTER TABLE kortix.executor_connection_profiles RENAME TO connector_connections;
-- squawk-ignore renaming-table
ALTER TABLE kortix.executor_connector_grants RENAME TO connector_grants;
-- squawk-ignore renaming-table
ALTER TABLE kortix.executor_connector_policies RENAME TO connector_policies;
-- squawk-ignore renaming-table
ALTER TABLE kortix.executor_project_policies RENAME TO connector_project_policies;
-- squawk-ignore renaming-table
ALTER TABLE kortix.executor_project_settings RENAME TO connector_project_settings;
-- squawk-ignore renaming-table
ALTER TABLE kortix.executor_connectors RENAME TO connectors;

-- squawk-ignore renaming-column
ALTER TABLE kortix.connection_policies RENAME COLUMN profile_id TO connection_id;
-- squawk-ignore renaming-column
ALTER TABLE kortix.connector_connections RENAME COLUMN profile_id TO connection_id;
-- squawk-ignore renaming-column
ALTER TABLE kortix.connection_credentials RENAME COLUMN profile_id TO connection_id;
-- squawk-ignore renaming-column
ALTER TABLE kortix.connector_calls RENAME COLUMN profile_id TO connection_id;
-- squawk-ignore renaming-column
ALTER TABLE kortix.connection_oauth_applications RENAME COLUMN profile_id TO connection_id;
-- squawk-ignore renaming-column
ALTER TABLE kortix.connection_oauth_sessions RENAME COLUMN profile_id TO connection_id;

-- Rename every live constraint by meaning. This covers both baseline-generated
-- short names and later Drizzle-generated long names.
DO $migration$
DECLARE
  item record;
  new_name text;
BEGIN
  FOR item IN
    SELECT r.relname AS table_name, c.conname AS old_name
    FROM pg_constraint c
    JOIN pg_class r ON r.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    WHERE n.nspname = 'kortix'
      AND (c.conname LIKE '%executor%' OR c.conname LIKE '%profile%')
      AND NOT (
        r.relname = 'project_session_connector_bindings'
        AND c.conname = 'project_session_connector_bindings_profile_tenant_fk'
      )
    ORDER BY r.relname, c.conname
  LOOP
    new_name := item.old_name;
    new_name := replace(new_name, 'executor_connection_profiles', 'connector_connections');
    new_name := replace(new_name, 'executor_connection_policies', 'connection_policies');
    new_name := replace(new_name, 'executor_oauth_applications', 'connection_oauth_applications');
    new_name := replace(new_name, 'executor_oauth_sessions', 'connection_oauth_sessions');
    new_name := replace(new_name, 'executor_connector_actions', 'connector_actions');
    new_name := replace(new_name, 'executor_connector_grants', 'connector_grants');
    new_name := replace(new_name, 'executor_connector_policies', 'connector_policies');
    new_name := replace(new_name, 'executor_project_policies', 'connector_project_policies');
    new_name := replace(new_name, 'executor_project_settings', 'connector_project_settings');
    new_name := replace(new_name, 'executor_attachments', 'connector_attachments');
    new_name := replace(new_name, 'executor_credentials', 'connection_credentials');
    new_name := replace(new_name, 'executor_executions', 'connector_calls');
    new_name := replace(new_name, 'executor_connectors', 'connectors');
    new_name := replace(new_name, 'profile', 'connection');

    IF new_name = item.old_name THEN
      RAISE EXCEPTION 'No canonical constraint mapping for kortix.%.%', item.table_name, item.old_name;
    END IF;

    IF EXISTS (
      SELECT 1 FROM pg_constraint c
      JOIN pg_class r ON r.oid = c.conrelid
      JOIN pg_namespace n ON n.oid = r.relnamespace
      WHERE n.nspname = 'kortix' AND r.relname = item.table_name AND c.conname = new_name
    ) THEN
      RAISE EXCEPTION 'Canonical constraint already exists on kortix.%: %', item.table_name, new_name;
    END IF;

    EXECUTE format('ALTER TABLE %I.%I RENAME CONSTRAINT %I TO %I', 'kortix', item.table_name, item.old_name, new_name);
  END LOOP;
END
$migration$;

-- Rename indexes in place. This preserves index OIDs and avoids table scans.
DO $migration$
DECLARE
  item record;
  old_oid regclass;
  new_oid regclass;
BEGIN
  FOR item IN
    SELECT * FROM (VALUES
      ('idx_executor_attachments_scope', 'idx_connector_attachments_scope'),
      ('idx_executor_attachments_expiry', 'idx_connector_attachments_expiry'),
      ('idx_executor_connection_policies_profile', 'idx_connection_policies_connection'),
      ('idx_executor_connection_profiles_tenant_identity', 'idx_connector_connections_tenant_identity'),
      ('idx_executor_connection_profiles_connector_identity', 'idx_connector_connections_connector_identity'),
      ('idx_executor_connection_profiles_default_project', 'idx_connector_connections_default_project'),
      ('idx_executor_connection_profiles_default_owner', 'idx_connector_connections_default_owner'),
      ('idx_executor_connection_profiles_owner_label', 'idx_connector_connections_owner_label'),
      ('idx_executor_connection_profiles_project_label', 'idx_connector_connections_project_label'),
      ('idx_executor_connection_profiles_project', 'idx_connector_connections_project'),
      ('idx_executor_connection_profiles_connector', 'idx_connector_connections_connector'),
      ('idx_executor_connector_actions_connector', 'idx_connector_actions_connector'),
      ('idx_executor_connector_actions_path', 'idx_connector_actions_path'),
      ('idx_executor_connector_grants_connector', 'idx_connector_grants_connector'),
      ('idx_executor_connector_grants_unique', 'idx_connector_grants_unique'),
      ('idx_executor_connector_policies_connector', 'idx_connector_policies_connector'),
      ('idx_executor_connectors_project', 'idx_connectors_project'),
      ('idx_executor_connectors_account', 'idx_connectors_account'),
      ('idx_executor_connectors_project_slug', 'idx_connectors_project_slug'),
      ('idx_executor_connectors_tenant_identity', 'idx_connectors_tenant_identity'),
      ('idx_executor_connectors_tenant_alias', 'idx_connectors_tenant_alias'),
      ('idx_executor_credentials_connector', 'idx_connection_credentials_connector'),
      ('idx_executor_credentials_profile', 'idx_connection_credentials_connection'),
      ('idx_executor_credentials_profile_unique', 'idx_connection_credentials_connection_unique'),
      ('idx_executor_credentials_legacy_connector_unique', 'idx_connection_credentials_legacy_connector_unique'),
      ('idx_executor_executions_project', 'idx_connector_calls_project'),
      ('idx_executor_executions_project_session_created', 'idx_connector_calls_project_session_created'),
      ('idx_executor_executions_connector', 'idx_connector_calls_connector'),
      ('idx_executor_executions_profile', 'idx_connector_calls_connection'),
      ('idx_executor_executions_status', 'idx_connector_calls_status'),
      ('idx_executor_oauth_applications_profile', 'idx_connection_oauth_applications_connection'),
      ('idx_executor_oauth_applications_project', 'idx_connection_oauth_applications_project'),
      ('idx_executor_oauth_sessions_state_hash', 'idx_connection_oauth_sessions_state_hash'),
      ('idx_executor_oauth_sessions_profile', 'idx_connection_oauth_sessions_connection'),
      ('idx_executor_oauth_sessions_expires', 'idx_connection_oauth_sessions_expires'),
      ('idx_executor_project_policies_project', 'idx_connector_project_policies_project')
    ) AS mappings(old_name, new_name)
  LOOP
    old_oid := to_regclass(format('%I.%I', 'kortix', item.old_name));
    new_oid := to_regclass(format('%I.%I', 'kortix', item.new_name));

    IF old_oid IS NOT NULL AND new_oid IS NOT NULL THEN
      RAISE EXCEPTION 'Both index identifiers exist: kortix.% and kortix.%', item.old_name, item.new_name;
    ELSIF old_oid IS NOT NULL THEN
      EXECUTE format('ALTER INDEX %I.%I RENAME TO %I', 'kortix', item.old_name, item.new_name);
    ELSIF new_oid IS NULL THEN
      RAISE EXCEPTION 'Missing index: expected kortix.% or kortix.%', item.old_name, item.new_name;
    END IF;
  END LOOP;
END
$migration$;

-- Expand session bindings with a canonical column before removing the mirror.
ALTER TABLE kortix.project_session_connector_bindings ADD COLUMN connection_id uuid;

UPDATE kortix.project_session_connector_bindings
SET connection_id = profile_id
WHERE connection_id IS NULL;

CREATE FUNCTION kortix.sync_session_connector_binding_connection_ids()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.connection_id IS NULL AND NEW.profile_id IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23502', MESSAGE = 'A connector connection identifier is required';
    ELSIF NEW.connection_id IS NULL THEN
      NEW.connection_id := NEW.profile_id;
    ELSIF NEW.profile_id IS NULL THEN
      NEW.profile_id := NEW.connection_id;
    ELSIF NEW.connection_id IS DISTINCT FROM NEW.profile_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Connector connection identifiers disagree';
    END IF;
  ELSE
    IF NEW.connection_id IS DISTINCT FROM OLD.connection_id
      AND NEW.profile_id IS DISTINCT FROM OLD.profile_id
      AND NEW.connection_id IS DISTINCT FROM NEW.profile_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Connector connection identifiers disagree';
    ELSIF NEW.connection_id IS DISTINCT FROM OLD.connection_id THEN
      NEW.profile_id := NEW.connection_id;
    ELSIF NEW.profile_id IS DISTINCT FROM OLD.profile_id THEN
      NEW.connection_id := NEW.profile_id;
    ELSIF NEW.connection_id IS DISTINCT FROM NEW.profile_id THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Connector connection identifiers disagree';
    END IF;
  END IF;

  RETURN NEW;
END
$function$;

CREATE TRIGGER sync_session_connector_binding_connection_ids
BEFORE INSERT OR UPDATE OF connection_id, profile_id
ON kortix.project_session_connector_bindings
FOR EACH ROW
EXECUTE FUNCTION kortix.sync_session_connector_binding_connection_ids();

ALTER TABLE kortix.project_session_connector_bindings
  ADD CONSTRAINT project_session_connector_bindings_connection_not_null
  CHECK (connection_id IS NOT NULL)
  NOT VALID;

ALTER TABLE kortix.project_session_connector_bindings
  ALTER COLUMN profile_id SET DEFAULT NULL;

ALTER TABLE kortix.project_session_connector_bindings
  ADD CONSTRAINT project_session_connector_bindings_connection_tenant_fk
  FOREIGN KEY (account_id, project_id, connector_id, connection_id)
  REFERENCES kortix.connector_connections (account_id, project_id, connector_id, connection_id)
  ON DELETE RESTRICT
  NOT VALID;

-- Old API pods use these automatically-updatable views during the rollout.
CREATE VIEW kortix.executor_connectors AS SELECT * FROM kortix.connectors;
CREATE VIEW kortix.executor_connector_actions AS SELECT * FROM kortix.connector_actions;
CREATE VIEW kortix.executor_connector_grants AS SELECT * FROM kortix.connector_grants;
CREATE VIEW kortix.executor_connector_policies AS SELECT * FROM kortix.connector_policies;
CREATE VIEW kortix.executor_project_policies AS SELECT * FROM kortix.connector_project_policies;
CREATE VIEW kortix.executor_project_settings AS SELECT * FROM kortix.connector_project_settings;
CREATE VIEW kortix.executor_attachments AS SELECT * FROM kortix.connector_attachments;

CREATE VIEW kortix.executor_connection_profiles AS
SELECT connection_id AS profile_id, account_id, project_id, connector_id, owner_type,
  owner_id, label, is_default, status, metadata, created_by, created_at, updated_at
FROM kortix.connector_connections;

CREATE VIEW kortix.executor_credentials AS
SELECT credential_id, connector_id, connection_id AS profile_id, user_id, kind,
  value_enc, created_by, created_at, updated_at
FROM kortix.connection_credentials;

CREATE VIEW kortix.executor_executions AS
SELECT execution_id, account_id, project_id, session_id, acting_user_id, connector_id,
  connection_id AS profile_id, action_path, status, risk, request_digest, result_summary,
  approved_by, created_at, resolved_at
FROM kortix.connector_calls;

CREATE VIEW kortix.executor_oauth_applications AS
SELECT application_id, account_id, project_id, connector_id, connection_id AS profile_id,
  config_enc, created_by, created_at, updated_at
FROM kortix.connection_oauth_applications;

CREATE VIEW kortix.executor_oauth_sessions AS
SELECT session_id, application_id, account_id, project_id, connection_id AS profile_id,
  initiated_by, flow, status, state_hash, pkce_verifier_enc, device_code_enc,
  interval_seconds, next_poll_at, scopes, success_redirect_uri, error_redirect_uri,
  error_code, expires_at, consumed_at, created_at, updated_at
FROM kortix.connection_oauth_sessions;

CREATE VIEW kortix.executor_connection_policies AS
SELECT policy_id, connection_id AS profile_id, match, action, position, conditions,
  created_at, updated_at
FROM kortix.connection_policies;
