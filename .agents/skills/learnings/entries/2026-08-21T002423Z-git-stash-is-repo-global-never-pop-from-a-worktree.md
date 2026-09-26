---
recorded: 2026-08-21T00:24:23Z
incident_date: 2026-08-21
commit: 73f35677cd
---
# `git stash` is repo-global — never `pop` from a worktree

**When:** any `git stash` / `git stash pop` inside a `pnpm worktree` checkout.
The stash stack belongs to the REPOSITORY, not the worktree, and this repo
carries ~80 entries from other people and other branches. `git stash -u` on a
clean tree creates NOTHING, so a reflexive `stash … ; do work ; stash pop`
pops **someone else's `stash@{0}`** into your tree. To compare against another
ref, use `git worktree add <tmp> <ref>`, `git show <ref>:<path>`, or
`git diff <ref>` — never stash.
*Incident:* proving a CI failure was pre-existing, `git stash -q -u` on a clean
worktree stashed nothing, then `git stash pop` unpacked
`stash@{0}` — "WIP on relay-streaming: streaming substitution kernel", 16 files
/ 1203 insertions of a colleague's parked work — into an unrelated worktree.
A modify/delete conflict is the only reason git RETAINED the entry instead of
dropping it; a clean apply would have silently consumed it and left the work
recoverable only via `git fsck`. Recovered with `git reset --hard HEAD` +
`git clean -fd` after verifying `git stash show --stat 'stash@{0}'` still
listed all 16 files. **No enforcer** — the guard is the habit.
