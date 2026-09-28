---
recorded: 2026-09-16T03:19:10Z
incident_date: 2026-09-16
commit: 9f71b401d7
---
# Refresh provider credentials before blaming sandbox authentication

**When:** a resumed terminal receives an upstream authentication refusal. Daytona
returns either a login redirect or its own JSON `401`; neither proves the daemon
rejected signed user context. Invalidate the preview-link cache and refresh once
for reads. Do not replay writes or retry a real daemon authentication rejection.
Discard cached ingress after a failed WebSocket handshake as well.
*Incident:* v0.13.18 production verification and both staging browser runs failed
after resume while fresh Daytona credentials reached the daemon. *Enforcers:*
`provider-auth.test.ts`, `e2e-preview-proxy.test.ts`, `ws-proxy-ingress-recovery.test.ts`.
