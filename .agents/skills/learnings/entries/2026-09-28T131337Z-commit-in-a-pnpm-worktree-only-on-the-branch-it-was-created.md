---
recorded: 2026-09-28T13:13:37Z
incident_date: 2026-09-28
---
# Commit in a pnpm worktree only on the branch it was created for

**Rule:** A `pnpm worktree` checkout belongs to one session and one canonical
branch (its `.kortix-worktree.json`). Never switch someone else's worktree to
your branch. New work gets its own worktree. A throwaway probe branch gets a
private `git worktree add` in your scratchpad, not a `git switch` in a shared one.

**Trigger surface:** running `git switch` / `git checkout -b` in a worktree you did
not create, or re-using an "idle-looking" worktree for new work.

**Incident:** 2026-09-28, PR #7886 / #7891 / #7892. One session switched another
session's worktree to its own branch and committed there. The owner's next empty
probe commit landed on that branch's PR instead of the probe PR. The probe
measured nothing, and a preview suite ran 90 min for no result.

**Enforcement:** `scripts/check-worktree-branch.sh`, run by `.githooks/pre-commit`,
refuses a commit whose branch is neither the marker's branch nor `<branch>/…`
(override: `KORTIX_WORKTREE_ANY_BRANCH=1`). `tests/unit/worktree-branch-guard.test.ts`.
Worktrees run the primary checkout's hooks, so the guard is live once the
primary checkout has pulled this commit.
