-- Migration: rbac_validate_assignment_scope_fk
--
-- Expand step 2/2 for the cascade the cutover moved onto the canonical store.
-- 20260819160100000_rbac_cutover_views.sql added
-- `role_assignments.scope_id -> projects.project_id ON DELETE CASCADE` as
-- NOT VALID, so the ADD took a catalog update and no table scan;
-- 20260819160000000_rbac_cutover_backfill.concurrent.ts purged the orphaned
-- project-scope assignments that would have failed it. This file validates it.
--
-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE on kortix.role_assignments
-- and ROW SHARE on kortix.projects. Neither blocks a read or an ordinary write;
-- it only excludes concurrent DDL and VACUUM. The scan is one seq scan of
-- role_assignments (37,425 rows locally) with an index probe per row into the
-- projects primary key.
--
-- mixed-version-safe: adds no column, drops nothing, renames nothing. The
-- constraint already governs every INSERT and UPDATE from the moment the
-- previous migration ran; validating it only marks the pre-existing rows as
-- checked. No deployed version, old or new, can observe a difference.
--
-- backfill-safe: no DML.

set lock_timeout = '3s';
set statement_timeout = '300s';

ALTER TABLE kortix.role_assignments
  VALIDATE CONSTRAINT role_assignments_scope_id_projects_project_id_fk;
