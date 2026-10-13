-- Migration: validate_app_images_status_check
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
--
-- Validation takes SHARE UPDATE EXCLUSIVE. It does not block normal reads or
-- writes. Every existing status value is one of the two the previous
-- constraint accepted, both of which the widened constraint accepts, so the
-- scan cannot fail.
set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."app_images"
  VALIDATE CONSTRAINT "app_images_status_check";
