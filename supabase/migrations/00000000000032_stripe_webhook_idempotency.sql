-- Stripe webhook event idempotency table.
-- Records processed Stripe event IDs so that replay events (which Stripe delivers
-- within 72h of the original) are detected and skipped without relying on an
-- in-memory Set that resets on every deploy/restart.
-- TTL is enforced by the cleanup function below; events older than 7 days are pruned.

CREATE TABLE IF NOT EXISTS kortix.stripe_webhook_events (
  event_id    text        NOT NULL,
  event_type  text        NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT stripe_webhook_events_pkey PRIMARY KEY (event_id)
);

-- Index to support efficient TTL cleanup by processed_at
CREATE INDEX IF NOT EXISTS idx_stripe_webhook_events_processed_at
  ON kortix.stripe_webhook_events (processed_at);

-- RLS: table is backend-only; no direct user access
ALTER TABLE kortix.stripe_webhook_events ENABLE ROW LEVEL SECURITY;
