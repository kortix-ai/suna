-- Optional hard expiry on iam_policies. The engine filters expired
-- rows out of every SELECT so the policy stops applying the moment
-- the clock crosses the timestamp; a cleanup job is optional but
-- recommended for tidy lists.

ALTER TABLE "kortix"."iam_policies"
  ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;

-- Partial index speeds up the engine's "drop expired" filter when the
-- table grows large. Only indexes rows that actually have an expiry.
CREATE INDEX IF NOT EXISTS "idx_iam_policies_expires_at"
  ON "kortix"."iam_policies" ("expires_at")
  WHERE "expires_at" IS NOT NULL;
