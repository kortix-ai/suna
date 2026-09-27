---
recorded: 2026-09-23T10:07:28Z
incident_date: 2026-09-23
commit: 9e2b8de803
---
# Audit coverage must not depend on a route identifying its caller

**Rule:** Never gate an audit row on a caller being known. The server edge
(`shared/audit-edge.ts`) writes one row per inbound request. An authenticator
binds the caller it proved (`bindAuditPrincipal`). A handler names the action
(`annotateAuditEvent`). An unbound request is written as `anonymous`, never
skipped.

**Near-miss (2026-09-22):** the request audit wrote a row only when the Hono
auth middleware set a user or account. The Git proxy, SCIM, preview origins,
deployed-App origins, and the tunnel and PTY WebSockets authenticate
themselves, so they wrote no row. Git clones and pushes left no trail while
any account member could push `main` (fixed by GH-19). PR #7507 then patched
the Git proxy by hand.

**Enforcement:** `unit-audit-boundary-wiring.test.ts` fails when `fetch` stops
routing through `runInboundAudit`. `e2e-audit-inbound.test.ts` pins the
anonymous row. Product flow `AUD-7` reads Git and anonymous rows back from the
account log.
