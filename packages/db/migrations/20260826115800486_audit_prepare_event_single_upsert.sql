-- Migration: audit_prepare_event_single_upsert
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- WHAT THIS CHANGES: one function body. No table, column, index, constraint,
-- enum, grant, or row is touched, so there is no DDL lock on kortix.audit_events
-- (5.5M rows on the Essentia self-host, 5.09M locally) and no backfill DML.
-- CREATE OR REPLACE FUNCTION takes a lock on the pg_proc row only; the trigger
-- keeps pointing at the same OID, so no trigger is dropped or re-created.
--
-- WHY (Essentia, 2026-08-26): POST /v1/projects/:p/sessions/:s/audit/events
-- returned 500 [57014] 445 times in 3 hours, each after exactly ~10s, while
-- pg_stat_activity showed `insert into "kortix"."audit_events"` blocking other
-- `insert into "kortix"."audit_events"` in chained pids.
--
-- The chain: this trigger allocates a per-session sequence and hash-chain head
-- out of kortix.audit_session_sequences, and PostgreSQL holds the resulting row
-- lock until the inserting transaction COMMITs. Every row of every batch for one
-- session therefore serializes -- which the append-only hash chain genuinely
-- requires -- but the OLD body paid for it THREE times per row:
--
--   1. INSERT INTO audit_session_sequences ... ON CONFLICT DO NOTHING
--        Issued on EVERY row, including the 99.99% where the session row already
--        exists. When another transaction holds that row it is also the FIRST
--        statement to block: reproduced locally against 5.09M rows, a waiter
--        died here at 10,004.957 ms with 57014
--        ("PL/pgSQL function audit_prepare_event() line 37 at SQL statement").
--   2. SELECT last_sequence + 1, last_integrity_hash ... FOR UPDATE
--   3. UPDATE ... SET last_sequence = next_sequence, last_integrity_hash = ...
--
-- The new body does the allocation as ONE upsert whose RETURNING yields the new
-- sequence and the PREVIOUS integrity hash in a single round trip (2 above is
-- gone, and 1 no longer runs as a separate arbiter probe). ON CONFLICT DO UPDATE
-- locks the conflicting row and re-reads it under EvalPlanQual, so
-- `last_sequence + 1` is applied to the committed value exactly as
-- `FOR UPDATE` + `UPDATE` did.
--
-- CONTRACT PRESERVED, byte for byte:
--   * first event of a session gets session_sequence = 1 and
--     integrity_previous_hash = NULL;
--   * event N gets session_sequence = N and integrity_previous_hash = the
--     integrity_hash of event N-1;
--   * a replayed (source_ledger, source_record_id, phase, source_revision)
--     still returns NULL before it can advance sequence or chain head;
--   * integrity_hash still covers the whole persisted row minus itself.
--
-- ROLL BACK by re-running 20260807221200000_centralized_audit_v2.sql's
-- CREATE OR REPLACE FUNCTION kortix.audit_prepare_event() block verbatim.

CREATE OR REPLACE FUNCTION kortix.audit_prepare_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = kortix, public, extensions
AS $$
DECLARE
  next_sequence bigint;
  previous_hash text;
  canonical text;
BEGIN
  NEW.authoritative_source := COALESCE(NEW.authoritative_source, NEW.source, 'api');
  NEW.source := NEW.authoritative_source;

  -- A BEFORE trigger runs before INSERT ... ON CONFLICT decides whether to
  -- discard a duplicate. Without this lock + existence check, a replayed
  -- source event advances the session sequence and hash head even though no
  -- audit row is inserted. Serialize one source identity, then skip its
  -- duplicate before touching the chain. The unique index remains the final
  -- invariant and covers writers that bypass this function in maintenance.
  IF NEW.source_ledger IS NOT NULL AND NEW.source_record_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(
      hashtextextended(
        NEW.source_ledger || chr(31) || NEW.source_record_id || chr(31) ||
          NEW.phase || chr(31) || COALESCE(NEW.source_revision, ''),
        0
      )
    );
    IF EXISTS (
      SELECT 1
        FROM kortix.audit_events
       WHERE source_ledger = NEW.source_ledger
         AND source_record_id = NEW.source_record_id
         AND phase = NEW.phase
         AND source_revision IS NOT DISTINCT FROM NEW.source_revision
    ) THEN
      RETURN NULL;
    END IF;
  END IF;

  IF NEW.session_id IS NOT NULL THEN
    -- ONE statement takes the session's row lock, advances the counter, and
    -- hands back the chain head that was there before it. RETURNING on the
    -- DO UPDATE branch reads the row AFTER last_sequence is bumped but BEFORE
    -- last_integrity_hash is rewritten below, which is exactly the pair the
    -- chain needs. The DO NOTHING/SELECT/UPDATE trio it replaces blocked three
    -- separate times per row on a contended session.
    INSERT INTO kortix.audit_session_sequences AS sequences
      (session_id, last_sequence, last_integrity_hash, updated_at)
    VALUES (NEW.session_id, 1, NULL, now())
    ON CONFLICT (session_id) DO UPDATE
      SET last_sequence = sequences.last_sequence + 1,
          updated_at = now()
    RETURNING sequences.last_sequence, sequences.last_integrity_hash
      INTO next_sequence, previous_hash;

    NEW.session_sequence := next_sequence;
    NEW.integrity_previous_hash := previous_hash;
  END IF;

  -- Cover the complete persisted event. A maintenance override can change a
  -- row, but it cannot preserve this digest without recomputing the chain.
  canonical := (to_jsonb(NEW) - 'integrity_hash')::text;
  NEW.integrity_hash := encode(extensions.digest(convert_to(canonical, 'UTF8'), 'sha256'), 'hex');

  IF NEW.session_id IS NOT NULL THEN
    UPDATE kortix.audit_session_sequences
       SET last_integrity_hash = NEW.integrity_hash
     WHERE session_id = NEW.session_id;
  END IF;
  RETURN NEW;
END;
$$;
