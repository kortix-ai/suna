-- Runtime state for git-backed triggers.
--
-- Triggers themselves live in the project repo as
-- .opencode/triggers/<slug>.md (frontmatter + prompt body). The repo is the
-- source of truth for the trigger's *config* (schedule, type, prompt,
-- secret_env reference). But the *runtime state* — specifically last_fired_at
-- which the cron scheduler reads to decide "is it due yet" — has to live in
-- the database, since the repo can't be written from inside a scheduler
-- loop without amplifying every fire into a git commit.
--
-- Primary key is (project_id, slug); slugs are derived from the file basename.

create table if not exists kortix.project_trigger_runtime (
  project_id uuid not null references kortix.projects(project_id) on delete cascade,
  slug varchar(128) not null,
  last_fired_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (project_id, slug)
);
