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
-- starts with a 48-bit millisecond timestamp (plus the microsecond inside it), so
-- new keys land on the right-most leaf, which is always cached. Rows written before
-- this migration keep their v4 id. Nothing reads event_id for ordering except the
-- (occurred_at, event_id) tie-break, which stays total on a mixed v4/v7 table.
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
  -- RFC 9562 UUIDv7 with sub-millisecond ordering (section 6.2, method 3):
  --   bits 0-47   unix epoch milliseconds
  --   bits 48-51  version 0111
  --   bits 52-63  the microsecond within the millisecond, scaled to 12 bits
  --   bits 64-65  variant 10, bits 66-127 random (kept from a v4 uuid)
  -- Rows of one multi-row INSERT are evaluated one after the other, a few
  -- microseconds apart, so ids sort in insert order inside a batch. A plain
  -- millisecond prefix would shuffle the rows that share a millisecond.
  -- One clock_timestamp() call feeds both fields (a second call could straddle
  -- a millisecond boundary and put the fraction before its own millisecond).
  SELECT encode(
    overlay(
      uuid_send(gen_random_uuid())
      PLACING substring(int8send(t.micros / 1000) FROM 3)
        || int2send((x'7000'::int | ((t.micros % 1000) * 4096 / 1000)::int)::smallint)
      FROM 1 FOR 8
    ),
    'hex'
  )::uuid
  FROM (SELECT (extract(epoch FROM clock_timestamp()) * 1000000)::bigint AS micros) AS t
$$;--> statement-breakpoint

ALTER TABLE "kortix"."audit_events" ALTER COLUMN "event_id" SET DEFAULT kortix.uuid_v7();
