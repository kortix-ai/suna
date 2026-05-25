-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Executor — unified connector layer                                        ║
-- ║                                                                            ║
-- ║  Connectors (Pipedream / MCP / OpenAPI / GraphQL / HTTP) are DEFINED in    ║
-- ║  kortix.toml ([[connectors]]) and materialized here on push (manifest =    ║
-- ║  config source of truth, like triggers). Credentials are project_secrets;  ║
-- ║  who-can-use is project-secret sharing (share_scope + grants below).       ║
-- ║  See docs/specs/executor.md.                                               ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ── enum types (idempotent) ─────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'secret_share_scope') THEN
    CREATE TYPE "kortix"."secret_share_scope" AS ENUM ('project', 'restricted');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'secret_grant_principal') THEN
    CREATE TYPE "kortix"."secret_grant_principal" AS ENUM ('member', 'group');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'project_secret_scope') THEN
    CREATE TYPE "kortix"."project_secret_scope" AS ENUM ('runtime', 'connector');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'executor_connector_provider') THEN
    CREATE TYPE "kortix"."executor_connector_provider" AS ENUM ('pipedream', 'mcp', 'openapi', 'graphql', 'http');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'executor_connector_status') THEN
    CREATE TYPE "kortix"."executor_connector_status" AS ENUM ('active', 'disabled', 'needs_auth', 'error');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'executor_policy_action') THEN
    CREATE TYPE "kortix"."executor_policy_action" AS ENUM ('always_run', 'require_approval', 'block');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'executor_risk') THEN
    CREATE TYPE "kortix"."executor_risk" AS ENUM ('read', 'write', 'destructive');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'executor_execution_status') THEN
    CREATE TYPE "kortix"."executor_execution_status" AS ENUM ('ok', 'error', 'denied', 'pending_approval');
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'executor_credential_mode') THEN
    CREATE TYPE "kortix"."executor_credential_mode" AS ENUM ('shared', 'per_user');
  END IF;
END$$;

-- ── project secret sharing + usage scope ────────────────────────────────────
ALTER TABLE kortix.project_secrets
  ADD COLUMN IF NOT EXISTS share_scope kortix.secret_share_scope NOT NULL DEFAULT 'project';
ALTER TABLE kortix.project_secrets
  ADD COLUMN IF NOT EXISTS scope kortix.project_secret_scope NOT NULL DEFAULT 'runtime';

CREATE TABLE IF NOT EXISTS kortix.project_secret_grants (
  grant_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  secret_id      uuid NOT NULL REFERENCES kortix.project_secrets(secret_id) ON DELETE CASCADE,
  principal_type kortix.secret_grant_principal NOT NULL,
  principal_id   uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_project_secret_grants_secret
  ON kortix.project_secret_grants(secret_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_secret_grants_unique
  ON kortix.project_secret_grants(secret_id, principal_type, principal_id);

-- ── connectors ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS kortix.executor_connectors (
  connector_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  project_id     uuid NOT NULL REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  slug           varchar(128) NOT NULL,
  name           varchar(255) NOT NULL,
  provider_type  kortix.executor_connector_provider NOT NULL,
  enabled        boolean NOT NULL DEFAULT true,
  config         jsonb NOT NULL DEFAULT '{}'::jsonb,
  auth_secret    varchar(64),
  manifest_hash  varchar(64),
  status         kortix.executor_connector_status NOT NULL DEFAULT 'active',
  last_error     text,
  last_synced_at timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_executor_connectors_project
  ON kortix.executor_connectors(project_id);
CREATE INDEX IF NOT EXISTS idx_executor_connectors_account
  ON kortix.executor_connectors(account_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_executor_connectors_project_slug
  ON kortix.executor_connectors(project_id, slug);
ALTER TABLE kortix.executor_connectors
  ADD COLUMN IF NOT EXISTS share_scope kortix.secret_share_scope NOT NULL DEFAULT 'project';
ALTER TABLE kortix.executor_connectors
  ADD COLUMN IF NOT EXISTS credential_mode kortix.executor_credential_mode NOT NULL DEFAULT 'shared';

-- connector access grants (restricted scope)
CREATE TABLE IF NOT EXISTS kortix.executor_connector_grants (
  grant_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id   uuid NOT NULL REFERENCES kortix.executor_connectors(connector_id) ON DELETE CASCADE,
  principal_type kortix.secret_grant_principal NOT NULL,
  principal_id   uuid NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_executor_connector_grants_connector
  ON kortix.executor_connector_grants(connector_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_executor_connector_grants_unique
  ON kortix.executor_connector_grants(connector_id, principal_type, principal_id);

-- connector credentials, split from the connector (user_id NULL = shared)
CREATE TABLE IF NOT EXISTS kortix.executor_credentials (
  credential_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id  uuid NOT NULL REFERENCES kortix.executor_connectors(connector_id) ON DELETE CASCADE,
  user_id       uuid,
  kind          varchar(32) NOT NULL DEFAULT 'secret',
  value_enc     text NOT NULL,
  created_by    uuid,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_executor_credentials_connector
  ON kortix.executor_credentials(connector_id);
-- one credential per (connector, user); COALESCE so the shared (NULL) row is unique too
CREATE UNIQUE INDEX IF NOT EXISTS idx_executor_credentials_connector_user
  ON kortix.executor_credentials(connector_id, COALESCE(user_id, '00000000-0000-0000-0000-000000000000'::uuid));

CREATE TABLE IF NOT EXISTS kortix.executor_connector_actions (
  action_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id  uuid NOT NULL REFERENCES kortix.executor_connectors(connector_id) ON DELETE CASCADE,
  path          varchar(512) NOT NULL,
  name          varchar(255) NOT NULL,
  description   text,
  input_schema  jsonb,
  output_schema jsonb,
  risk          kortix.executor_risk NOT NULL DEFAULT 'read',
  binding       jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_executor_connector_actions_connector
  ON kortix.executor_connector_actions(connector_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_executor_connector_actions_path
  ON kortix.executor_connector_actions(connector_id, path);

CREATE TABLE IF NOT EXISTS kortix.executor_connector_policies (
  policy_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  connector_id uuid NOT NULL REFERENCES kortix.executor_connectors(connector_id) ON DELETE CASCADE,
  match        varchar(512) NOT NULL,
  action       kortix.executor_policy_action NOT NULL,
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_executor_connector_policies_connector
  ON kortix.executor_connector_policies(connector_id);

CREATE TABLE IF NOT EXISTS kortix.executor_executions (
  execution_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     uuid NOT NULL REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  project_id     uuid NOT NULL REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  connector_id   uuid REFERENCES kortix.executor_connectors(connector_id) ON DELETE SET NULL,
  action_path    varchar(512) NOT NULL,
  acting_user_id uuid,
  session_id     uuid,
  status         kortix.executor_execution_status NOT NULL,
  risk           kortix.executor_risk,
  request_digest varchar(64),
  result_summary jsonb,
  approved_by    uuid,
  created_at     timestamptz NOT NULL DEFAULT now(),
  resolved_at    timestamptz
);
CREATE INDEX IF NOT EXISTS idx_executor_executions_project
  ON kortix.executor_executions(project_id);
CREATE INDEX IF NOT EXISTS idx_executor_executions_connector
  ON kortix.executor_executions(connector_id);
CREATE INDEX IF NOT EXISTS idx_executor_executions_status
  ON kortix.executor_executions(status);
