-- Per-event dedup for Stripe webhooks. Insert with ON CONFLICT DO NOTHING at
-- the top of every webhook handler — if the insert reports zero new rows the
-- event has already been processed and the handler returns immediately.
--
-- The credit_ledger.stripe_event_id unique constraint already dedupes grants
-- (atomic_add_credits uses it); this table covers all the OTHER webhook types
-- (customer.subscription.updated / .deleted, invoice.* events, etc.) where
-- re-delivery would otherwise double-apply state changes.

CREATE TABLE IF NOT EXISTS kortix.stripe_webhook_events_processed (
  event_id     text        PRIMARY KEY,
  event_type   text        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);

-- Drop the oldest 1-month-rolling window so the table doesn't grow unbounded.
-- Run from a cron / scheduled job if you want; nothing breaks if it never runs.
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_processed_at
  ON kortix.stripe_webhook_events_processed (processed_at);
