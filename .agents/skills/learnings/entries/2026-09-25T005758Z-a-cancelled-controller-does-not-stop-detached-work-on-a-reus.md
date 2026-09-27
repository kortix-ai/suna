---
recorded: 2026-09-25T00:57:58Z
incident_date: 2026-09-24
commit: e6e04788ce
---
# A cancelled controller does not stop detached work on a reused remote host

**Rule:** Before a controller launches work on a reused remote host, stop the
previous detached process group. Controller cancellation is not a remote
lifecycle signal. **Trigger surface:** preview deploys and remote test workers.
**Near-miss:** A cancelled preview suite continued creating cloud session boxes
and held the next deploy behind its lock. **Enforcer:** the Platinum deploy
sends `TERM`, waits 10 seconds, then sends `KILL`; `sandbox-preview.test.ts`
asserts the anchored process match and both signals.
