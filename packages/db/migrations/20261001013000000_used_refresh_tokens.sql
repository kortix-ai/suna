-- One claim per refresh token across all API replicas. Digest only; no bearer stored.
-- Expired claims may be pruned after 90 days; never prune tokens that might remain valid.
set lock_timeout = '2s';
set statement_timeout = '30s';
CREATE TABLE kortix.used_refresh_tokens (
  token_hash text PRIMARY KEY,
  expires_at timestamptz NOT NULL
);
