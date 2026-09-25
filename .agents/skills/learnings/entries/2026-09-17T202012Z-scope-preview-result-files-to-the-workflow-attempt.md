---
recorded: 2026-09-17T20:20:12Z
incident_date: 2026-09-17
commit: 41423e7b0d
---
# Scope preview result files to the workflow attempt

**Rule:** a persistent preview must write its completion status to a
workflow-attempt-specific path. Its observer must read that same path. A fixed
status file can report a previous run before the new bootstrap acquires its lock.
**When:** changing preview deployment or result polling. *Near-miss:* a PR
preview reported an older SHA and replayed stale test failures after a new push.
*Enforcer:* `tests/unit/sandbox-preview.test.ts` checks distinct status paths.
