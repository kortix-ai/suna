-- Session policy + activity tracking. Per-account ceiling on session
-- age (max lifetime) and idle gap (idle timeout), enforced at request
-- time by a per-account middleware. Admins can also force-logout a
-- specific session.

ALTER TABLE "kortix"."accounts"
  ADD COLUMN IF NOT EXISTS "session_max_lifetime_minutes" integer,
  ADD COLUMN IF NOT EXISTS "session_idle_timeout_minutes" integer;

CREATE TABLE IF NOT EXISTS "kortix"."account_session_activity" (
  "account_id"     uuid NOT NULL REFERENCES "kortix"."accounts"("account_id") ON DELETE CASCADE,
  "user_id"        uuid NOT NULL,
  "session_id"     uuid NOT NULL,
  "first_seen_at"  timestamptz NOT NULL DEFAULT now(),
  "last_seen_at"   timestamptz NOT NULL DEFAULT now(),
  "revoked_at"     timestamptz,
  "revoked_reason" varchar(32),
  "revoked_by"     uuid,
  "ip"             text,
  "user_agent"     text,
  PRIMARY KEY ("account_id", "user_id", "session_id")
);

CREATE INDEX IF NOT EXISTS "idx_account_session_activity_account"
  ON "kortix"."account_session_activity" ("account_id");
CREATE INDEX IF NOT EXISTS "idx_account_session_activity_user"
  ON "kortix"."account_session_activity" ("account_id", "user_id");
