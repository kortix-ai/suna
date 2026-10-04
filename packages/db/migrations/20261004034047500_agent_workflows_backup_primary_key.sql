-- Promote the concurrent unique index to a primary key on the legacy backup.
-- mixed-version-safe: Adds identity enforcement only; no application reads or
-- writes this legacy table. Read-only production preflight found no null ids
-- or duplicate ids. Existing rows and client-role grants remain unchanged.
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $$
BEGIN
  IF to_regclass('public.agent_workflows_backup') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM pg_constraint
       WHERE conrelid = to_regclass('public.agent_workflows_backup')
         AND contype = 'p'
     ) THEN
    ALTER TABLE public.agent_workflows_backup
      ADD CONSTRAINT agent_workflows_backup_pkey
      PRIMARY KEY USING INDEX agent_workflows_backup_pkey;
  END IF;
END
$$;
