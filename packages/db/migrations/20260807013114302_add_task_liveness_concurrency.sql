-- Migration: add_task_liveness_concurrency
--
-- Expand-only nullable columns. Unique indexes are built concurrently in the
-- following migrations. Preflight existing ownership before those builds.
set lock_timeout = '2s';
set statement_timeout = '30s';

alter table kortix.project_tasks
  add column if not exists liveness_admission_id text,
  add column if not exists liveness_admission_expires_at timestamptz,
  add column if not exists liveness_last_swept_at timestamptz;

alter table kortix.project_tasks
  add constraint project_tasks_liveness_admission_complete
    check (num_nonnulls(liveness_admission_id, liveness_admission_expires_at) in (0, 2))
    not valid,
  add constraint project_tasks_liveness_admission_within_deadline
    check (liveness_admission_expires_at is null or liveness_admission_expires_at <= liveness_deadline_at)
    not valid;

do $$
begin
  if exists (
    select 1 from kortix.project_tasks
    where status = 'doing' and claim_session_id is not null
    group by claim_session_id having count(*) > 1
  ) then
    raise exception 'duplicate active project task claims must be resolved before adding coordinator uniqueness';
  end if;
  if exists (
    select 1 from kortix.project_tasks
    where status = 'doing' and liveness_coordinator_session_id is not null
    group by liveness_coordinator_session_id having count(*) > 1
  ) then
    raise exception 'duplicate active bounded workers must be resolved before adding coordinator uniqueness';
  end if;
end $$;
