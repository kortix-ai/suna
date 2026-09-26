---
recorded: 2026-09-09T14:07:41Z
incident_date: 2026-09-09
commit: 3009430815
---
# A self-authenticating route must populate the shared context the resolver reads

**When:** adding a route that authenticates its own credential instead of running
the standard auth middleware. Populate the same request-context slots the shared
authorization resolver reads (`agentGrant`), or the resolver silently default-denies.
*Incident:* the git proxy resolved a session's agent grant but never placed it on
the Hono context, so `principalHoldsRefScope` default-denied every non-own-branch
push even for `kortix_cli: all`. This broke the `ops/reliability-ledgers` rolling
branch and froze monitoring ground truth for 6 days (2026-09-07 persistence incident).
*Enforcers:* `receive-pack-gate.test.ts` drives the grant through
`authorizeGitProxy` (no host-wrapper injection); `unit-git-proxy-authz.test.ts`
asserts the surfaced grant for both the sandbox and session-PAT paths.
