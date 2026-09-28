---
recorded: 2026-08-20T01:49:25Z
incident_date: 2026-08-20
commit: 1a2daf491b
---
# A per-host credential never goes in a client-wide header bag

**When:** giving any browser/HTTP client a token that authorises ONE origin —
Playwright `use.extraHTTPHeaders`, an axios/fetch default-headers object, a
`RequestInit` you reuse. These apply to EVERY request the client makes, so the
secret goes to every third party the page touches, and any extra header forces
the cross-origin preflight to list it — which a fixed
`Access-Control-Allow-Headers` then rejects, killing the real request with
`net::ERR_FAILED` (the 204 preflight makes it look like CORS passed). Prefer the
cookie/session form of the credential, scoped to its host; if a header is the
only option, attach it per-request to that origin. **Enforcer:**
`tests/unit/web-ecs-workflow.test.ts` fails if the bypass secret returns to
`extraHTTPHeaders`.

*Incident:* `VERCEL_AUTOMATION_BYPASS_SECRET` in `playwright.config.ts`
`extraHTTPHeaders` blocked EVERY browser API call on staging — the same 11 specs
red on every release-gate run (32306385663, 32310893789) — and shipped the
secret to 16 hosts incl. Google/Facebook/DoubleClick, in plaintext inside public
workflow-run trace artifacts. Fixed in PR #6632; secret required rotation.
