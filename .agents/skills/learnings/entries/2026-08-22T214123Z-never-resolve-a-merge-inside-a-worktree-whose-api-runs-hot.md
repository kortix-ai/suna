---
recorded: 2026-08-22T21:41:23Z
commit: 9f43e91dc9
---
# Never resolve a merge inside a worktree whose API runs `--hot`

2026-08-22. `git merge origin/main` was run inside `suna-timeline-parity`, the
worktree that served the user's live test stack (`bun --hot` API, Next dev
web). The merge stopped on conflicts, the tree held conflict markers, and the
hot-reloading API picked them up (`tsc`: `TS1185: Merge conflict marker
encountered` in `r4.ts`) while the user was testing. `git merge --abort`
restored it within a minute; no sandbox was lost.

**The rule.** A worktree that serves a live stack is read-only to git
operations that can leave the tree in a non-compiling state: merges with
possible conflicts, rebases, cherry-picks, checkouts of other branches.
Resolve in a scratch worktree on a sibling branch, run the gates there, then
`git merge --ff-only` inside the live worktree so it only ever moves between
two consistent trees. Fast-forward is the only git write a live worktree
should see — and a fast-forward that moves `apps/kortix-sandbox-agent-server`,
`apps/cli`, or `apps/kortix-app-runtime` source must be followed by the same
artifact builds the launcher runs at start (`pnpm --filter` build for the
agent server and CLI, `bash apps/kortix-app-runtime/build.sh`), or every new
session fails provisioning with `kortix-agent dist binary … is older than its
source` (seen 2026-08-22 21:41 right after the ff; rebuilt, sessions booted
again).

**The enforcement.** The integration-branch memory note names the rule; the
scratch-worktree-then-ff sequence is the procedure
(`timeline-parity-main-merge` → `git merge --ff-only`). Candidate for a
`pnpm worktree` guard: refuse `merge`/`rebase` in a slot whose API port is
listening unless `--ff-only`.

*Incident:* `timeline-parity` worktree, 2026-08-22 ~21:35 UTC, ~60 s of
`tsc` errors on the live API; aborted, re-done in `tp-main-merge`, ff'd.
