-- Migration: repair databases that applied the task control plane before
-- goal-less tasks became the canonical task creation path.
set lock_timeout = '2s';
set statement_timeout = '30s';

-- mixed-version-safe: Existing task writers already send a non-null goal_slug.
-- New task-first clients may omit it. Dropping the constraint is backward compatible.
ALTER TABLE kortix.project_tasks
  -- squawk-ignore ban-drop-not-null
  ALTER COLUMN goal_slug DROP NOT NULL;
