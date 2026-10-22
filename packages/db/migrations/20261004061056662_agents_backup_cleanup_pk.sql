-- Migration: agents_backup_cleanup_pk
--
-- Clears the Supabase performance advisor finding `no_primary_key` on
-- public.agents_backup_cleanup_20250729 (INFO, EXTERNAL facing; prod
-- 2026-10-02, re-confirmed live 2026-10-04 through the read-only Management
-- API). The remediation for `no_primary_key` is to add a primary key.
--
-- The table is a CTAS-style backup of `agents` taken for the 2025-07-29
-- cleanup: 17 columns, every one nullable, zero indexes, zero constraints,
-- two rows (both with a NULL agent_id — verified read-only on prod). A CTAS
-- copies no constraints, so there is no natural key; this adds the
-- conventional synthetic identity key, named per Postgres's own convention
-- (<table>_pkey). Purely additive: the ADD COLUMN cannot collide with a prod
-- column (verified live: no id column), no row value is touched, and the
-- two-row rewrite is instant under the house 2 s lock budget.
--
-- Nothing in the app reads this table: the only repo reference is the
-- client-role privilege revocation in
-- 20260924194804787_client_role_lockdown.sql, which lists the table by name
-- and is unaffected by the new column. The advisor's three sibling backup
-- tables (agent_templates_backup, agent_workflows_backup, and the
-- account_tokens_grant_backup* pair) are separate findings, each with its own
-- issue.
--
-- Guarded on the table existing: the migration chain never creates it (the
-- table predates the repo's migration history), so on a fresh self-host
-- install, the CI shadow database and every db-suite database the table is
-- absent and this is a no-op.
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $$ BEGIN
  -- Both probes go through to_regclass(), never a 'x'::regclass cast: the cast
  -- RAISES 42P01 when the relation is absent (and an uncorrelated NOT EXISTS
  -- subquery is evaluated eagerly, guard or no guard), which would break the
  -- fresh installs this guard exists to skip.
  IF to_regclass('public.agents_backup_cleanup_20250729') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM pg_constraint
        WHERE conrelid = to_regclass('public.agents_backup_cleanup_20250729')
          AND contype = 'p'
     )
  THEN
    ALTER TABLE public.agents_backup_cleanup_20250729
      ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY,
      ADD CONSTRAINT agents_backup_cleanup_20250729_pkey PRIMARY KEY (id);
  END IF;
END $$;
