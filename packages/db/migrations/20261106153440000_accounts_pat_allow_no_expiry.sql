-- Migration: accounts_pat_allow_no_expiry
--
-- Workspaces auth (design: .agents/skills/learnings/work/workspaces/design.md
-- §3.2 C4a). Workspace keys expire by default (90 days when the caller names
-- no expiry, 365 days at most). This key policy flag lets a workspace admin
-- allow keys with no expiry (`PATCH /v1/workspaces/:id/iam/pat-policy
-- {allow_no_expiry: true}`). Default false.
--
-- Release 2 note: kortix.workspaces does not mirror this column in Release 1
-- (its row type is the SETOF of kortix.workspaces_expected). Release 2 adds it
-- to the table with the other pat_* columns (design.md §4).
--
-- Locks: ADD COLUMN ... NOT NULL DEFAULT false is catalog-only on PostgreSQL
-- 11+ (no rewrite); it takes ACCESS EXCLUSIVE on accounts for a moment. One
-- hot table, one file. 3s lock_timeout: on 55P03 the file rolls back as a
-- whole: find the holder in pg_stat_activity, rerun the migrate job. Never
-- raise the timeout. IF NOT EXISTS makes a rerun safe.
--
-- Mixed-version deploy: the old image never names the column. Every row reads
-- false: no workspace allows a new key without an expiry until an admin says so.
--
-- ROLL BACK: no down migration (repo policy). The column can stay.
set lock_timeout = '3s';
set statement_timeout = '30s';

ALTER TABLE "kortix"."accounts" ADD COLUMN IF NOT EXISTS "pat_allow_no_expiry" boolean DEFAULT false NOT NULL;

COMMENT ON COLUMN "kortix"."accounts"."pat_allow_no_expiry" IS
  'Key policy: true lets a member mint a workspace key with no expiry. False (default): every new key expires (default 90 days, at most 365).';
