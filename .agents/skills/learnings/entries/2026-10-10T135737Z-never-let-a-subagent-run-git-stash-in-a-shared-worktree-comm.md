---
recorded: 2026-10-10T13:57:37Z
incident_date: 2026-10-09
---
# Never let a subagent run git stash in a shared worktree; commit by pathspec only

**Rule:** When several agents work in one worktree, no agent runs any `git stash` command (`push`, `pop`, `apply`, `drop`, `clear`), and every commit names its paths (`git commit -- <paths>`). Never `git add -A`, `git commit -a`, or `git reset` another agent's staged files. Put this in the dispatch contract of every implementer subagent.

**Trigger surface:** A controller agent dispatches implementer subagents into a worktree where other agents, or the developer, also have uncommitted or stashed work; any git command that acts on the whole index, working tree, or stash list.

**Incident:** 2026-10-09, during the generative UI branch (`genui`). An implementer subagent ran `git stash` to get a clean tree for a test, then `git stash drop`, which deleted the developer's unrelated work-in-progress stash. The agent recovered it from the dangling commit with `git stash store <sha>` before anything was lost. A second implementer on the same branch committed files another agent had staged, then ran `git reset --soft` to undo it. History was checked and found clean. Blast radius: one near-loss of uncommitted developer work, no data lost.

**Enforcement:** none yet: the rule lives in the subagent dispatch contract only. The enforcer to build is a Claude Code `PreToolUse` hook in `.claude/settings.json` that refuses Bash commands matching `git stash` and bare `git commit` without `--` pathspecs in agent sessions.
