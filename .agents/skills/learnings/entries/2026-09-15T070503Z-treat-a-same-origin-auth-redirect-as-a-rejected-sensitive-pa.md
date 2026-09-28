---
recorded: 2026-09-15T07:05:03Z
incident_date: 2026-09-15
commit: 5ce22ee291
---
# Treat a same-origin auth redirect as a rejected sensitive-path probe

**When:** probing encoded filesystem paths through an auth-gated frontend. Accept a `307` only if it points to relative `/auth` with the exact normalized path in `redirect`. Check the response body for secrets independently. *Near-miss:* the v0.13.15 preview gate failed `SEC-J` on an encoded `/etc/passwd` path that returned this redirect. *Enforcer:* `SEC-J` checks the redirect shape and secret body in `tests/src/flows/security-backlog.flow.ts`.
