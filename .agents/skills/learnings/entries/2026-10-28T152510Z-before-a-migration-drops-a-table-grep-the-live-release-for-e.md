---
recorded: 2026-10-28T15:25:10Z
incident_date: 2026-10-28
---
# Before a migration drops a table, grep the live release for every reader of it; a plan's reader list is not an inventory

**Rule:** Before you write a migration that drops a table, run `git grep -n <table_name>` (raw SQL and the Drizzle name) on the release that will be live while the migration applies. Every hit outside the migrations must already be gone or gated in that release. Migrations run before the ECS rollout, so old tasks serve requests against the dropped table. A plan's list of readers is a starting point, not the inventory. Then run that release's API against a copy of the database with the table dropped, and call each route whose code had a hit.

**Trigger surface:** Writing a `DROP TABLE` (or `DROP COLUMN`) migration; writing the expand/contract "deploy 1" that gates readers ahead of a drop; reviewing either.

**Incident:** 2026-10-28, near-miss found while building Session Log Plan P8.2 Release B2 (the drop of `kortix.session_transcript_mirrors` and `kortix.session_transcript_messages`). Release B1 (#10782) gated every mirror reader its plan listed behind `mirrorDrained()`. `apps/api/src/projects/lib/session-reply-counts.ts` still read both tables ungated: the space session list (`GET /v1/projects/:id/sessions?space_id=`) falls back to the mirror for a listed session with no root-thread turn in its log. On a worktree database with both tables dropped, the B1-era API answered that list `500` (`42P01`); the B2 code answered `200`. No user impact: B2 had not merged. The fix split the release: B2 deletes every reader, and the drop moved to Release B3, one release later.

**Enforcement:** none yet. To build: a `lint-migrations.ts` check that, for each `DROP TABLE` in a new migration, greps `apps/` and `packages/` (outside `packages/db/migrations`) at the previous release tag for the table name and fails on a hit.
