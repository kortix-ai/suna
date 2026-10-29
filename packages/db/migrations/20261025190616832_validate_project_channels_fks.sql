-- Migration: validate_project_channels_fks
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
--
-- Validates the two FKs added NOT VALID by 20261025190616828_project_channels
-- (project_sessions_space_fk) and 20261025190616830_project_trigger_runtime_space
-- (project_trigger_runtime_space_fk). The production runner commits each
-- migration file in its own transaction (packages/db/scripts/migration-target.ts
-- RUNNER_TRANSACTION_MODE, singleTransaction: false), so each ADD commits
-- before this VALIDATE starts. VALIDATE takes SHARE UPDATE EXCLUSIVE: normal
-- reads and writes continue. Every stored row passes: space_id was added as a
-- null column, and a null satisfies the FK.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."project_sessions" VALIDATE CONSTRAINT "project_sessions_space_fk";--> statement-breakpoint
ALTER TABLE "kortix"."project_trigger_runtime" VALIDATE CONSTRAINT "project_trigger_runtime_space_fk";
