---
recorded: 2026-11-06T04:03:13Z
incident_date: 2026-11-06
---
# Give a worktree its own database before pnpm test when its branch carries migrations dev does not have

**Rule:** Before `pnpm test` in a worktree, check `git diff --name-only
origin/dev -- packages/db/migrations`. When the branch adds a migration, the
worktree must use its own database (`pnpm worktree create --db`). The test
runner applies every pending migration to the database the worktree points at.
In shared mode that is the primary database (`127.0.0.1:54322/postgres`) of
every other stack on the machine. To undo a branch migration by hand, drop its
triggers first, then restore data: an `UPDATE` on a table with the
migration's trigger still in place fires the trigger.

**Trigger surface:** Running `pnpm test -- --id <ID>` (or any flow lane) in a
shared-mode worktree created off a feature branch, not off `dev`.

**Incident:** 2026-11-06, near-miss on the local shared database only. A
sub-branch worktree of `workspaces` ran `pnpm test -- --id WS-ROUTE-1` in
shared mode. The runner applied four branch-only migrations to the primary
database before it refused the running dev API. One added a unique index (one
active project per account), which made a second project in an account fail
for every other stack on that database. Another renamed 41 accounts to their
project name. The hand revert restored the account names while the branch's
`accounts_name_sync` trigger was still in place, and the trigger renamed the
41 projects to the old account names. Second pass: dropped both triggers and
functions, restored the 41 project names from the backup rows, dropped the
index, view, tables and column, and deleted the three `pgmigrations` rows. The
`free_credit_claims` table predated the run and stayed. `updated_at` of the
41 accounts and 41 projects moved. No prod, staging or dev deployment was
touched.

**Enforcement:** `ensureLocalMigrations` in `tests/src/core/local-stack.ts`
throws before any migration runs when the database is the shared primary
(`…/postgres`, a shared-mode worktree or the primary checkout) and
`branchOnlyMigrations` finds migration files that `origin/dev` lacks; the
message names `pnpm worktree create --name <slug> --db`. CI and a worktree with
its own database (`branch`, `isolated`) are never refused;
`KORTIX_SHARED_DB_MIGRATE=1` overrides. `tests/unit/shared-db-migration-guard.test.ts`
covers both functions.
