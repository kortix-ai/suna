-- Migration: validate_project_trigger_runtime_space_fk
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
--
-- Validates the FK 20261023090000004_project_trigger_runtime_space added NOT
-- VALID. The production runner commits each migration file in its own
-- transaction (packages/db/scripts/migration-target.ts RUNNER_TRANSACTION_MODE,
-- singleTransaction: false), so the ADD commits before this VALIDATE starts.
-- VALIDATE takes SHARE UPDATE EXCLUSIVE: normal reads and writes continue.
-- Every stored row passes: space_id was added as a null column, and a null
-- satisfies the FK.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."project_trigger_runtime" VALIDATE CONSTRAINT "project_trigger_runtime_space_fk";
