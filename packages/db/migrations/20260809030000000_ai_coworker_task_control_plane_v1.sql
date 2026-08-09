-- Migration: AI coworker task control plane V1.
set lock_timeout = '2s';
set statement_timeout = '30s';

-- mixed-version-safe: Older API versions always write a non-null goal_slug.
-- Relaxing this constraint preserves those writes while new V1 clients may omit it.
ALTER TABLE kortix.project_tasks
  -- squawk-ignore ban-drop-not-null
  ALTER COLUMN goal_slug DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS intent text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS constraints jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS out_of_scope jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS contract_revision integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS control_plane_version integer,
  ADD COLUMN IF NOT EXISTS verification_requirements jsonb NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS review_policy jsonb NOT NULL DEFAULT '{"mode":"auto"}'::jsonb,
  ADD COLUMN IF NOT EXISTS completed_at timestamptz;

UPDATE kortix.project_tasks
SET completed_at = updated_at
WHERE status = 'done' AND completed_at IS NULL;

ALTER TABLE kortix.project_tasks
  ADD CONSTRAINT project_tasks_contract_revision_positive
    CHECK (contract_revision >= 1) NOT VALID,
  ADD CONSTRAINT project_tasks_contract_collections_valid
    CHECK (
      jsonb_typeof(constraints) = 'array'
      AND jsonb_typeof(out_of_scope) = 'array'
      AND jsonb_typeof(verification_requirements) = 'array'
      AND jsonb_typeof(review_policy) = 'object'
      AND review_policy->>'mode' IN ('auto', 'human')
    ) NOT VALID;

