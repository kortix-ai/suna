DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_type
    WHERE typnamespace = 'kortix'::regnamespace
      AND typname = 'session_lifecycle_command_status'
  ) THEN
    CREATE TYPE kortix.session_lifecycle_command_status AS ENUM (
      'queued',
      'running',
      'succeeded',
      'failed',
      'dead_lettered'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS kortix.session_lifecycle_commands (
  command_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  command_type varchar(64) NOT NULL,
  source varchar(64) NOT NULL,
  status kortix.session_lifecycle_command_status NOT NULL DEFAULT 'queued',
  project_id uuid NOT NULL REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  session_id text REFERENCES kortix.project_sessions(session_id) ON DELETE SET NULL,
  account_id uuid NOT NULL REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  actor_user_id uuid,
  idempotency_key text,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  available_at timestamptz NOT NULL DEFAULT now(),
  locked_by text,
  locked_until timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_session_lifecycle_commands_idempotency
  ON kortix.session_lifecycle_commands(idempotency_key);

CREATE INDEX IF NOT EXISTS idx_session_lifecycle_commands_due
  ON kortix.session_lifecycle_commands(status, available_at);

CREATE INDEX IF NOT EXISTS idx_session_lifecycle_commands_project
  ON kortix.session_lifecycle_commands(project_id);

CREATE INDEX IF NOT EXISTS idx_session_lifecycle_commands_session
  ON kortix.session_lifecycle_commands(session_id);

CREATE INDEX IF NOT EXISTS idx_session_lifecycle_commands_locked
  ON kortix.session_lifecycle_commands(locked_until);
