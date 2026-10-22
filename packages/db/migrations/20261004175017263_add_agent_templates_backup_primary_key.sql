-- Migration: add_agent_templates_backup_primary_key
--
-- Clears the Supabase performance advisor finding `no_primary_key` on
-- public.agent_templates_backup (level INFO, EXTERNAL facing): "Table
-- public.agent_templates_backup does not have a primary key".
--
-- The table is a legacy backup of public.agent_templates that was created
-- out-of-band: no migration in this repo creates it, the Drizzle schema does
-- not model it, and the only other reference is the client-role lockdown
-- (20260924194804787_client_role_lockdown.sql revokes client roles from it).
-- Fresh databases therefore never have it, so every statement below runs
-- behind a to_regclass guard and this migration is a no-op there.
--
-- Shape on prod (read-only catalog check, 2026-10-04): 17 columns, every one
-- nullable with no default, zero constraints, zero indexes, 2 archived rows,
-- both with a NULL template_id. No existing column can carry the primary key
-- (a PK column must be NOT NULL and unique; template_id is NULL in every
-- row), so the key is a new surrogate identity column, per the house
-- convention (squawk prefer-identity). It is named backup_id so it can never
-- collide with a column of the table this one backs up.
--
-- add column ... generated always as identity primary key rewrites the table
-- to fill the identity values, under a brief ACCESS EXCLUSIVE lock. The table
-- is a frozen 48 KB backup, so the rewrite is instantaneous; the .concurrent.ts
-- escape hatch exists for index builds on large live tables and buys nothing
-- here. No data is dropped, altered or rewritten in place: the archived rows
-- keep every value and each gains its identity value.
set lock_timeout = '2s';
set statement_timeout = '30s';

do $$
begin
  -- Legacy table: absent on fresh databases (dev, staging, CI, self-host).
  if to_regclass('public.agent_templates_backup') is null then
    return;
  end if;
  -- Already fixed (a promote that re-runs, or a manual intervention).
  if exists (
    select 1 from pg_constraint
    where conrelid = to_regclass('public.agent_templates_backup')
      and contype = 'p'
  ) then
    return;
  end if;
  -- A backup_id column without a primary key can only come from a manual
  -- intervention on this exact change; leave it for a human instead of
  -- guessing at a second surrogate column.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public'
      and table_name = 'agent_templates_backup'
      and column_name = 'backup_id'
  ) then
    return;
  end if;
  alter table public.agent_templates_backup
    add column backup_id bigint generated always as identity primary key;
end
$$;
