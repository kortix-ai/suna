-- Migration: validate_app_deployments_deleted_status
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
--
-- Validation takes SHARE UPDATE EXCLUSIVE. It does not block normal reads or
-- writes. Every existing status value is one of the eight the previous
-- constraint accepted, all of which the widened constraint accepts, so the
-- scan cannot fail.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."app_deployments"
  VALIDATE CONSTRAINT "app_deployments_status_check";
