-- Migration: account_secret_project_fk_validate
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Validate after the previous migration committed its NOT VALID foreign key.
ALTER TABLE "kortix"."account_secret_resources" VALIDATE CONSTRAINT "account_secret_resources_project_id_projects_project_id_fk";
