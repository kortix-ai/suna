---
recorded: 2026-09-15T06:42:47Z
incident_date: 2026-09-15
commit: aada3f2a08
---
# A webhook security gate must distinguish rejection from absent configuration

**When:** testing forged requests against an optional webhook integration. Require no 2xx, and allow a service-unavailable response only when its body names the exact missing configuration. *Near-miss:* the v0.13.15 preview gate failed `SEC-F` because unsigned Slack ingress returned `503` with `OAuth mode not configured` on a preview without Slack OAuth. *Enforcer:* `SEC-F` checks the exact 503 response in `tests/src/flows/security-backlog.flow.ts`.
