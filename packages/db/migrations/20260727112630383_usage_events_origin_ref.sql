-- Migration: usage_events_origin_ref
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Kortix-as-a-Backend per-end-user metering: which of the wrapper's END-USERS a
-- unit of spend belongs to. A server-derived copy of project_sessions.origin_ref,
-- resolved from the session when the usage event is emitted -- never read from a
-- request body. Denormalized rather than joined at read time because the legacy
-- router path takes session_id from the request (body / X-Session-ID header), so
-- joining usage_events.session_id -> project_sessions would let one end-user's
-- agent bill spend to a DIFFERENT end-user inside the same wrapper account.
--
-- Purely additive:
--   [x] Nullable text, no default -- metadata-only ADD COLUMN, no table rewrite,
--       no backfill. Rows written before this column exists stay NULL, which is
--       the documented "unattributed" value (also covers non-session spend such
--       as the model playground).
--   [x] No CHECK/FK/unique. The matching partial index ships as its own
--       CONCURRENTLY migration (index create cannot run in this transaction).

ALTER TABLE "kortix"."usage_events" ADD COLUMN "origin_ref" text;
