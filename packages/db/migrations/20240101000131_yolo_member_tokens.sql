-- Billing v2 — per-member KORTIX YOLO tokens.
-- One row per (user_id, account_id) combination. Token plaintext is returned
-- once at mint time and never stored — we keep only the hash + a short prefix
-- for lookup. The plaintext is fetched from an in-memory/KV cache during
-- sandbox bootstrap; cache miss forces a rotation.
--
-- Rationale: spec calls for YOLO usage to be attributed PER MEMBER, with the
-- token injected into the sandbox as a "hardcoded-ish" secret that's always
-- present. Replaces the previous behaviour of injecting the account-wide
-- service key as KORTIX_YOLO_API_KEY (apps/api/src/platform/services/sandbox-auth.ts).

CREATE TABLE IF NOT EXISTS kortix.yolo_member_tokens (
  user_id       uuid NOT NULL,
  account_id    uuid NOT NULL REFERENCES kortix.accounts(account_id) ON DELETE CASCADE,
  token_prefix  varchar(16)  NOT NULL,    -- first N chars of the token, for lookup display
  token_hash    varchar(128) NOT NULL,    -- sha256 hex of the full token
  created_at    timestamptz  NOT NULL DEFAULT now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,

  PRIMARY KEY (user_id, account_id)
);

-- Fast prefix lookup when the sandbox calls back to the API with its token.
CREATE INDEX IF NOT EXISTS idx_yolo_member_tokens_prefix
  ON kortix.yolo_member_tokens (token_prefix)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_yolo_member_tokens_account
  ON kortix.yolo_member_tokens (account_id);
