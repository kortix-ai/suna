-- Migration: validate_account_model_preferences_project_id_fk
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Expand step 2/5: validate the NOT VALID FK added in the previous migration.
-- VALIDATE CONSTRAINT takes only a SHARE UPDATE EXCLUSIVE lock (does not block
-- reads/writes) and every existing row already satisfies it trivially (all
-- have project_id NULL), so this completes near-instantly.

ALTER TABLE "kortix"."account_model_preferences"
  VALIDATE CONSTRAINT "account_model_preferences_project_id_projects_project_id_fk";
