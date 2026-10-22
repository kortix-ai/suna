---
recorded: 2026-09-28T23:12:32Z
incident_date: 2026-09-28
---
# Log an upstream status under its own field, never as `status`

**Rule:** The top-level `status` field on a log line is THIS API's HTTP response
status, owned by the request-completion middleware in `src/index.ts`. A
dependency's status goes under its own name (`upstream_status`). The Better Stack
log sweep counts every line with `status >= 500` as a 5xx response on the route
the line carries, so a warn that logs an upstream status under `status` reads as
a failing request that never failed.

**Trigger surface:** adding a `logger.warn`/`logger.error` inside a request path
whose context object carries an upstream or dependency HTTP status; any code that
logs an HTTP status it did not return.

**Incident:** prod, 2026-09-28. `generateViaGateway` logged the title generator's
gateway response as `{ status: res.status }`. A handled fallback (gateway 503 →
servable fallback model, session still created `201`) was counted as a 503
response of `POST /v1/projects/:id/sessions`: 282 phantom 5xx in 12 h against 3
genuine ones, about 20% of the route's requests, filed as a sustained prod 5xx
rise. No user impact; every session create returned `201`. Same latent collision
in `cancel-forwarded.ts` (`{ status: res.status }`).

**Enforcement:** `apps/api/src/projects/session-title-generate-gateway-log.test.ts`
(this PR) fails when the gateway warn carries a `status` field or misses
`upstream_status`.
