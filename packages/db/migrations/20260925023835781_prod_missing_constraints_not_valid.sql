-- Migration: prod_missing_constraints_not_valid
--
-- Adds the constraints the baseline defines that prod never received. Prod's
-- baseline was faked (MIGRATIONS.md "baseline"), so its tables were created
-- before the migration history and some constraints were never built. A
-- read-only catalog diff of prod against a freshly migrated database
-- (2026-09-25) found exactly these missing:
--
--   account_memberships        PRIMARY KEY (user_id, account_id)
--   legacy_sandbox_migrations  CHECK mode, CHECK status
--   project_snapshot_builds    CHECK status
--   sandbox_compute_sessions   CHECK state, FK account_id, FK ledger_id
--   yolo_member_tokens         FK account_id
--
-- Every other database (dev, staging, self-host, fresh) already has each one
-- under the same name, so every statement is guarded by a pg_constraint check
-- and this file is a no-op there.
--
-- Prod held 0 violating rows for every constraint on 2026-09-25 (aggregate
-- counts: 0 duplicate or NULL membership keys, 0 out-of-set mode/status/state
-- values, 0 orphan account_id or ledger_id references).
--
-- The FKs and CHECKs are added NOT VALID here (a brief lock, no scan); the
-- next migration validates them without blocking writes. The primary key
-- attaches the unique index that
-- 20260925023835081_account_memberships_pkey_index.concurrent.ts built, so it
-- needs only a brief ACCESS EXCLUSIVE lock and no scan (both columns are
-- already NOT NULL on prod).
set lock_timeout = '5s';
set statement_timeout = '30s';

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'kortix.account_memberships'::regclass and contype = 'p'
  ) then
    alter table kortix.account_memberships
      add constraint account_members_pkey primary key using index account_members_pkey;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'kortix.legacy_sandbox_migrations'::regclass
       and conname = 'legacy_sandbox_migrations_mode_check'
  ) then
    alter table kortix.legacy_sandbox_migrations
      add constraint legacy_sandbox_migrations_mode_check
      check (((mode)::text = any (array[('dry_run'::character varying)::text, ('apply'::character varying)::text, ('verify'::character varying)::text, ('rollback'::character varying)::text])))
      not valid;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'kortix.legacy_sandbox_migrations'::regclass
       and conname = 'legacy_sandbox_migrations_status_check'
  ) then
    alter table kortix.legacy_sandbox_migrations
      add constraint legacy_sandbox_migrations_status_check
      check (((status)::text = any ((array['planned'::character varying, 'running'::character varying, 'applied'::character varying, 'verified'::character varying, 'completed'::character varying, 'rolled_back'::character varying, 'failed'::character varying])::text[])))
      not valid;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'kortix.project_snapshot_builds'::regclass
       and conname = 'project_snapshot_builds_status_check'
  ) then
    alter table kortix.project_snapshot_builds
      add constraint project_snapshot_builds_status_check
      check ((status = any (array['building'::text, 'ready'::text, 'failed'::text])))
      not valid;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'kortix.sandbox_compute_sessions'::regclass
       and conname = 'sandbox_compute_sessions_state_check'
  ) then
    alter table kortix.sandbox_compute_sessions
      add constraint sandbox_compute_sessions_state_check
      check ((state = any (array['active'::text, 'stopped'::text, 'finalized'::text])))
      not valid;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'kortix.sandbox_compute_sessions'::regclass
       and conname = 'sandbox_compute_sessions_account_id_fkey'
  ) then
    alter table kortix.sandbox_compute_sessions
      add constraint sandbox_compute_sessions_account_id_fkey
      foreign key (account_id) references kortix.accounts (account_id) on delete cascade
      not valid;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'kortix.sandbox_compute_sessions'::regclass
       and conname = 'sandbox_compute_sessions_ledger_id_fkey'
  ) then
    alter table kortix.sandbox_compute_sessions
      add constraint sandbox_compute_sessions_ledger_id_fkey
      foreign key (ledger_id) references kortix.credit_ledger (id) on delete set null
      not valid;
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'kortix.yolo_member_tokens'::regclass
       and conname = 'yolo_member_tokens_account_id_fkey'
  ) then
    alter table kortix.yolo_member_tokens
      add constraint yolo_member_tokens_account_id_fkey
      foreign key (account_id) references kortix.accounts (account_id) on delete cascade
      not valid;
  end if;
end
$$;
