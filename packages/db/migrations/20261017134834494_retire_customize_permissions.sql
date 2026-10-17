-- Migration: retire_customize_permissions
--
-- CONTRACT half of retiring `project.customize.read` / `project.customize.write`.
-- The EXPAND half (20261003235127508_split_customize_into_topic_permissions)
-- granted the topic leaves to every role that held the old ones and removed
-- the old names from every `implies` array. Since then no API route asserts
-- either leaf, and the catalog loader drops rows the code does not know
-- (apps/api/src/iam/catalog.ts). This deletes the two grants and the two rows.
--
-- mixed-version-safe: deletes rows only, no DDL. No released API asserts
-- `project.customize.*`: `git grep` on origin/prod (v0.14.0, 94e52f5383) and
-- origin/staging finds no non-test reference. Agent manifests that still name
-- the leaves in `kortix_permissions` resolve through
-- DEPRECATED_KORTIX_PERMISSION_ALIASES (packages/manifest-schema), which never
-- reads these rows.
--
-- backfill-safe: kortix.role_permissions holds 2 matching rows locally (one
-- per leaf, on the project manager role) and a few on custom roles at most;
-- kortix.permissions holds 2. Catalog tables written only by migrations and
-- the role editor.

set lock_timeout = '2s';
set statement_timeout = '30s';

-- role_permissions references permissions ON DELETE RESTRICT: grants first.
DELETE FROM kortix.role_permissions
 WHERE action IN ('project.customize.read', 'project.customize.write');

DELETE FROM kortix.permissions
 WHERE action IN ('project.customize.read', 'project.customize.write');
