-- Permission usage analytics. One row per (account, principal, action),
-- updated lazily as the IAM engine allows calls. Lets admins see what
-- privileges are actually used vs sitting dormant.

CREATE TABLE IF NOT EXISTS "kortix"."iam_action_usage" (
  "account_id"     uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE CASCADE,
  "principal_id"   uuid NOT NULL,
  "principal_kind" varchar(8) NOT NULL,
  "action"         varchar(128) NOT NULL,
  "call_count"     bigint NOT NULL DEFAULT 0,
  "first_used_at"  timestamptz NOT NULL DEFAULT now(),
  "last_used_at"   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("account_id", "principal_kind", "principal_id", "action")
);

CREATE INDEX IF NOT EXISTS "idx_iam_action_usage_account"
  ON "kortix"."iam_action_usage" ("account_id");
CREATE INDEX IF NOT EXISTS "idx_iam_action_usage_principal"
  ON "kortix"."iam_action_usage" ("account_id", "principal_kind", "principal_id");
CREATE INDEX IF NOT EXISTS "idx_iam_action_usage_action"
  ON "kortix"."iam_action_usage" ("account_id", "action");
