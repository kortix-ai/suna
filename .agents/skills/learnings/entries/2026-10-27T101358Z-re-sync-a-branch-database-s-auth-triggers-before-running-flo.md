---
recorded: 2026-10-27T10:13:58Z
incident_date: 2026-10-27
---
# Re-sync a branch database's auth triggers before running flows from a --db worktree

**Rule:** Before the flow runner starts the API for a branch-database worktree (`pnpm worktree create --db`, marker `dbMode: "branch"`), reinstall the primary's `kortix_wt_push_user` and `kortix_wt_push_session` triggers and reconcile `auth.users` and `auth.sessions` into `kortix_wt_<name>` (`syncBranchUsers` in `scripts/worktree/lib/branch-db.ts`). Never assume the triggers that `create` installed are still there.

**Trigger surface:** Running `pnpm test -- --id <flow>` or `--domain <d>` from a `--db` worktree; any flow whose world setup fails with `POST /v1/accounts/tokens -> 401 Invalid or expired token`, or an audit row `auth.login.fail` with reason `jwt_session-not-live`.

**Incident:** 2026-10-27, near-miss on branch `ino/session-groups`. Every flow from a fresh `--db` worktree failed in world setup with 401. The API confirms each JWT against `auth.sessions` in its own database (`apps/api/src/shared/jwt-liveness.ts`, #10467), and the branch database is fed by triggers on the primary's `auth.users` and `auth.sessions`. The primary had only `kortix_wt_push_user`: the sessions trigger that `create` installed 15 minutes earlier was gone (cause not found; nothing in the repo drops it), so no new sign-in session reached the branch database. Users synced (1,009 in both databases), sessions did not (1,170 vs 1,169). No data lost; it cost about 20 minutes. `pnpm worktree start` would have repaired it, but the flow runner never called that path.

**Enforcement:** `tests/src/core/local-stack.ts` `ensureLocalMigrations` calls `syncBranchUsers` after migrating a branch database (`branchAuthSyncTarget` picks the primary URL and worktree name). `tests/unit/local-profile.test.ts` ("re-syncs a branch database's auth from the primary database, and only for a branch database") pins the target. Proven by hand: with `kortix_wt_push_session` dropped on the primary, `pnpm test -- --domain session-groups` reinstalled it and passed 3/3.
