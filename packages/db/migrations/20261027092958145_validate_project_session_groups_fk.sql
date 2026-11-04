-- Migration: validate_project_session_groups_fk
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
--
-- Validates project_sessions_group_fk, added NOT VALID by
-- 20261027092958143_project_session_groups. The production runner commits each
-- migration file in its own transaction (packages/db/scripts/migration-target.ts
-- RUNNER_TRANSACTION_MODE, singleTransaction: false), so the ADD commits before
-- this VALIDATE starts. VALIDATE takes SHARE UPDATE EXCLUSIVE: normal reads and
-- writes continue. Every stored row passes: group_id was added as a null
-- column, and a null satisfies the FK.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."project_sessions" VALIDATE CONSTRAINT "project_sessions_group_fk";
