-- Migration: revoke_public_transcript_shares
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- backfill-safe: data only, no DDL, so no ACCESS EXCLUSIVE lock is held. The
-- UPDATE touches only the rows that name a revoked feature — live transcript
-- shares — a bounded set in prod (transcript sharing shipped 2026-10; every
-- row already carries an index on session/token).

-- Public transcript sharing was removed (KRTX-2358): the API rejects new
-- transcript shares and the anonymous transcript read routes are gone. Every
-- legacy transcript share row must stop looking live, or the share list shows
-- a "live" link whose URL no longer serves anything. Revoking (not deleting)
-- keeps the audit trail and renders the rows as Revoked in the share list.
UPDATE kortix.project_session_public_shares
   SET revoked_at = now(),
       updated_at = now()
 WHERE resource_type = 'transcript'
   AND revoked_at IS NULL;
