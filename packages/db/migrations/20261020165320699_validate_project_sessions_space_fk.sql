-- Migration: validate_project_sessions_space_fk
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
--
-- Validates the FK 20261020165303440_project_spaces added NOT VALID.
-- VALIDATE takes SHARE UPDATE EXCLUSIVE: normal reads and writes continue.
-- Every stored row passes: space_id was added as a null column, and a null
-- satisfies the FK.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."project_sessions" VALIDATE CONSTRAINT "project_sessions_space_fk";
