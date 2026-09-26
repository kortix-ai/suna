---
recorded: 2026-08-27T23:00:20Z
incident_date: 2026-08-27
commit: 5ad74b8838
---
# An environment that shares ONE origin between frontend and API must enumerate every path the API serves outside the common prefix

**When:** editing the preview edge (`buildPreviewCaddyfile`), or mounting a
route in `apps/api/src/index.ts` anywhere other than under `/v1`.
Deployed environments give the API a host of its own, so every path it serves
reaches it and prefix questions never arise. A preview shares one origin with
the frontend and splits by prefix, and the `@api` matcher listed only `/v1*`.
So `/health`, `/health/live`, `/health/ready`, `/metrics`, `/scim/v2/*`,
`/internal/*` and `/.well-known/oauth-authorization-server` went to
`frontend:3000`, which answered `307 -> /auth?redirect=…`. 13 flows failed on
it (SYS-1/8/9, SCIM-1..5, GW-1/8/10/12, SEC-J), each reading as an auth or
availability bug rather than a routing one.

**The rule: a new non-`/v1` mount is TWO edits** — the route and the preview
matcher — and the matcher carries a comment saying so. More generally, an
environment whose topology differs from dev (one origin instead of two hosts)
does not inherit dev's routing for free; enumerate what the difference hides.

**Diagnostic:** a `307` to `/auth` on a path that needs no auth is the frontend
answering, not the API. `curl -o /dev/null -w '%{http_code} %{redirect_url}'`
tells them apart in one call — the API returns the endpoint's own status
(`200`/`401`), never a redirect to a login page.
*Near-miss:* PR #7012, found while verifying preview↔dev parity. Preview only;
no deployed environment is affected, because none of them share an origin.
*Enforcer:* `tests/unit/preview-stack.test.ts` asserts each of the six paths is
present in the `@api` line. Nothing yet fails when a NEW non-`/v1` mount is
added to the API without updating the matcher — that check is the TODO.
