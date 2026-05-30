-- ╔══════════════════════════════════════════════════════════════════════════╗
-- ║  Executor — project-scoped policies + default_mode setting                 ║
-- ║                                                                            ║
-- ║  Adds top-level [[policies]] (cross-connector rules with fully-qualified   ║
-- ║  patterns) and [policy].default_mode (risk | allow_all) to the executor.   ║
-- ║  Project rules are evaluated BEFORE any connector-scoped rule; when no     ║
-- ║  rule matches, default_mode decides (risk = read→run / write→approve;     ║
-- ║  allow_all = run, the legacy behaviour). See docs/specs/executor.md §8.    ║
-- ║                                                                            ║
-- ║  Idempotent (DO blocks / IF NOT EXISTS) — safe to re-run.                  ║
-- ╚══════════════════════════════════════════════════════════════════════════╝

-- ── enum: default_mode ──────────────────────────────────────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
    WHERE n.nspname = 'kortix' AND t.typname = 'executor_default_mode') THEN
    CREATE TYPE "kortix"."executor_default_mode" AS ENUM ('risk', 'allow_all');
  END IF;
END$$;

-- ── project policies (cross-connector) ──────────────────────────────────────
CREATE TABLE IF NOT EXISTS kortix.executor_project_policies (
  policy_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  match       varchar(512) NOT NULL,
  action      kortix.executor_policy_action NOT NULL,
  position    integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_executor_project_policies_project
  ON kortix.executor_project_policies(project_id);

-- ── project executor settings (default_mode et al.) ─────────────────────────
CREATE TABLE IF NOT EXISTS kortix.executor_project_settings (
  project_id   uuid PRIMARY KEY REFERENCES kortix.projects(project_id) ON DELETE CASCADE,
  default_mode kortix.executor_default_mode NOT NULL DEFAULT 'allow_all',
  updated_at   timestamptz NOT NULL DEFAULT now()
);
