---
recorded: 2026-10-22T09:39:08Z
incident_date: 2026-10-22
---
# Do not run flows from a branch-database worktree until the runner knows dbMode branch

**Rule:** In a worktree created with `pnpm worktree create --db` (marker `.kortix-worktree.json` has `"dbMode": "branch"`), do not run `pnpm test -- --id <flow>` against the local profile until the runner handles that mode. The runner migrates the primary checkout's database (`127.0.0.1:54322/postgres`), not the worktree's `kortix_wt_<slug>`, so the branch's migrations land in the database every other session shares.

**Trigger surface:** Running a REST flow (`pnpm test -- --id SPACE-3`) from a worktree whose branch adds migrations; any later "type already exists" (42710) or out-of-order migration error on the primary checkout.

**Incident:** 2026-10-22. A flow run from a branch-database worktree migrated the primary local database: it applied 12 pending origin/dev migrations, then failed on the branch's first migration with 42710 (enum already exists) and rolled it back. The primary database already held 3 rows of an older, since re-dated copy of the same branch migrations, stamped at the worktree's creation time on 2026-10-20. Root cause: `tests/src/core/local-stack.ts` types the marker as `dbMode?: "shared" | "isolated"` and branches only on `"isolated"` (line ~185), so `"branch"` falls through to the shared primary database. No data lost; the primary database is at origin/dev's migration head plus 3 stray branch rows and their objects.

**Enforcement:** none yet: teach `local-stack.ts` the `"branch"` mode (point `DATABASE_URL` at `kortix_wt_<slug>` on the shared Postgres) and add a `tests/unit/local-profile.test.ts` case that a `"branch"` marker never resolves to `54322/postgres`.
