---
recorded: 2026-09-15T21:31:37Z
incident_date: 2026-09-15
commit: 0c3ca6a529
---
# Terminal wake must work before a PTY exists

**When:** changing terminal attach or recovery. Test a stopped sandbox with no
cached PTY list or remembered PTY ID. `GET /kortix/pty` never wakes a sandbox;
the visible panel must initiate a mutation before read polling can succeed.
Keep automatic polls inside one fixed deadline; only user Retry resets it.
*Incident:* production terminal counted reconnects indefinitely while CLI attach
worked. PR #7267 initially fixed socket recovery but missed cold terminal creation.
*Enforcer:* `13-sdk-only-session.spec.ts` cold terminal wake and shell-output test.
