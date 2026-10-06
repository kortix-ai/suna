---
recorded: 2026-09-01T10:53:15Z
incident_date: 2026-09-01
commit: f8c9de3f85
---
# A fix on a path the client never calls is not a fix, and a test that uses the same wrong path certifies it

**When:** adding or verifying a route on a runtime the SDK talks to. The pi
worker served the Stop button's abort at `/kortix/opencode/session/:id/abort`.
The SDK builds its OpenCode client with `baseUrl = <backend>/p/<externalId>/8000`
(`getClientForUrl`, packages/sdk/src/core/runtime/client.ts), so
`session.abort()` posts to `<base>/session/:id/abort` — the RAW root.
`handleRawSessionList` was GET-only, so that POST fell through to the worker's
catch-all 404: Stop did nothing, the UI painted "Interrupted" from its own
optimistic receipt, and the agent generated to completion. The route had been
added on 2026-08-29 to fix exactly this symptom — on the wrong path — and all
five of its unit tests drove the prefixed path, so they passed while the
product stayed broken.
**Rules:** (1) verify a runtime route by calling the URL the CLIENT builds,
not the one you wrote — read the client's `baseUrl` and concatenate; (2) when
a surface answers on two prefixes, one of them is the product's; assert THAT
one; (3) a bug reported as "the button does nothing" is a routing question
before it is a logic question — curl both paths and compare status codes.
*Incident:* pi.kortix.com, found by testing Stop by hand — raw 404 vs prefixed
200 on one live session. Fixed in `58f5cdf4`; verified live, a 3000-word
request stopped at 917 words mid-sentence.
*Enforcer:* `runtime-surface.test.ts` -> "the RAW path the SDK calls" drives
`handleRawSessionList` directly.
