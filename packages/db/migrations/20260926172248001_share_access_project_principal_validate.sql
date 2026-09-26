-- Migration: share_access_project_principal_validate
--
-- Step 2/2 for 20260926172248000_share_access_project_principal.sql, which
-- added both CHECKs NOT VALID. They already govern every INSERT and UPDATE;
-- this marks the pre-existing rows as checked. No existing row has
-- principal_type 'project', and every existing principal_type is in the new
-- list, so neither validation can fail.
--
-- VALIDATE CONSTRAINT takes SHARE UPDATE EXCLUSIVE on kortix.role_assignments.
-- It blocks no read and no ordinary write; it excludes only concurrent DDL and
-- VACUUM, for one sequential scan of the table.
--
-- mixed-version-safe: adds no column, drops nothing, renames nothing. No
-- deployed version, old or new, can observe a difference.
--
-- backfill-safe: no DML.

set lock_timeout = '3s';
set statement_timeout = '300s';

ALTER TABLE kortix.role_assignments
  VALIDATE CONSTRAINT role_assignments_principal_type_check;

ALTER TABLE kortix.role_assignments
  VALIDATE CONSTRAINT role_assignments_project_principal_shape_check;
