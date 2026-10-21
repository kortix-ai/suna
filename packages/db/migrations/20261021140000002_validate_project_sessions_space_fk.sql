-- Migration: validate_project_sessions_space_fk
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
--
-- Validates the FK 20261021140000000_project_spaces added NOT VALID.
-- The production runner commits each migration file in its own transaction
-- (packages/db/scripts/migration-target.ts RUNNER_TRANSACTION_MODE,
-- singleTransaction: false), so the ADD commits before this VALIDATE starts
-- whatever the order. The timestamp sorts after
-- 20261021140000001_project_sessions_space_index.concurrent.ts only to keep
-- the three files in authoring order.
-- VALIDATE takes SHARE UPDATE EXCLUSIVE: normal reads and writes continue.
-- Every stored row passes: space_id was added as a null column, and a null
-- satisfies the FK.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."project_sessions" VALIDATE CONSTRAINT "project_sessions_space_fk";
