-- Migration: drop_project_backends
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- Kortix Backends become Apps of kind `convex` (contract step). The data
-- step (20261009115632000) copied every live backend into `apps` +
-- `app_convex_instances` and every `apps.backends` name into `app_links`.
--
-- mixed-version-safe: `project_backends` and `apps.backends` arrived with
-- #9264 (20261008200000000..20261008200007000), which has never reached
-- staging or prod. There the old code (v0.13.52) never reads either, so the
-- drop is invisible to it. On dev, a replica still on the old code answers
-- 500 on the retired /backends routes and on App reads until the rollout
-- replaces it (minutes); dev holds a handful of backends and no customer data.
-- CASCADE drops only the table's own FK to `projects`.

-- squawk-ignore ban-drop-table
DROP TABLE "kortix"."project_backends" CASCADE;--> statement-breakpoint
-- squawk-ignore ban-drop-column
ALTER TABLE "kortix"."apps" DROP COLUMN "backends";
