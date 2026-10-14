-- Migration: capture_health_notification_kinds
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Widen the inbox kind check by two Capture fleet-health kinds. The check only
-- gets looser, so a row any older replica writes stays valid.
-- mixed-version-safe: the new check admits every kind the old check admitted; old code never writes the new kinds.
ALTER TABLE "kortix"."notifications" DROP CONSTRAINT "notifications_kind";--> statement-breakpoint
ALTER TABLE "kortix"."notifications" ADD CONSTRAINT "notifications_kind" CHECK ("kortix"."notifications"."kind" IN ('turn_done', 'turn_error', 'question', 'permission', 'shared', 'automation_failed', 'automation_recovered', 'capture_device_down', 'capture_device_recovered')) NOT VALID;
-- Existing rows already satisfy the looser check; it binds every new row, so no VALIDATE scan runs.
