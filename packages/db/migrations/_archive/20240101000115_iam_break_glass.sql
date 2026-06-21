-- Break-glass emergency super-admin grants. Time-bounded; engine treats
-- the holder as super-admin during the active window. Activation +
-- revocation + expiry hit the audit log so SOC reviews can show "who
-- broke glass, when, why".

CREATE TABLE IF NOT EXISTS "kortix"."iam_break_glass_grants" (
  "grant_id"     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "account_id"   uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE CASCADE,
  "user_id"      uuid NOT NULL,
  "reason"       text NOT NULL,
  "activated_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at"   timestamptz NOT NULL,
  "revoked_at"   timestamptz,
  "revoked_by"   uuid
);

CREATE INDEX IF NOT EXISTS "idx_iam_break_glass_account"
  ON "kortix"."iam_break_glass_grants" ("account_id");
CREATE INDEX IF NOT EXISTS "idx_iam_break_glass_active"
  ON "kortix"."iam_break_glass_grants" ("account_id", "user_id", "expires_at");
