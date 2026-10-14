---
recorded: 2026-10-13T16:09:22Z
incident_date: 2026-10-13
---
# Run pnpm test only in a registered worktree; a plain git worktree add tests against whatever API holds port 8008

**Rule:** Run `pnpm test` only in a worktree made by `pnpm worktree create` (its `.kortix-worktree.json` marker sets the API port). Use `--db` when other sessions run suites at the same time. A plain `git worktree add` has no marker, so the local runner reuses whatever API holds port 8008 and the shared Supabase.

**Trigger surface:** Running the local suite in a scratch or private worktree, especially while other sessions run suites on the same machine.

**Incident:** 2026-10-13, one Mac with 5 concurrent sessions. Suites in a plain `git worktree add` printed `api=http://127.0.0.1:8008/v1 reusing the running local stack`: they tested another worktree's API (another branch's code), failed on `refresh_token_not_found` when that session reset the shared Supabase auth, and died with exit 143. A worktree with an isolated database still failed 1-6 load-timing tests per run at load 45-160.

**Enforcement:** none yet: the enforcer to build is a refusal in `tests/src/core/local-stack.ts` when no marker exists and port 8008 is held by a process outside this worktree.
