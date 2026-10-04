-- Migration: basejump_config_primary_key
--
-- Clears the Supabase performance advisor finding `no_primary_key` on
-- basejump.config (INFO, EXTERNAL facing; prod 2026-10-02 and 2026-10-04).
-- The remediation for `no_primary_key` is to add a primary key. The table is
-- basejump's own settings row — four nullable columns, one row, no key of any
-- kind — so there is no natural key and this adds the conventional synthetic
-- identity key, named per Postgres's own convention (<table>_pkey).
--
-- basejump is retired for the app (20260706120000000_retire_basejump) but the
-- schema itself is NOT dropped (that migration's header defers the teardown),
-- so deployed environments still carry the table. Two basejump RLS policies
-- (basejump.accounts, basejump.invitations) still read it through
-- basejump.is_set(), which selects a column by name and is unaffected. The
-- one behavior change is basejump.get_config(), whose row_to_json(select *)
-- output gains the id field — nothing in the app or the database calls it
-- (repo grep + pg_proc/pg_policies sweep on prod).
--
-- Guarded on the table existing: the migration chain never creates
-- basejump.config (the bootstrap installs only the basejump.account_user stub
-- — packages/db/scripts/test-prereqs.sql), so on a fresh self-host install or
-- the CI shadow database the table is absent and this is a no-op — the same
-- guard as 20261003010107485_basejump_accounts_fk_covering_indexes. The table
-- holds one row, so the rewrite is instant; the budgets below are the house
-- template defaults.
set lock_timeout = '2s';
set statement_timeout = '30s';

DO $$ BEGIN
  -- Both probes go through to_regclass(), never a 'x'::regclass cast: the cast
  -- RAISES 42P01 when the relation is absent (and an uncorrelated NOT EXISTS
  -- subquery is evaluated eagerly, guard or no guard), which would break the
  -- fresh installs this guard exists to skip.
  IF to_regclass('basejump.config') IS NOT NULL
     AND NOT EXISTS (
       SELECT 1
         FROM pg_constraint
        WHERE conrelid = to_regclass('basejump.config')
          AND contype = 'p'
     )
  THEN
    ALTER TABLE basejump.config
      ADD COLUMN id bigint GENERATED ALWAYS AS IDENTITY,
      ADD CONSTRAINT config_pkey PRIMARY KEY (id);
  END IF;
END $$;
