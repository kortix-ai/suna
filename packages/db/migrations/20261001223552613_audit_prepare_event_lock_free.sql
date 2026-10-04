-- Migration: audit_prepare_event_lock_free
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- WHAT: one function body (CREATE OR REPLACE FUNCTION kortix.audit_prepare_event).
--   CREATE OR REPLACE takes no lock on kortix.audit_events and keeps the trigger's
--   OID, so no ACCESS EXCLUSIVE lock and no table scan. In-flight statements finish
--   with the body they started with; the next INSERT runs the new body.
--
-- WHY: the old body ran, for every audit row,
--   (1) pg_advisory_xact_lock on the source tuple,
--   (2) an EXISTS probe of idx_audit_events_source_phase (a random-key index),
--   (3) an upsert of the session's row in kortix.audit_session_sequences, a row lock
--       held to COMMIT (every other writer of that session queued behind it),
--   (4) to_jsonb(NEW) + sha256 into integrity_hash,
--   (5) a second UPDATE of the sequence row to store the chain head.
-- Under cold-cache IO latency the lock turned a 5 s INSERT into a queue of 10 s
-- statement timeouts (the ingest 503s). Nothing ever verified the chain: it was only
-- displayed and exported. Owner decision: the chain and the per-session lock leave
-- the ingest path; S3 Object Lock on the archive is the tamper evidence.
--
-- The new body only sets the source columns. Idempotency does not need a trigger:
-- every writer that replays a source record uses INSERT ... ON CONFLICT DO NOTHING,
-- and the unique partial index idx_audit_events_source_phase is the single check,
-- evaluated by the INSERT itself without an advisory lock. session_sequence,
-- integrity_previous_hash and integrity_hash stay NULL for new rows. The columns,
-- the unique index and the kortix.audit_session_sequences table stay as they are,
-- so existing rows keep their values and a rollback needs no schema work.
--
-- Mixed-version deploy: old code never calls this function directly. Old writers
-- (queue, ingest route, reconciliation, triggers) already use ON CONFLICT DO NOTHING.
-- The one writer without it, runAuditedTransaction, sets no source tuple, so it
-- never relied on the trigger's duplicate skip. Old readers order the session log
-- by session_sequence; NULLs sort last, in event_id order, which is creation order.
--
-- ROLL BACK: no down migration (repo policy). Re-apply the body of
-- 20260930024523072_audit_events_credential_kind.sql in a new forward migration. Rows
-- written in between keep NULL sequence and hashes; that is a gap, not corruption.
CREATE OR REPLACE FUNCTION kortix.audit_prepare_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = kortix, public, extensions
AS $$
BEGIN
  NEW.authoritative_source := COALESCE(NEW.authoritative_source, NEW.source, 'api');
  NEW.source := NEW.authoritative_source;
  RETURN NEW;
END;
$$;
