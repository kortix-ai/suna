---
recorded: 2026-10-13T14:03:00Z
incident_date: 2026-10-13
---
# Enforce a trust boundary at the API origin, never only in an edge Worker

**Rule:** Put every access gate in the API, where the request is routed. An edge Worker gate is a first layer only: each backend origin (`api-ecs-fargate.kortix.com`, `dev-api-use2.kortix.com`) is a public Cloudflare hostname that never passes through the api-router Worker, and Hono matches the decoded path (`/%69nternal/...`) that a raw prefix check in the Worker misses. Never trust an edge-set header (`x-kortix-app-host`, `x-kortix-preview-host`) without the signature that binds it, including for a "local" host value.

**Trigger surface:** adding or changing an api-router, apps-router or preview-router Worker rule; adding a header the edge sets for the API; adding a carve-out that skips a signature check.

**Incident:** 2026-10-13 owner-authorized pentest (near-miss, no exploitation seen). `/internal/gateway/*` (live provider credentials, billing writes) was gated only by the Worker key, which was unset on prod, bypassable with `/%69nternal/`, and absent on the backend origin hosts. An unsigned `x-kortix-app-host: <16hex>.apps.localhost` routed into App dispatch because the local carve-out skipped the edge signature for a CLAIMED host. Fixed in branch `pentest-1013`.

**Enforcement:** `apps/api/src/llm-gateway/internal-routes.test.ts` ("the /internal edge key, enforced at the origin"), `infra/cloudflare/workers/api-router/worker.test.mjs` (encoded and case-shifted `/internal`), `apps/api/src/apps/public-proxy.test.ts` and `apps/api/src/sandbox-proxy/preview-origin.test.ts` (an unsigned claimed local host is not an App or preview request).
