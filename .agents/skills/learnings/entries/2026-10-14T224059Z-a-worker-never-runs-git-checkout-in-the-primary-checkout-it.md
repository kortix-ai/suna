---
recorded: 2026-10-14T22:40:59Z
incident_date: 2026-10-14
---
# A worker never runs git checkout in the primary checkout; it works only in its own worktree

**Rule:** A worker agent never runs `git checkout`, `git switch`, `git stash` or `git reset` in the primary checkout (the repo root on `dev`). It runs every git command that moves HEAD inside its own worktree (`pnpm worktree create`) or a private `git worktree add` in its scratchpad. To read another revision, use `git show <rev>:<path>` or a scratch worktree.

**Trigger surface:** A delegated agent that needs an A/B baseline, an old daemon build or a file at another commit, while other sessions run `pnpm dev`, tests or reads against the primary checkout.

**Incident:** 2026-10-14, Session Log Plan P6 follow-up (PR #9915). A worker building an A/B daemon comparison ran `git checkout --detach` in the primary checkout and switched it back to `dev` within seconds at the same SHA. No file changed and no other session was affected. A near miss: a checkout to another SHA would have changed the files under every running process that reads the primary checkout.

**Enforcement:** none yet. The pre-commit hook `scripts/check-worktree-branch.sh` guards commits, not checkouts. Candidate enforcer: a `post-checkout` hook in the primary checkout that warns when HEAD leaves `dev` from a non-interactive shell. Until then, the worker brief states this rule.
