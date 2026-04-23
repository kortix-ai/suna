ALTER TABLE "kortix"."sandbox_members"
  ADD COLUMN IF NOT EXISTS "monthly_spend_cap_cents" integer;

ALTER TABLE "kortix"."sandbox_members"
  ADD COLUMN IF NOT EXISTS "current_period_cents" integer NOT NULL DEFAULT 0;

ALTER TABLE "kortix"."sandbox_members"
  ADD COLUMN IF NOT EXISTS "current_period_start" bigint;
