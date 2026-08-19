-- Migration: trigger_session_access
--
-- A constant default uses PostgreSQL's metadata-only ADD COLUMN path. The new
-- grants table is empty, so its FK and indexes do not scan or lock user data.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE kortix.project_trigger_runtime
  ADD COLUMN session_access_mode varchar(16) NOT NULL DEFAULT 'private';

ALTER TABLE kortix.project_trigger_runtime
  ADD CONSTRAINT project_trigger_runtime_session_access_mode_check
  CHECK (session_access_mode IN ('private', 'project', 'restricted')) NOT VALID;

CREATE TABLE kortix.project_trigger_session_access_grants (
  grant_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  slug varchar(128) NOT NULL,
  principal_type kortix.secret_grant_principal NOT NULL,
  principal_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_trigger_session_access_grants_trigger_fk
    FOREIGN KEY (project_id, slug)
    REFERENCES kortix.project_trigger_runtime(project_id, slug)
    ON DELETE CASCADE
);

CREATE INDEX idx_trigger_session_access_grants_trigger
  ON kortix.project_trigger_session_access_grants(project_id, slug);

CREATE UNIQUE INDEX idx_trigger_session_access_grants_unique
  ON kortix.project_trigger_session_access_grants(
    project_id,
    slug,
    principal_type,
    principal_id
  );
