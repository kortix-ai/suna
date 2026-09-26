---
recorded: 2026-09-18T15:45:42Z
incident_date: 2026-09-18
commit: 631ae5e6a4
---
# Restart a persistent preview after an old deployment retains its lock

**Rule:** When a preview waits at `flock`, inspect `/proc/locks` before retrying.
If the holder is stale and outside the sandbox's process namespace, stop and
start that preview sandbox, then rerun the exact SHA. Do not remove the lock
file: a new inode would let two deployments run at once. **Near-miss:** PR
#7358 had six waiters, one older than 17 hours; a sandbox restart cleared the
holder without deleting its disk. **Enforcer:** `sandbox-preview.test.ts` pins
daemon FD closure; a stale-lock watchdog remains a follow-up.
