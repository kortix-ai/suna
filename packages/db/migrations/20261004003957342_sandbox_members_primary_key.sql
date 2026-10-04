-- Migration: sandbox_members_primary_key
--
-- Gives kortix.sandbox_members the primary key the Supabase performance
-- advisor's `no_primary_key` lint requires. The table kept a UNIQUE index on
-- (sandbox_id, user_id) (idx_sandbox_members_unique, baseline) but never a
-- PRIMARY KEY constraint, so the advisor flags it on every project.
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- One catalog-only statement instead of the generator's two
-- (DROP INDEX + ADD CONSTRAINT ... PRIMARY KEY): reusing the existing unique
-- index renames it to the constraint's name and skips the index rebuild, so
-- there is no window without uniqueness enforcement. drizzle-kit's
-- drizzle/ snapshot declares the same end state (constraint
-- sandbox_members_pkey, no separate unique index), and schema-contract
-- compares kinds, not index names. Same shape as the account_memberships
-- repair of 2026-09-25 (20260925023835781_prod_missing_constraints_not_valid
-- .sql), which attached a PK with ADD CONSTRAINT ... PRIMARY KEY USING INDEX.
--
-- Every environment already has idx_sandbox_members_unique on NOT NULL
-- columns (baseline; nothing after it touches this table), so the statement
-- needs no scan and cannot fail on data. The table holds 0 rows in every
-- environment (20260819160100000_rbac_cutover_views.sql kept it only because
-- member-spend.ts still reads and writes it), so the brief ACCESS EXCLUSIVE
-- lock the statement takes waits on no writer.
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'kortix.sandbox_members'::regclass and contype = 'p'
  ) then
    alter table kortix.sandbox_members
      add constraint sandbox_members_pkey primary key using index idx_sandbox_members_unique;
  end if;
end
$$;

-- mixed-version-safe: no statement drops or alters anything an old app
-- version reads. The only observable change is the index rename
-- (idx_sandbox_members_unique -> sandbox_members_pkey, same definition),
-- and no code references the old index name.
