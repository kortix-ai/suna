-- Migration: add_provider_transitions_lease_epoch
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Monotonic lease-fencing token for provider_transitions. acquireLease bumps it
-- each time a drive takes ownership. Every drive-time state write and the
-- activation CAS use the caller's epoch. A stale drive cannot update the row
-- after its lease expires.
--
-- Purely additive: PostgreSQL 11+ adds a NOT NULL bigint with a constant default
-- without rewriting existing rows.
--   [x] New column has a constant DEFAULT. No backfill is required.

ALTER TABLE "kortix"."provider_transitions"
  ADD COLUMN "lease_epoch" bigint DEFAULT 0 NOT NULL;
