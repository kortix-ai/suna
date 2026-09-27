---
recorded: 2026-09-26T15:55:39Z
incident_date: 2026-09-08
---
# A `waitForResponse` predicate on a cross-site API must exclude the CORS preflight

**Rule:** every Playwright `waitForResponse` predicate against a
cross-origin API (app and API on different hosts, e.g. `staging.kortix.com` →
`staging-api.kortix.com`) checks `request().method()`, not the URL alone.
`Authorization` makes a GET non-simple, so the browser sends an `OPTIONS`
preflight on the same URL first; it answers 204 with no body, and
`waitForResponse` will match it exactly like any other response — the test
then reads "expected 200, received 204".

**Trigger surface:** writing or reviewing any browser journey that waits on an
authenticated API response against a deployed target where the app and API are
different hosts. Same-origin runs (local, self-host preview) never hit this,
so it only fails in the release gate.

**Incident:** v0.13.12 release gate, 2026-09-07/08: `23-composio-connector.spec.ts`
lost browser shard 3 three times to this before the method check was added.

**Enforcement:** the method checks in `tests/e2e/specs/23-composio-connector.spec.ts`.
No lint yet flags a `waitForResponse((…) =>` body missing `.method()` — that
is the TODO.
