-- Up Migration
--
-- Reconcile objects the FAKED baseline left missing on environments that were
-- baselined while their schema predated the migration system (prod).
--
-- Background: on an environment whose schema already existed, migrate.ts's
-- autoBaselineIfNeeded marks the baseline applied WITHOUT running it. That
-- assumes the pre-existing schema is a complete superset of the baseline. On
-- prod it was NOT — historical drift (a migration recorded-but-rolled-back under
-- the retired apply-migrations.sh, e.g. project_session_public_shares) left
-- holes the fake then cemented. The deployed code references these objects, so
-- the gaps surface as runtime 500s ("relation/column does not exist").
--
-- Everything here is idempotent (IF NOT EXISTS): a no-op on a fresh build and on
-- dev (both already have the baseline), and a backfill on prod. This is the
-- repo-native, CI-verified counterpart to the live-schema presence gate added in
-- deploy-prod.yml (verify-live-schema.ts) — together they guarantee a deployed
-- DB always contains every table+column the migrations define.

-- ── Tables the faked baseline never created on prod ─────────────────────────
-- (project_session_public_shares = the public preview/file share links table;
--  provider_events = sandbox provision/migrate telemetry for the admin tab.)

CREATE TABLE IF NOT EXISTS kortix.project_session_public_shares (
  share_id        uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  token_hash      text NOT NULL,
  session_id      text NOT NULL REFERENCES kortix.project_sessions(session_id) ON DELETE CASCADE,
  project_id      uuid NOT NULL REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  created_by      uuid,
  resource_type   text NOT NULL DEFAULT 'preview',
  label           text NOT NULL DEFAULT 'App preview',
  port            integer,
  path            text NOT NULL DEFAULT '/',
  file_path       text,
  mode            text NOT NULL DEFAULT 'view',
  allow_websocket boolean NOT NULL DEFAULT false,
  expires_at      timestamptz,
  revoked_at      timestamptz,
  last_used_at    timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_session_public_shares_token_hash ON kortix.project_session_public_shares USING btree (token_hash);
CREATE INDEX IF NOT EXISTS idx_project_session_public_shares_session ON kortix.project_session_public_shares USING btree (session_id);
CREATE INDEX IF NOT EXISTS idx_project_session_public_shares_project ON kortix.project_session_public_shares USING btree (project_id);

CREATE TABLE IF NOT EXISTS kortix.provider_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  provider      text NOT NULL,
  kind          text NOT NULL,
  outcome       text NOT NULL,
  total_ms      integer,
  marks         jsonb DEFAULT '[]'::jsonb,
  attempts      integer DEFAULT 1,
  error_class   text,
  error         text,
  from_provider text,
  session_id    text,
  account_id    uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_provider_events_provider ON kortix.provider_events USING btree (provider);
CREATE INDEX IF NOT EXISTS idx_provider_events_kind     ON kortix.provider_events USING btree (kind);
CREATE INDEX IF NOT EXISTS idx_provider_events_outcome  ON kortix.provider_events USING btree (outcome);
CREATE INDEX IF NOT EXISTS idx_provider_events_created  ON kortix.provider_events USING btree (created_at);

-- ── Columns the faked baseline never added on prod ──────────────────────────

ALTER TABLE kortix.account_deletion_requests ADD COLUMN IF NOT EXISTS created_at timestamptz DEFAULT now();
ALTER TABLE kortix.account_deletion_requests ADD COLUMN IF NOT EXISTS updated_at timestamptz DEFAULT now();
ALTER TABLE kortix.account_deletion_requests ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE kortix.account_deletion_requests ADD COLUMN IF NOT EXISTS is_cancelled boolean DEFAULT false;
ALTER TABLE kortix.account_deletion_requests ADD COLUMN IF NOT EXISTS is_deleted boolean DEFAULT false;
-- canonical is NOT NULL, but prod has 353 existing rows with no value to backfill,
-- so it is added NULLABLE here; the deletion feature populates it on every insert.
ALTER TABLE kortix.account_deletion_requests ADD COLUMN IF NOT EXISTS deletion_scheduled_for timestamptz;

ALTER TABLE kortix.chat_channel_bindings ADD COLUMN IF NOT EXISTS agent_model varchar;

ALTER TABLE kortix.credit_accounts ADD COLUMN IF NOT EXISTS last_reconciled_at timestamptz;
ALTER TABLE kortix.credit_accounts ADD COLUMN IF NOT EXISTS needs_reconciliation boolean DEFAULT false;
ALTER TABLE kortix.credit_accounts ADD COLUMN IF NOT EXISTS reconciliation_discrepancy numeric DEFAULT 0;

ALTER TABLE kortix.credit_ledger ADD COLUMN IF NOT EXISTS locked_at timestamptz;
ALTER TABLE kortix.credit_ledger ADD COLUMN IF NOT EXISTS message_id uuid;
ALTER TABLE kortix.credit_ledger ADD COLUMN IF NOT EXISTS team_member_email text;
ALTER TABLE kortix.credit_ledger ADD COLUMN IF NOT EXISTS thread_id uuid;
ALTER TABLE kortix.credit_ledger ADD COLUMN IF NOT EXISTS triggered_by_user_id uuid;

ALTER TABLE kortix.credit_purchases ADD COLUMN IF NOT EXISTS expires_at timestamptz;
ALTER TABLE kortix.credit_purchases ADD COLUMN IF NOT EXISTS last_reconciliation_attempt timestamptz;
ALTER TABLE kortix.credit_purchases ADD COLUMN IF NOT EXISTS reconciled_at timestamptz;
ALTER TABLE kortix.credit_purchases ADD COLUMN IF NOT EXISTS reconciliation_attempts integer DEFAULT 0;

ALTER TABLE kortix.credit_usage ADD COLUMN IF NOT EXISTS message_id uuid;
ALTER TABLE kortix.credit_usage ADD COLUMN IF NOT EXISTS thread_id uuid;

ALTER TABLE kortix.sandboxes ADD COLUMN IF NOT EXISTS pooled_at timestamptz;

-- Down Migration
-- Forward-only: this migration only fills gaps that should never have existed;
-- dropping the backfilled columns/tables would re-introduce the drift.
