---
recorded: 2026-09-01T22:19:26Z
incident_date: 2026-09-01
commit: ff687f9656
---
# Verify "converged" by what is RUNNING, not by what was installed

**When:** any install-then-restart flow. The daemon memoised its OpenCode binary
path at boot, installed 1.18.23, restarted — and kept spawning 1.17.11. The
install log said success; `readlink /proc/<pid>/exe` said otherwise.
*Automation:* `restart()` drops the memoised path (opencode.ts); the bootstrap
relaunches once more after an `updated` boot pass and its health wait requires a
FRESH daemon (`uptime_s` small), never the one just killed.
