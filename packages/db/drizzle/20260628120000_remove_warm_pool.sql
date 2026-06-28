DELETE FROM "kortix"."session_sandboxes"
WHERE "pool_state" IN ('booting', 'parked', 'claiming', 'reap');
--> statement-breakpoint
DELETE FROM "kortix"."platform_settings"
WHERE "key" = 'warm_pool';
--> statement-breakpoint
UPDATE "kortix"."projects"
SET "metadata" = ("metadata" - 'warm_pool' - 'warm_pool_templates' - 'warm_pool_seen_at'),
    "updated_at" = now()
WHERE "metadata" ? 'warm_pool'
   OR "metadata" ? 'warm_pool_templates'
   OR "metadata" ? 'warm_pool_seen_at';
--> statement-breakpoint
DROP INDEX IF EXISTS "kortix"."idx_session_sandboxes_pool";
--> statement-breakpoint
ALTER TABLE "kortix"."session_sandboxes" DROP COLUMN IF EXISTS "pool_state";
--> statement-breakpoint
DROP TABLE IF EXISTS "kortix"."warm_pool_presence";
--> statement-breakpoint
DROP TABLE IF EXISTS "kortix"."pool_sandboxes";
--> statement-breakpoint
DROP TABLE IF EXISTS "kortix"."pool_resources";
--> statement-breakpoint
UPDATE "kortix"."sandboxes"
SET "status" = 'archived'
WHERE "status" = 'pooled';
--> statement-breakpoint
ALTER TYPE "kortix"."sandbox_status" RENAME TO "sandbox_status_old";
--> statement-breakpoint
CREATE TYPE "kortix"."sandbox_status" AS ENUM (
  'provisioning',
  'active',
  'stopped',
  'archived',
  'error'
);
--> statement-breakpoint
ALTER TABLE "kortix"."sandboxes" ALTER COLUMN "status" DROP DEFAULT;
--> statement-breakpoint
ALTER TABLE "kortix"."sandboxes"
  ALTER COLUMN "status" TYPE "kortix"."sandbox_status"
  USING "status"::text::"kortix"."sandbox_status";
--> statement-breakpoint
ALTER TABLE "kortix"."sandboxes" ALTER COLUMN "status" SET DEFAULT 'provisioning';
--> statement-breakpoint
DROP TYPE "kortix"."sandbox_status_old";
