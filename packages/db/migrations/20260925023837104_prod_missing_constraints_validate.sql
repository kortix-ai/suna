-- Migration: prod_missing_constraints_validate
--
-- Validates the constraints 20260925023835781_prod_missing_constraints_not_valid
-- added on prod. The .concurrent.ts migration between the two commits the
-- batch transaction, so the brief locks the NOT VALID adds took are released
-- before these scans start. VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE: it scans
-- the table but blocks no reads or writes. On a database where a constraint
-- was already valid (dev, staging, self-host, fresh) it returns immediately.
--
-- Largest scan on prod: sandbox_compute_sessions (135k rows, 48 MB), checked
-- against the accounts and credit_ledger primary keys.
set lock_timeout = '5s';
set statement_timeout = '5min';

alter table kortix.legacy_sandbox_migrations
  validate constraint legacy_sandbox_migrations_mode_check;
alter table kortix.legacy_sandbox_migrations
  validate constraint legacy_sandbox_migrations_status_check;
alter table kortix.project_snapshot_builds
  validate constraint project_snapshot_builds_status_check;
alter table kortix.sandbox_compute_sessions
  validate constraint sandbox_compute_sessions_state_check;
alter table kortix.sandbox_compute_sessions
  validate constraint sandbox_compute_sessions_account_id_fkey;
alter table kortix.sandbox_compute_sessions
  validate constraint sandbox_compute_sessions_ledger_id_fkey;
alter table kortix.yolo_member_tokens
  validate constraint yolo_member_tokens_account_id_fkey;
