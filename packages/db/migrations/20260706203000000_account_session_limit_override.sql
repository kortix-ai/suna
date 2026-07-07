-- Up Migration
--
-- Per-account concurrent-session override. The cap on simultaneously running
-- project sessions is tier-driven (TierConfig.concurrentSessionLimit in
-- apps/api/src/billing/services/tiers.ts). This column lets an operator raise
-- (or lower) the cap for a single account without changing its plan tier —
-- e.g. enterprise deals or internal dogfood accounts. NULL (the default)
-- means "no override": the account's tier decides. Resolution lives in
-- resolveAccountSessionLimit (apps/api/src/shared/account-limits.ts).

ALTER TABLE "kortix"."credit_accounts"
  ADD COLUMN IF NOT EXISTS "max_concurrent_sessions" integer;
--> statement-breakpoint

-- Seed: effectively-uncapped override for the internal Kortix dogfood account.
-- Upsert (mirrors setDemoEnterprise) so it applies even on environments where
-- the account has no credit_accounts row yet; all other columns keep their
-- schema defaults there. Idempotent — re-running just re-sets the same value.
INSERT INTO "kortix"."credit_accounts" ("account_id", "max_concurrent_sessions")
VALUES ('3b1fc472-a90e-404f-823f-ca42f6b32e4d', 100000)
ON CONFLICT ("account_id")
DO UPDATE SET
  "max_concurrent_sessions" = EXCLUDED."max_concurrent_sessions",
  "updated_at" = now();
