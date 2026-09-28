---
recorded: 2026-09-28T17:40:19Z
incident_date: 2026-09-28
---
# Never use git stash to compare against main in a worktree; the stash list is shared by every worktree of the repository

**Rule:** To run a test "without my change", check out the base in a separate detached worktree (`git worktree add --detach <dir> origin/main`). Never run `git stash && … && git stash pop` in a worktree: with nothing to stash, `stash` is a no-op and `pop` applies the newest entry of the repository-wide stash list, which can belong to another checkout.

**Trigger surface:** Comparing a test result against `main` from inside a worktree; any `git stash` in a repository that has more than one worktree.

**Incident:** 2026-09-28, near-miss, no data lost. In a Platinum worktree whose changes were already committed, `git stash -q && bun test … ; git stash pop` stashed nothing, then popped the primary checkout's `stash@{0}` ("pre-pull local edits") into the worktree with a merge conflict. Git kept the entry because of the conflict. `git reset --hard HEAD` in the worktree restored it, and `stash@{0}` stayed intact. A clean pop would have dropped the entry from the shared list, and the owner's only copy of those edits would have been left in an unrelated branch's working tree.

**Enforcement:** none yet: a `.githooks` or shell guard cannot see `git stash`. The comparison recipe above is the enforced habit.
