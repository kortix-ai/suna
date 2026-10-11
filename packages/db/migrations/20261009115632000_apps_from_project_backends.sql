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
--    (`project`, as Backends were). Slug: the backend name; if a live App of
--    the project holds it, `<name>-convex`; if that is held too (by an App or
--    another backend of the project), `<name>-<first 8 hex of the id>`. A
--    remaining slug collision fails the migration: the conflict target is the
--    primary key only, so no row is skipped silently.
--    Budget: the 24/7 estimate rounded up to a whole dollar, as
--    `defaultAppBudgetUsd({ ...size, alwaysOn: true }, 'platinum')` computes it
--    at these list rates (apps/api/src/platform/providers/compute-rates.ts):
--    CPU 0.0000168 $/core-s, memory 0.0000054 $/GB-s, disk 0.000000036 $/GB-s,
--    730 h a month, capped at 100,000.
-- 2. Its machine fields become its `app_convex_instances` row.
-- 3. Each live App's `backends` names become `app_links` rows to the `convex`
--    App of that name in the same project. A name with no such App is dropped:
--    it never granted anything.
-- 4. The retired `backends` feature flag: a project that had it on, or owns a
--    live backend, gets `experimental.apps = true` (the only gate of the App
--    routes now), and the dead `experimental.backends` key leaves every project.
-- Deleted backends are not copied: their machines are already gone.
-- 20261009115639481 refuses to drop `project_backends` unless every live row
-- has its `app_convex_instances` row.
--
-- Idempotent: the App INSERT skips a backend whose App exists, the other
-- INSERTs are ON CONFLICT DO NOTHING, and the flag UPDATE matches no row on a
-- re-run.
--
-- backfill-safe: kortix.project_backends has never shipped to staging or prod
-- (0 rows there) and holds a handful of rows on dev (at most 10 per account by
-- the create cap). Every INSERT below reads and writes at most that many rows.
-- The flag UPDATE scans kortix.projects once and writes only the projects that
-- carry the dev-only `backends` key or own a backend: 0 rows on staging and
-- prod, a handful on dev. The row locks are held for milliseconds and no
-- writer queues behind them. The data step runs alone in this file: no DDL
-- lock is held with it.

INSERT INTO "kortix"."apps" (
  "app_id", "account_id", "project_id", "slug", "name", "kind", "route_key",
  "access_mode", "desired_state", "cpu_cores", "memory_gb", "disk_gb",
  "always_on", "monthly_budget_usd", "monthly_budget_explicit", "created_by", "created_at", "updated_at"
)
SELECT
  pb."backend_id", pb."account_id", pb."project_id",
  CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM "kortix"."apps" a
       WHERE a."project_id" = pb."project_id" AND a."slug" = pb."name" AND a."deleted_at" IS NULL
    ) THEN pb."name"
    WHEN NOT EXISTS (
      SELECT 1 FROM "kortix"."apps" a
       WHERE a."project_id" = pb."project_id" AND a."slug" = left(pb."name", 56) || '-convex' AND a."deleted_at" IS NULL
    ) AND NOT EXISTS (
      SELECT 1 FROM "kortix"."project_backends" other
       WHERE other."project_id" = pb."project_id" AND other."name" = left(pb."name", 56) || '-convex'
         AND other."deleted_at" IS NULL
    ) THEN left(pb."name", 56) || '-convex'
    ELSE left(pb."name", 54) || '-' || left(replace(pb."backend_id"::text, '-', ''), 8)
  END,
  pb."name", 'convex', substr(md5(random()::text || pb."backend_id"::text), 1, 16),
  'project', 'running', pb."cpu", pb."memory_gb", pb."disk_gb",
  true,
  least(ceil(round((pb."cpu" * 0.0000168 + pb."memory_gb" * 0.0000054 + pb."disk_gb" * 0.000000036) * 2628000, 2)), 100000),
  false, pb."created_by", pb."created_at", pb."updated_at"
FROM "kortix"."project_backends" pb
WHERE pb."deleted_at" IS NULL
  AND NOT EXISTS (SELECT 1 FROM "kortix"."apps" existing WHERE existing."app_id" = pb."backend_id")
ON CONFLICT ("app_id") DO NOTHING;

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
ON CONFLICT ("app_id") DO NOTHING;

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

UPDATE "kortix"."projects" p
   SET "metadata" = jsonb_set(
         coalesce(p."metadata", '{}'::jsonb),
         '{experimental}',
         (CASE WHEN jsonb_typeof(p."metadata" -> 'experimental') = 'object'
               THEN p."metadata" -> 'experimental' ELSE '{}'::jsonb END - 'backends')
         || CASE WHEN p."metadata" -> 'experimental' -> 'backends' = 'true'::jsonb
                   OR EXISTS (SELECT 1 FROM "kortix"."project_backends" pb
                               WHERE pb."project_id" = p."project_id" AND pb."deleted_at" IS NULL)
                 THEN '{"apps": true}'::jsonb ELSE '{}'::jsonb END
       )
 WHERE (jsonb_typeof(p."metadata" -> 'experimental') = 'object' AND p."metadata" -> 'experimental' ? 'backends')
    OR EXISTS (SELECT 1 FROM "kortix"."project_backends" pb
                WHERE pb."project_id" = p."project_id" AND pb."deleted_at" IS NULL
                  AND p."metadata" -> 'experimental' -> 'apps' IS DISTINCT FROM 'true'::jsonb);
