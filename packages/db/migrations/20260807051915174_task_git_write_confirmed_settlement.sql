-- Migration: task_git_write_confirmed_settlement
-- Generated snapshot state is paired with packages/db/drizzle/meta.
-- A client-side abort is not proof that receive-pack stopped mutating refs.
-- Preserve a durable live/settled state and reconcile crashed requests after a
-- post-deadline grace window. Bound workers can update only their session ref.

set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE kortix.project_tasks
  ADD COLUMN git_write_state varchar(16),
  ADD COLUMN git_write_ref text,
  ADD COLUMN git_write_old_oid varchar(64),
  ADD COLUMN git_write_new_oid varchar(64);

-- mixed-version-safe: an old proxy can still write and clear its two-column
-- fence during a rolling deploy. New six-column requests fail closed against an
-- old terminal update because that update would leave four non-null columns.
ALTER TABLE kortix.project_tasks
  DROP CONSTRAINT IF EXISTS project_tasks_git_write_lease_pair,
  DROP CONSTRAINT IF EXISTS project_tasks_git_write_lease_within_worker_deadline,
  DROP CONSTRAINT IF EXISTS project_tasks_git_write_requires_doing_worker,
  DROP CONSTRAINT IF EXISTS project_tasks_terminal_has_no_live_fences;

-- Existing two-column fences have no persisted CAS command. Keep them in the
-- allowed legacy shape. They can clear on old-proxy completion, but the new
-- reconciler never guesses settlement for a crashed legacy request.

ALTER TABLE kortix.project_tasks
  ADD CONSTRAINT project_tasks_git_write_complete CHECK (
    num_nonnulls(
      git_write_request_id, git_write_lease_expires_at, git_write_state,
      git_write_ref, git_write_old_oid, git_write_new_oid
    ) IN (0, 2, 6)
  ) NOT VALID,
  ADD CONSTRAINT project_tasks_git_write_state_valid CHECK (
    git_write_state IS NULL OR git_write_state IN ('live', 'settled')
  ) NOT VALID,
  ADD CONSTRAINT project_tasks_git_write_ref_valid CHECK (
    git_write_ref IS NULL OR git_write_ref = 'refs/heads/' || liveness_worker_session_id
  ) NOT VALID,
  ADD CONSTRAINT project_tasks_git_write_oid_valid CHECK (
    git_write_old_oid IS NULL OR (
      git_write_old_oid ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
      AND git_write_new_oid ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'
      AND length(git_write_old_oid) = length(git_write_new_oid)
      AND git_write_new_oid !~ '^0+$'
    )
  ) NOT VALID,
  ADD CONSTRAINT project_tasks_git_write_requires_doing_worker CHECK (
    git_write_request_id IS NULL OR (
      status = 'doing'
      AND liveness_worker_session_id IS NOT NULL
      AND liveness_deadline_at IS NOT NULL
    )
  ) NOT VALID,
  ADD CONSTRAINT project_tasks_terminal_has_no_live_fences CHECK (
    status NOT IN ('done', 'blocked') OR num_nonnulls(
      liveness_admission_id, liveness_admission_expires_at,
      git_write_request_id, git_write_lease_expires_at, git_write_state,
      git_write_ref, git_write_old_oid, git_write_new_oid
    ) = 0
  ) NOT VALID;
