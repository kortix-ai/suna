-- Migration: validate_sandbox_deadline_check
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- BOUNDED SANDBOX LIFETIME, step 5/7 -- promote the ceiling from NOT VALID to
-- enforced-for-every-row.
--
-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE, not ACCESS EXCLUSIVE:
-- concurrent reads and writes continue while it scans. Split into its own
-- migration so the scan can never share a transaction (and therefore a lock
-- window) with the ALTER that added the constraint.
--
-- It finds nothing to reject: every active/provisioning row was given an
-- in-range pair by the step-3 backfill, and every terminal row carries the
-- step-1 defaults (now(), now() + 20 minutes), whose difference is 20 minutes.
ALTER TABLE "kortix"."session_sandboxes"
  VALIDATE CONSTRAINT "session_sandboxes_deadline_bounded";
