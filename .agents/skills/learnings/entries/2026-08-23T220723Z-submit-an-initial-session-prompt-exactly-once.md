---
recorded: 2026-08-23T22:07:23Z
incident_date: 2026-08-23
commit: 1cb4f0d0cd
---
# Submit an initial session prompt exactly once

**When:** creating a session with `initial_prompt`. Do not submit the same
prompt again after session readiness. Assert one user turn and one assistant
turn through the real CLI process. *Incident:* the CLI created the session with
the prompt, then posted it again and returned HTTP 500 after the first reply.
*Enforcer:* `sessions.test.ts` counts runtime prompt requests for `--new`.
