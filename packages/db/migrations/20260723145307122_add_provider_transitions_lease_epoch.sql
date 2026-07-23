-- Migration: add_provider_transitions_lease_epoch
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Monotonic lease-fencing token for provider_transitions. acquireLease bumps it
-- (COALESCE(lease_epoch,0)+1) each time a drive takes ownership; every drive-time
-- state write and the activation CAS are then predicated on the caller's epoch, so
-- a zombie drive whose 10-min lease expired (a 30-40 min Platinum build outruns the
-- TTL) is fenced out -- its writes match 0 rows and it ceases instead of clobbering
-- a fresh owner's state (false 'failed' on a succeeded switch, dup provider load).
--
-- Purely additive: a bigint with a constant DEFAULT 0, so ADD COLUMN is a
-- metadata-only change on PG11+ (no table rewrite, no backfill) even though it is
-- NOT NULL -- every existing row reads 0. Old code ignores the column; new code
-- treats a defaulted 0 as "no epoch yet" via COALESCE, and the first acquireLease
-- bumps it to 1. Nothing existing is dropped/renamed/retyped, so no
-- mixed-version-safe / enum-value-checked annotation is required.
--   [x] New column has a constant DEFAULT -- no table rewrite, no backfill.

ALTER TABLE "kortix"."provider_transitions"
  ADD COLUMN "lease_epoch" bigint DEFAULT 0 NOT NULL;
