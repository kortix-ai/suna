---
recorded: 2026-08-19T16:33:43Z
incident_date: 2026-08-19
commit: 5bff7fa55c
---
# A redirect URI, a protocol handshake, and a cached catalog all break silently the first time a third party is real

**When:** integrating any third-party OAuth provider or remote MCP server;
building any flow whose success depends on what an external server accepts.

Kortix's generic OAuth2 connector surface passed its unit tests, its ke2e flow,
and a full local run. It had never completed one authorization against a real
provider. Three defects were sitting in it, and each one is invisible until a
third party refuses you.

**1. A redirect URI derived from the request is the wrong origin.** The
authorize route built the callback with
`new URL('/v1/connectors/oauth2/callback', c.req.url)`. Behind the load
balancer the API sees the *internal* origin, so dev emitted
`http://dev-api-ecs-fargate.kortix.com/v1/connectors/oauth2/callback` — plain
http, internal hostname. An authorization server byte-compares `redirect_uri`
against the registered value, so every real authorization would have been
rejected. Locally it looked perfect, because locally `c.req.url` *is* the
public origin. **A value a third party will compare against must come from
configuration (`KORTIX_URL`), never from the incoming request.** The same rule
covers webhook URLs, issuer strings, and audience values. Anything derived from
`req.url` is correct exactly until a proxy is in front of you.

**2. "Optional" in a spec means "mandatory" for some implementations.** MCP's
streamable-HTTP transport describes `initialize` → `notifications/initialized`
→ `Mcp-Session-Id`. Kortix posted a bare `tools/call`, which every *stateless*
server accepts — so it worked against the servers we happened to try. Servers
built on the official MCP SDKs default to **stateful** and answer anything
without a session id with `400 Bad Request: Server not initialized`. Read as a
generic 400, that looks like a malformed request, not a missing handshake.
**When a protocol describes a handshake, implement the handshake, even if your
first three test servers do not need it.** Two details that are easy to get
wrong and are load-bearing: the session cache key must include the
*credential* (or two principals share one server session), and `401`/`403` must
never be treated as a handshake failure and retried — those are credential
problems and belong to the caller untouched.

**3. A credential-dependent cache computed before the credential exists is
poison, and nothing recomputes it.** An MCP tool catalog is fetched *with* the
connector credential. Creating the connector before authorizing it therefore
recorded `status: 'error'`, `last_error: "MCP tools/list failed: HTTP 401"`.
Completing OAuth wrote the token and stopped. The user finished the flow, saw
"connected", and the connector still read **Error** with zero tools — the exact
failure the feature existed to remove, now with a success toast on top of it.
**Whenever a credential starts to exist, re-run everything that failed for want
of it.** Ask of any cache: which inputs can arrive *after* this was computed,
and what re-runs it when they do? Here the repo already had the helper
(`rematerializeCatalogAfterCredentialUpdate`); only the OAuth completion paths
never called it.

The meta-rule tying all three together: **an integration is unverified until it
has completed once against the real third party.** Not a mock, not a fixture,
not a conformant test double — the actual server. All three defects survived a
green suite; all three fell out within minutes of pointing the flow at
`api.read.ai`. Budget for one live end-to-end run before calling any
third-party integration done, and prefer a provider that implements the spec
strictly (dynamic registration, stateful sessions) as the one you test against.

*Incident:* found and fixed while building one-click OAuth 2.1 for MCP
connectors, PR #6579. No production outage — the surface had never been used
against a real provider, which is precisely why all three shipped unnoticed.
