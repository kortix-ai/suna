-- Migration: capture_displays
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Multi-display Kortix Capture: one screen item per display. Nullable and
-- additive (a constant default is metadata-only), so code that does not know
-- these columns keeps working. ADD COLUMN on the partitioned timeline_frames
-- reaches every partition.

ALTER TABLE "kortix"."timeline_frames" ADD COLUMN "display_id" bigint;--> statement-breakpoint
ALTER TABLE "kortix"."timeline_frames" ADD COLUMN "focused" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "kortix"."timeline_chunks" ADD COLUMN "display_id" bigint;--> statement-breakpoint
ALTER TABLE "kortix"."timeline_chunks" ADD COLUMN "display" jsonb;