CREATE TABLE IF NOT EXISTS kortix.project_task_evidence (
  evidence_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  session_id text REFERENCES kortix.project_sessions(session_id) ON DELETE SET NULL,
  contract_revision integer NOT NULL CHECK (contract_revision >= 1),
  requirement_id text,
  kind varchar(32) NOT NULL,
  ref text NOT NULL CHECK (btrim(ref) <> ''),
  summary text NOT NULL DEFAULT '',
  candidate_digest text NOT NULL CHECK (btrim(candidate_digest) <> ''),
  state varchar(16) NOT NULL CHECK (state IN ('passed', 'failed', 'info')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_task_evidence_task_fkey
    FOREIGN KEY (project_id, task_id)
    REFERENCES kortix.project_tasks(project_id, task_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_task_evidence_task_created
  ON kortix.project_task_evidence(project_id, task_id, created_at);

CREATE TABLE IF NOT EXISTS kortix.project_task_blockers (
  blocker_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  category varchar(48) NOT NULL,
  requested_action text NOT NULL CHECK (btrim(requested_action) <> ''),
  target jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_digest text NOT NULL CHECK (btrim(request_digest) <> ''),
  attempts_made jsonb NOT NULL DEFAULT '[]'::jsonb,
  status varchar(16) NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'resolved', 'canceled', 'expired')),
  next_reminder_at timestamptz,
  expires_at timestamptz,
  resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_task_blockers_task_fkey
    FOREIGN KEY (project_id, task_id)
    REFERENCES kortix.project_tasks(project_id, task_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_task_blockers_task
  ON kortix.project_task_blockers(project_id, task_id);
CREATE INDEX IF NOT EXISTS idx_project_task_blockers_due
  ON kortix.project_task_blockers(status, next_reminder_at)
  WHERE status = 'open';
CREATE INDEX IF NOT EXISTS idx_project_task_blockers_expiry
  ON kortix.project_task_blockers(expires_at)
  WHERE status = 'open' AND expires_at IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_project_task_blockers_open_digest_unique
  ON kortix.project_task_blockers(project_id, task_id, request_digest)
  WHERE status = 'open';

CREATE TABLE IF NOT EXISTS kortix.project_task_events (
  event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  event_type text NOT NULL CHECK (btrim(event_type) <> ''),
  actor_type varchar(32) NOT NULL,
  actor_id text,
  session_id text REFERENCES kortix.project_sessions(session_id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_task_events_task_fkey
    FOREIGN KEY (project_id, task_id)
    REFERENCES kortix.project_tasks(project_id, task_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_task_events_task_created
  ON kortix.project_task_events(project_id, task_id, created_at, event_id);

CREATE TABLE IF NOT EXISTS kortix.project_task_session_links (
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  session_id text NOT NULL REFERENCES kortix.project_sessions(session_id) ON DELETE CASCADE,
  role varchar(16) NOT NULL CHECK (role IN ('coordinator', 'worker', 'verifier')),
  parent_session_id text REFERENCES kortix.project_sessions(session_id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (task_id, session_id),
  CONSTRAINT project_task_session_links_task_fkey
    FOREIGN KEY (project_id, task_id)
    REFERENCES kortix.project_tasks(project_id, task_id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_project_task_session_links_task_role
  ON kortix.project_task_session_links(project_id, task_id, role);

CREATE TABLE IF NOT EXISTS kortix.project_task_messages (
  message_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  task_id uuid NOT NULL,
  sender_session_id text,
  recipient_session_id text,
  message_type varchar(32) NOT NULL,
  body jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text,
  idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
  status varchar(16) NOT NULL DEFAULT 'accepted'
    CHECK (status IN ('accepted', 'queued', 'delivered', 'processed', 'failed', 'expired')),
  acknowledged_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_task_messages_task_fkey
    FOREIGN KEY (project_id, task_id)
    REFERENCES kortix.project_tasks(project_id, task_id)
    ON DELETE CASCADE,
  CONSTRAINT project_task_messages_sender_fkey
    FOREIGN KEY (sender_session_id)
    REFERENCES kortix.project_sessions(session_id)
    ON DELETE SET NULL,
  CONSTRAINT project_task_messages_recipient_fkey
    FOREIGN KEY (recipient_session_id)
    REFERENCES kortix.project_sessions(session_id)
    ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_project_task_messages_idempotency
  ON kortix.project_task_messages(task_id, idempotency_key);
CREATE INDEX IF NOT EXISTS idx_project_task_messages_recipient
  ON kortix.project_task_messages(recipient_session_id, status, created_at);

CREATE TABLE IF NOT EXISTS kortix.project_task_refinement_proposals (
  proposal_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL,
  task_id uuid,
  scope varchar(16) NOT NULL CHECK (scope IN ('task', 'agent', 'project', 'account', 'platform')),
  observation text NOT NULL,
  base_revision text NOT NULL,
  patch jsonb NOT NULL,
  rollback_patch jsonb NOT NULL,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  status varchar(16) NOT NULL DEFAULT 'proposed'
    CHECK (status IN ('proposed', 'applied', 'rejected', 'rolled_back')),
  created_by_session_id text,
  applied_at timestamptz,
  rolled_back_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_task_refinement_task_fkey
    FOREIGN KEY (project_id, task_id)
    REFERENCES kortix.project_tasks(project_id, task_id)
    ON DELETE CASCADE,
  CONSTRAINT project_task_refinement_session_fkey
    FOREIGN KEY (created_by_session_id)
    REFERENCES kortix.project_sessions(session_id)
    ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_project_task_refinement_project_status
  ON kortix.project_task_refinement_proposals(project_id, status, created_at);

CREATE OR REPLACE FUNCTION kortix.prevent_task_ledger_update()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$function$;

DROP TRIGGER IF EXISTS project_task_evidence_append_only ON kortix.project_task_evidence;
CREATE TRIGGER project_task_evidence_append_only
  BEFORE UPDATE ON kortix.project_task_evidence
  FOR EACH ROW EXECUTE FUNCTION kortix.prevent_task_ledger_update();

DROP TRIGGER IF EXISTS project_task_events_append_only ON kortix.project_task_events;
CREATE TRIGGER project_task_events_append_only
  BEFORE UPDATE ON kortix.project_task_events
  FOR EACH ROW EXECUTE FUNCTION kortix.prevent_task_ledger_update();

CREATE OR REPLACE FUNCTION kortix.record_project_task_projection()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND NEW.status = 'done' AND OLD.status IS DISTINCT FROM NEW.status THEN
    NEW.completed_at := COALESCE(NEW.completed_at, now());
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'done' AND NEW.status IS DISTINCT FROM OLD.status THEN
    NEW.completed_at := NULL;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS project_tasks_projection_before_write ON kortix.project_tasks;
CREATE TRIGGER project_tasks_projection_before_write
  BEFORE UPDATE ON kortix.project_tasks
  FOR EACH ROW EXECUTE FUNCTION kortix.record_project_task_projection();

CREATE OR REPLACE FUNCTION kortix.record_project_task_event_and_links()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO kortix.project_task_events(project_id, task_id, event_type, actor_type, payload)
    VALUES (NEW.project_id, NEW.task_id, 'task.created', 'platform', jsonb_build_object(
      'status', NEW.status,
      'contract_revision', NEW.contract_revision
    ));
  ELSIF OLD.status IS DISTINCT FROM NEW.status THEN
    INSERT INTO kortix.project_task_events(project_id, task_id, event_type, actor_type, session_id, payload)
    VALUES (NEW.project_id, NEW.task_id, 'task.status_changed', 'platform', NEW.claim_session_id,
      jsonb_build_object('from', OLD.status, 'to', NEW.status));
  END IF;

  IF NEW.claim_session_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.claim_session_id IS DISTINCT FROM NEW.claim_session_id) THEN
    INSERT INTO kortix.project_task_session_links(
      project_id, task_id, session_id, role, parent_session_id, created_at
    ) VALUES (
      NEW.project_id,
      NEW.task_id,
      NEW.claim_session_id,
      'coordinator',
      NULL,
      NEW.updated_at
    )
    ON CONFLICT (task_id, session_id) DO UPDATE
      SET role = EXCLUDED.role,
          parent_session_id = EXCLUDED.parent_session_id,
          created_at = EXCLUDED.created_at;
  END IF;

  IF NEW.liveness_worker_session_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR OLD.liveness_worker_session_id IS DISTINCT FROM NEW.liveness_worker_session_id) THEN
    INSERT INTO kortix.project_task_session_links(
      project_id, task_id, session_id, role, parent_session_id
    ) VALUES (
      NEW.project_id,
      NEW.task_id,
      NEW.liveness_worker_session_id,
      'worker',
      NEW.liveness_coordinator_session_id
    ) ON CONFLICT (task_id, session_id) DO NOTHING;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS project_tasks_event_and_links_after_write ON kortix.project_tasks;
CREATE TRIGGER project_tasks_event_and_links_after_write
  AFTER INSERT OR UPDATE ON kortix.project_tasks
  FOR EACH ROW EXECUTE FUNCTION kortix.record_project_task_event_and_links();
