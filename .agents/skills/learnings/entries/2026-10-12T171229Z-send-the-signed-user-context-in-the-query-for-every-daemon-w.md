---
recorded: 2026-10-12T17:12:29Z
incident_date: 2026-10-12
---
# Send the signed user context in the query for every daemon WebSocket on Platinum, because its edge drops custom headers on an upgrade

**Rule:** A new WebSocket route on the sandbox daemon (port 8000) must accept the signed user context from the `__kortix_user_context` query parameter, not only from the `X-Kortix-User-Context` header. On Platinum, `routeIngress` must set `websocket.userContextQueryParam` for that request.

**Trigger surface:** Adding a daemon WebSocket (`Bun.serve` upgrade in `apps/kortix-sandbox-agent-server/src/app/server.ts`) that a client reaches through the API preview proxy `/v1/p/<sandbox>/8000/...`.

**Incident:** 2026-10-12, Kortix Browser branch, caught in local end-to-end testing before any merge. The bridge socket reached the API, which answered `101`, then closed with `1011 upstream error` every 0.3–1 s. Platinum's edge forwarded the upgrade without the header, kortixd refused it, and `kortix browser use` timed out after 30 s. Only PTY paths had the query-parameter form. Blast radius: none outside the branch.

**Enforcement:** `routeIngress()` now sets the query parameter for every websocket to the daemon port, pinned by `apps/api/src/platform/providers/platinum-create-terminal.test.ts` ("carries the signed user context on every daemon websocket").
