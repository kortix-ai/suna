-- Migration: validate_trigger_run_replay_of
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
--
-- Validates the FK 20261016172509389_trigger_run_history added NOT VALID.
-- VALIDATE takes SHARE UPDATE EXCLUSIVE: normal reads and writes continue.
-- Every stored row passes: replay_of was added as a null column, and a null
-- satisfies the FK.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."project_trigger_executions" VALIDATE CONSTRAINT "project_trigger_exec_replay_of_fk";
