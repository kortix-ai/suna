-- Migration: audit_events_on_behalf_of
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
-- Tune these down further for large/hot tables; raise statement_timeout only
-- for an operation you've deliberately reasoned about (e.g. a NOT VALID
-- constraint's later VALIDATE, or a batched backfill with its own paging).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- REVIEW THE GENERATED SQL BELOW. drizzle-kit writes it from the diff between
-- kortix.ts and the snapshot; it knows the target shape, not how to reach it
-- without downtime. Check the same list `migrate:create` prints:
--   [ ] Bare NOT NULL added to an existing populated table (needs a backfill first).
--   [ ] Plain CREATE INDEX / DROP INDEX on an EXISTING table -- move it to
--       `pnpm migrate:create <slug> --concurrent`; it blocks writes here.
--   [ ] New FK/constraint on an existing table -- add NOT VALID, VALIDATE after.
--   [ ] A DROP/RENAME/ALTER ... TYPE the generator proposed from a STALE
--       snapshot. Delete anything already applied by an earlier migration.
--   [ ] Any DROP/RENAME/ALTER ... TYPE/DROP NOT NULL needs the enforced line:
-- mixed-version-safe: <why old code tolerates this change, or why it cannot still be running>
--   [ ] Any ALTER TYPE ... ADD VALUE needs:
-- enum-value-checked: <how you verified every env, including any faked baseline, has this value>

-- WHAT: one nullable column on kortix.audit_events and one function body.
--   * ADD COLUMN ... uuid with no default is a catalog-only change: no table
--     rewrite, no scan. It takes ACCESS EXCLUSIVE for milliseconds; the 2 s
--     lock_timeout above bounds the wait behind audit writers.
--   * No backfill. Every existing row stays NULL (true: no agent session had
--     an on-behalf-of human before 20260922135103135).
--   * No FK and no index, like every other actor column here: account and user
--     deletion must never rewrite forensic history.
--
-- WHY (spec docs/specs/2026-09-22-agents-as-principals.md §2): every audit row
-- an agent-session credential produces names the agent (agent_name/agent_id),
-- the human it acted on behalf of (this column), and the initiator.

ALTER TABLE "kortix"."audit_events" ADD COLUMN "on_behalf_of_user_id" uuid;--> statement-breakpoint

-- Hash-chain compatibility. `audit_prepare_event` digests `to_jsonb(NEW)`
-- minus `integrity_hash`. With the new column that JSON gains the key
-- "on_behalf_of_user_id", so re-verifying an OLD row (written before the
-- column existed) would now include `"on_behalf_of_user_id": null` and no
-- longer match its stored digest. Rule from this migration on: the key is
-- part of the digest only when it is NOT NULL. Every pre-existing row is NULL,
-- so its canonical form — and its stored integrity_hash — is unchanged, and a
-- verifier applies one rule to the whole chain.
--
-- The body is 20260826115800486_audit_prepare_event_single_upsert.sql
-- verbatim except the three `canonical` lines at the end. CREATE OR REPLACE
-- keeps the trigger's OID; no trigger is dropped or re-created.
-- ROLL BACK by re-running that migration's CREATE OR REPLACE block.
CREATE OR REPLACE FUNCTION kortix.audit_prepare_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = kortix, public, extensions
AS $$
DECLARE
  next_sequence bigint;
  previous_hash text;
  canonical jsonb;
BEGIN
  NEW.authoritative_source := COALESCE(NEW.authoritative_source, NEW.source, 'api');
  NEW.source := NEW.authoritative_source;

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

  -- Cover the complete persisted event. `on_behalf_of_user_id` joins the
  -- digest only when set, so rows written before the column existed keep
  -- their canonical form (see the header of this migration).
  canonical := to_jsonb(NEW) - 'integrity_hash';
  IF NEW.on_behalf_of_user_id IS NULL THEN
    canonical := canonical - 'on_behalf_of_user_id';
  END IF;
  NEW.integrity_hash := encode(extensions.digest(convert_to(canonical::text, 'UTF8'), 'sha256'), 'hex');

  IF NEW.session_id IS NOT NULL THEN
    UPDATE kortix.audit_session_sequences
       SET last_integrity_hash = NEW.integrity_hash
     WHERE session_id = NEW.session_id;
  END IF;
  RETURN NEW;
END;
$$;