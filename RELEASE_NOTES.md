The pi agent harness, behind a per-project flag

### New

- **A second agent harness, behind a flag.** `pi` (`pi-agent-core`) now runs in-process in the sandbox alongside OpenCode, selected per project by the `pi_harness` feature flag. It implements abort-after-tool so Quick Queue can stop a turn at a tool boundary, and it enforces the same per-pattern permission rules OpenCode applies. Off unless a project opts in, so nothing changes for existing projects.

### Improved

- The `pi_harness` setting reads correctly in all nine languages.
- Internal: the sandbox daemon's timing budgets now tolerate a slow machine during a process respawn, so a correct restart is no longer reported as a failure.

### Fixed

- Restored the load-balancer response-time alarms required by the Drata DCF-86 control.
