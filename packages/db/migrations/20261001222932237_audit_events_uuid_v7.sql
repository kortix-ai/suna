-- Migration: audit_events_uuid_v7
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- WHAT: one function and one column default. No rewrite, no scan, no index build.
--   * CREATE OR REPLACE FUNCTION kortix.uuid_v7(): takes no lock on any table.
--   * ALTER COLUMN event_id SET DEFAULT: catalog-only. It takes ACCESS EXCLUSIVE
--     on kortix.audit_events for the time it takes to update one pg_attrdef row
--     (milliseconds). The 2 s lock_timeout bounds the wait behind in-flight audit
--     INSERTs (<= 10 s statement_timeout each). On 55P03 re-run the failed job:
--     never raise the timeout (learnings: "Retry a hot-table ADD COLUMN").
--
-- WHY: the pkey was UUIDv4, so every audit INSERT touched a random leaf of a 5.7 GB
-- index against a 4 GB shared_buffers (0.95 cold block reads per row). A UUIDv7
-- starts with a 48-bit millisecond timestamp, so new keys land on the right-most
-- leaf, which is always cached. Rows written before this migration keep their v4 id.
-- Nothing reads event_id for ordering except the (occurred_at, event_id) tie-break,
-- which stays total for a mixed v4/v7 table because the sort is on the uuid value.
--
-- Mixed-version deploy: old code never names event_id in an INSERT, so it picks up
-- the new default as soon as this commits. New code needs the default to exist, and
-- migrations run before the new code serves.
--
-- ROLL BACK: no down migration (repo policy). To go back, a new forward migration
-- sets the default to gen_random_uuid(); rows already written keep their v7 id.
CREATE OR REPLACE FUNCTION kortix.uuid_v7()
RETURNS uuid
LANGUAGE sql
VOLATILE
PARALLEL SAFE
AS $$
  -- A random v4 uuid with its first 48 bits replaced by unix epoch milliseconds,
  -- then version bits 0111 (bits 52 and 53 set on top of v4's 0100) and the
  -- RFC 4122 variant (10xx) it already carries.
  SELECT encode(
    set_bit(
      set_bit(
        overlay(
          uuid_send(gen_random_uuid())
          PLACING substring(int8send(floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint) FROM 3)
          FROM 1 FOR 6
        ),
        52, 1
      ),
      53, 1
    ),
    'hex'
  )::uuid
$$;--> statement-breakpoint

ALTER TABLE "kortix"."audit_events" ALTER COLUMN "event_id" SET DEFAULT kortix.uuid_v7();
