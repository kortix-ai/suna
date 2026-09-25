---
recorded: 2026-09-21T11:20:00Z
incident_date: 2026-09-21
commit: 0056803ca3
---
# A repository replacement retires Git authority, not session history

**Rule:** When a repository generation changes, block Git and automatic session
starts. Give the session owner an explicit action to resume only an existing
preserved workspace. Never provision the current repository into that session,
and never route the refusal through provider-failure recovery. **Incident:** a
repository cutover rendered historical sessions as retryable sandbox failures.
**Enforcers:** `SESS-33`, browser journey 31, and the SDK start-query test.
