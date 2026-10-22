---
recorded: 2026-10-03T20:26:21Z
incident_date: 2026-10-03
---
# Reject foreign listeners before starting an agentic test stack

**Rule:** Check the listener's working directory before starting a test target. Reject a listener owned by another checkout. Reassign only this worktree's ports.

**Trigger surface:** Starting the opt-in agentic browser test target through `pnpm test -- --agentic-only`.

**Incident:** On 2026-10-03, a newly allocated worktree used an app-port block already owned by another worktree. The first target startup reached the occupied-port check. The run stopped before killing the foreign process. This worktree then received a free port block. No foreign process was stopped.

**Enforcement:** `tests/src/core/agentic-ownership.ts` checks every web/API/gateway listener's PID and working directory. Both `tests/bin/agentic.ts` and `e2e.config.ts` call it. A foreign listener fails before CLI or MCP application startup. The worktree allocator itself still needs a separate collision fix.
