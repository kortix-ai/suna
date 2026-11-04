---
recorded: 2026-10-20T18:52:08Z
incident_date: 2026-10-20
---
# Stop a hot-reloading worktree API before it exhausts the shared local Postgres

**Rule:** Stop a worktree's stack (`pnpm worktree stop <slug>`) when you no longer drive it, and do not leave a `bun --hot` API running while commits land in its tree. Every worktree database lives in the one shared local Postgres (`max_connections` 100); a leaking API in one worktree blocks every other worktree, the primary checkout and the DB test suites.

**Trigger surface:** Running `pnpm worktree start <slug>` (API runs `bun --no-env-file run --hot src/index.ts`) while agents edit and commit in that worktree for hours; any `pnpm test -- --db-only` or local sign-in failing with "too many clients" or `500 Database error querying schema`.

**Incident:** 2026-10-20. A worktree API ran for ~2 hours while 7 plan tasks committed into its tree. Idle `postgres.js` connections from that one API on its worktree database grew from 16 to 64 (about 1–2 per minute), the shared Postgres reached its 100-connection limit, local sign-in returned 500 and the superuser got "too many clients". No `import.meta.hot.dispose` exists in `apps/api/src` or `packages/db/src`, so each hot reload most likely re-creates the module-level pools (`packages/db/src/client.ts`, `apps/api/src/shared/pg-broadcast.ts`, `apps/api/src/shared/leader-election.ts`) without closing the old ones (cause inferred, not reproduced). Stopping the worktree stack returned the count to 42 total and 0 on that database. No data was lost.

**Enforcement:** none yet: close the module-level pools in `import.meta.hot.dispose` (or run the worktree API without `--hot`), with a check that a reload does not raise the connection count.
