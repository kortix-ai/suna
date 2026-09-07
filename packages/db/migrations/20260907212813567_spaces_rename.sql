-- Migration: spaces_rename
--
-- "Subproject" became "Space" (2026-09-07, product naming). This renames what
-- 20260903191413521_subprojects.sql created, and nothing else:
--   project_sessions.subproject                     -> .space
--   idx_project_sessions_project_subproject         -> ..._project_space
--   object_policies / role_assignments 'subproject' -> 'space'
--
-- SAFETY HEADER (house rules -- see packages/db/MIGRATIONS.md#zero-downtime-rules).
set lock_timeout = '2s';
set statement_timeout = '30s';

-- mixed-version-safe: no deployed code can be running against these objects.
-- Both the column and the 'subproject' object type were created by
-- 20260903191413521_subprojects.sql, which lives ONLY on the unmerged
-- `subprojects` branch (PR #7113) -- `git ls-tree origin/main` has no
-- subprojects migration, and `git grep -i subproject origin/main` is empty, so
-- dev, staging and prod have never applied it and no released image reads
-- either name. The only databases carrying them are local development ones,
-- where the API is replaced with this branch's code in the same step. A rename
-- (rather than the usual add-column/backfill/drop dance) is therefore safe and
-- keeps every local row's session grouping intact.
-- squawk-ignore renaming-column
ALTER TABLE "kortix"."project_sessions" RENAME COLUMN "subproject" TO "space";

-- The index survives a column rename with its definition rewritten, but keeps
-- its old NAME. Catalog-only rename: it takes a brief ACCESS EXCLUSIVE lock and
-- never rebuilds, so it does not need the CONCURRENTLY escape hatch.
ALTER INDEX IF EXISTS "kortix"."idx_project_sessions_project_subproject"
  RENAME TO "idx_project_sessions_project_space";

-- backfill-safe: catalog seed + catalog rewrite, not a data backfill.
-- `object_policies` holds one row per IAM object type, and `role_assignments`
-- rows with object_type='subproject' exist only where the branch has been run
-- by hand (zero rows in every deployed environment -- the object type has never
-- existed there). The UPDATE is bounded by that same emptiness and scans one
-- small index. Order matters: role_assignments.object_type has an FK onto
-- object_policies.object_type, so the new policy row is seeded first and the
-- old one deleted only after every assignment has moved off it.
INSERT INTO kortix.object_policies (object_type, unscoped_default_for_member, description)
VALUES ('space', 'closed', 'A space with no grant rows is usable by the manager tier only.')
ON CONFLICT (object_type) DO NOTHING;

UPDATE kortix.role_assignments SET object_type = 'space' WHERE object_type = 'subproject';

DELETE FROM kortix.object_policies WHERE object_type = 'subproject';
