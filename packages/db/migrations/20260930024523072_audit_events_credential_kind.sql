-- Migration: audit_events_credential_kind
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- WHAT: two nullable columns on kortix.audit_events and one function body.
--   * ADD COLUMN ... text with no default is catalog-only: no rewrite, no scan.
--     ACCESS EXCLUSIVE is held for milliseconds; the 2 s lock_timeout bounds
--     the wait behind audit writers (retry on 55P03, never raise the timeout).
--   * No backfill, no index, no FK: every existing row stays NULL, and
--     audit history must never be rewritten.
--
-- WHY: `client_reported_source` came from the self-reported X-Kortix-Client
-- header, so any caller could label itself "web". `credential_kind` and
-- `credential_id` record what the API authenticated: the credential class and
-- its identifier (token id, OAuth client id, session id, key id). Never a secret.
-- Old code never names these columns in its INSERT, so a mixed-version deploy is safe.
--
-- ROLL BACK: no down migration (repo policy). Roll app code back; the columns
-- stay NULL and harmless. To drop them, write a new forward migration.
ALTER TABLE "kortix"."audit_events" ADD COLUMN "credential_kind" text;--> statement-breakpoint
ALTER TABLE "kortix"."audit_events" ADD COLUMN "credential_id" text;--> statement-breakpoint

-- Hash-chain compatibility, same rule as 20260922144740453: `audit_prepare_event`
-- digests `to_jsonb(NEW)` minus `integrity_hash`. The two new keys join the
-- digest only when NOT NULL, so every pre-existing row keeps its canonical form
-- and stored digest. The body is 20260922144740453_audit_events_on_behalf_of.sql
-- verbatim except the `canonical` lines. CREATE OR REPLACE keeps the trigger OID.
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

  canonical := to_jsonb(NEW) - 'integrity_hash';
  IF NEW.on_behalf_of_user_id IS NULL THEN
    canonical := canonical - 'on_behalf_of_user_id';
  END IF;
  IF NEW.credential_kind IS NULL THEN
    canonical := canonical - 'credential_kind';
  END IF;
  IF NEW.credential_id IS NULL THEN
    canonical := canonical - 'credential_id';
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
