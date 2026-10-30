-- Migration: approval_expiry_backfill
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Give every pending approval written before expiry shipped a 24 h window from
-- now, so the backlog of undecided approvals expires instead of staying in
-- Review forever. A row an old replica writes with NULL during the rolling
-- deploy keeps NULL and never expires (accepted: recordExecution is the only
-- writer, and new code always sets expires_at).
-- backfill-safe: kortix.connector_calls, only unresolved pending_approval rows with expires_at NULL (the undecided approvals inbox, bounded by human backlog, not by call volume); this file has no DDL, so it takes row locks on those rows only, never a table lock; inserts and every other row stay writable; expires_at is not a status change, so the audit trigger returns early; re-runnable (expires_at IS NULL guard).

UPDATE kortix.connector_calls
   SET expires_at = now() + interval '24 hours'
 WHERE status = 'pending_approval'
   AND resolved_at IS NULL
   AND expires_at IS NULL;
