---
recorded: 2026-10-06T15:44:00Z
incident_date: 2026-10-06
---
# Match a proxy gate against the exact path the upstream routes on: canonicalize once, forward the canonical form

**Rule:** A gate that reads a request path must read the same bytes the upstream router reads. Run the path through `canonicalProxyPath` (`apps/api/src/sandbox-proxy/proxy-path.ts`) once, gate on the result, and forward the result. Never gate on the raw percent-encoded text.

**Trigger surface:** Adding or editing a path-matching guard (turn ledger, agent-switch authz, env block, dedupe, rate or audit class) in the sandbox proxy or any reverse proxy in front of a Hono server.

**Incident:** 2026-10-06 audit finding. The daemon and OpenCode are Hono servers whose `getPath` runs `decodeURI`, so `prompt%5Fasync` routed as `prompt_async` while every API gate saw an unknown path. A project member could skip the agent-switch check, prompt dedupe and the turn ledger, and an account API key could reach `/kortix/%65nv`.

**Enforcement:** `apps/api/src/sandbox-proxy/proxy-path.test.ts` (every encoded spelling of every gated path gets the plain verdict) and the encoded-path cases in `routes/preview-characterization.test.ts`.
