-- Migration: usage_event_idempotency
-- Expand-only: nullable column; existing rows remain valid.
-- mixed-version-safe: old API versions ignore this column; new versions accept NULL rows.
set lock_timeout = '2s';
set statement_timeout = '30s';

alter table kortix.usage_events
  add column idempotency_key text;
