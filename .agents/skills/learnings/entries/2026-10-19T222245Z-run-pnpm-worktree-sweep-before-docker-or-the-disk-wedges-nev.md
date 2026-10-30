---
recorded: 2026-10-19T22:22:45Z
incident_date: 2026-10-19
---
# Run pnpm worktree sweep before Docker or the disk wedges; never delete an artifact dir that holds a tracked file

**Rule:** When a dev Mac drops below ~30 GB free, run `pnpm worktree sweep --yes`
first. Build output in idle worktrees is the largest lever; removing a worktree
frees ~0.2 GB because pnpm clones files. A hand-written cleanup must never
delete a `dist`/`target`/`.next` dir without `git ls-files -- <dir>` first:
`packages/ui/dist/styles.css` is tracked.

**Trigger surface:** Disk full, `docker info` hangs, local Supabase stops
answering, or file-writing tests fail at random.

**Incident:** 2026-10-19, 11 GB free (99%). Docker Desktop wedged: the backend
log stopped at 21:29Z and `docker info` hung for 13 min. Recovery: `kill -9`
the Docker Desktop and backend PIDs (not `vmnetd`), `open -g -a Docker`; up in
~20 s, `kortix-local` Supabase healthy. Then 403 artifact dirs in 110 idle
worktrees (+64 GB df), Docker anonymous volumes and unused images (+7 GB), 49
merged worktrees (+8 GB), 5 orphaned `kortix-wt-*` stacks and 126 test volumes.
11 → 99 GB free. Near-miss: the manual pass deleted the tracked
`packages/ui/dist/styles.css` in 16 worktrees; `git checkout --` restored all
16. A zsh `set -- $var` (no word splitting) made a removal-eligibility script
mark every worktree ineligible.

**Enforcement:** `pnpm worktree sweep` (#10325) skips dirs with tracked files,
busy checkouts and recent writes; `scripts/worktree/__tests__/sweep.test.ts`
pins the path-boundary liveness rule.
