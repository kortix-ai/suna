---
recorded: 2026-09-07T16:40:10Z
incident_date: 2026-09-07
commit: b93dcdb03b
---
# Verify the listening process before sharing a worktree URL

**When:** sharing or verifying a local fix, check the web and API listener PIDs
with `lsof`, then check each PID's `cwd` against the canonical worktree.
A healthy port does not identify its code. Connector search verification used
ports 13500/13508; another worktree later occupied them and the shared URL
reproduced the old 500. Reassign the local slot when a different worktree owns
its ports. **Enforcement TODO:** make `worktree start` reject foreign listeners
before `freeSlotPorts` and make `worktree list` report process ownership.
