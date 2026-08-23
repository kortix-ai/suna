-- Migration: reconcile_monitor_box_account_fk
--
-- `kortix.ts` declared `project_monitor_boxes.account_id -> accounts.account_id
-- ON DELETE cascade`, and the committed Drizzle snapshot recorded it, but NO
-- migration ever created it: the `.references()` arrived with the kortixd series
-- (99931e2ef3) and survived that feature's revert. So the schema file, the
-- snapshot and every real database disagreed, silently — and because drizzle-kit
-- diffs against the snapshot rather than the database, the next generated
-- migration would have been computed from a constraint that does not exist.
--
-- The schema file is corrected to match reality (the column keeps NOT NULL and
-- drops the phantom reference), and this file makes the databases agree with it
-- wherever the constraint somehow DOES exist — a self-host that ran
-- `drizzle-kit push` against the snapshot is the one way that could happen.
-- Everywhere else it is a no-op: dev, staging and production have only
-- `project_monitor_boxes_project_id_projects_project_id_fk` (verified against
-- the live schema).
--
-- Nothing is lost by not having it. Account deletion already reaches these rows
-- through `project_id` -> `projects` -> `accounts`, which does cascade.
--
-- mixed-version-safe: dropping a constraint no code depends on. No query names
-- it, no insert relies on it, and the referential guarantee it would add is
-- already provided transitively through project_id. Old and new replicas behave
-- identically with or without it.

set lock_timeout = '2s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."project_monitor_boxes"
  DROP CONSTRAINT IF EXISTS "project_monitor_boxes_account_id_accounts_account_id_fk";
