-- Migration: apps_from_project_backends
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Kortix Backends become Apps of kind `convex` (data step).
--
-- 1. Each live `project_backends` row becomes an App with the SAME id
--    (app_id = backend_id), so its Kortix hosts (derived from the id), its
--    compute windows (`sandbox_id` = the id) and its token issuer stay
--    unchanged. kind `convex`, slug and name = the backend name, same project
--    and account, size copied, always on, visible to every project member
--    (`project`, as Backends were). A name a live App of the project already
--    uses gets the suffix `-convex`.
-- 2. Its machine fields become its `app_convex_instances` row.
-- 3. Each live App's `backends` names become `app_links` rows to the `convex`
--    App of that name in the same project. A name with no such App is dropped:
--    it never granted anything.
-- Deleted backends are not copied: their machines are already gone.
--
-- Idempotent: every INSERT is ON CONFLICT DO NOTHING, so a re-run adds nothing.
--
-- backfill-safe: kortix.project_backends has never shipped to staging or prod
-- (0 rows there) and holds a handful of rows on dev (at most 10 per account by
-- the create cap). Every INSERT below reads and writes at most that many rows,
-- so the row locks are held for milliseconds and no writer queues behind them.
-- The data step runs alone in this file: no DDL lock is held with it.

INSERT INTO "kortix"."apps" (
  "app_id", "account_id", "project_id", "slug", "name", "kind", "route_key",
  "access_mode", "desired_state", "cpu_cores", "memory_gb", "disk_gb",
  "always_on", "monthly_budget_explicit", "created_by", "created_at", "updated_at"
)
SELECT
  pb."backend_id", pb."account_id", pb."project_id",
  CASE WHEN EXISTS (
    SELECT 1 FROM "kortix"."apps" a
     WHERE a."project_id" = pb."project_id" AND a."slug" = pb."name" AND a."deleted_at" IS NULL
  ) THEN left(pb."name", 56) || '-convex' ELSE pb."name" END,
  pb."name", 'convex', substr(md5(random()::text || pb."backend_id"::text), 1, 16),
  'project', 'running', pb."cpu", pb."memory_gb", pb."disk_gb",
  true, false, pb."created_by", pb."created_at", pb."updated_at"
FROM "kortix"."project_backends" pb
WHERE pb."deleted_at" IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO "kortix"."app_convex_instances" (
  "app_id", "status", "provider", "external_id", "url", "site_url", "admin_key_enc",
  "auth_key_enc", "auth_issuer", "template", "created_at", "updated_at", "metadata"
)
SELECT
  pb."backend_id", pb."status", pb."provider", pb."external_id", pb."url", pb."site_url",
  pb."admin_key_enc", pb."auth_key_enc", pb."auth_issuer", pb."template",
  pb."created_at", pb."updated_at", pb."metadata"
FROM "kortix"."project_backends" pb
JOIN "kortix"."apps" a ON a."app_id" = pb."backend_id" AND a."kind" = 'convex'
WHERE pb."deleted_at" IS NULL
ON CONFLICT DO NOTHING;

INSERT INTO "kortix"."app_links" ("app_id", "uses_app_id")
SELECT DISTINCT a."app_id", used."app_id"
FROM "kortix"."apps" a
CROSS JOIN LATERAL unnest(a."backends") AS listed("name")
JOIN "kortix"."apps" used
  ON used."project_id" = a."project_id"
 AND used."kind" = 'convex'
 AND used."name" = listed."name"
 AND used."deleted_at" IS NULL
WHERE a."deleted_at" IS NULL
  AND a."app_id" <> used."app_id"
ON CONFLICT DO NOTHING;
