---
recorded: 2026-10-03T21:38:17Z
incident_date: 2026-10-03
---
# Stop only owned orphan stacks after a killed test runner

**Rule:** After a killed test runner, inspect remaining listeners and their working directories before reusing the stack. Terminate only process groups proved to belong to the current worktree. Record the interrupted run as incomplete.

**Trigger surface:** A local full-suite or browser run exits with signal status and leaves an API or gateway listening.

**Incident:** On 2026-10-03, the full test runner exited with code 137. Its Next.js server logged `SIGKILL`; later browser tests received `ERR_CONNECTION_REFUSED`. The API and gateway remained running with no parent. Inspection proved that both listeners' working directories and process groups belonged to this worktree. Recovery sent `SIGTERM` only to those two groups before starting the live pilot. The source of the kill remains unknown. The full run did not finish its browser or package stage.

**Enforcement:** The pilot's listener guard rejects other checkouts before startup. No automatic orphan cleanup currently covers a `SIGKILL`; JavaScript teardown cannot run after that signal. Recovery requires listener, working-directory, and process-group inspection. Do not use broad process-name kills.
