---
recorded: 2026-10-28T04:49:34Z
incident_date: 2026-10-28
---
# Retry read-only permission batches without replaying mutations

**Rule:** Allow one connection-failure retry for the API's read-only effective-permission batch POST. Clone the request body before sending each attempt. Never generalize the exception to mutating POSTs or gateway requests.

**Trigger surface:** Changing edge-router retry eligibility or the IAM effective-permission batch endpoint.

**Incident:** 2026-10-28, KRTX-3581. Four frontend errors carried `503 origin_unreachable` after an edge-to-origin connection loss. Breadcrumbs identified the permission batch POST. GET/HEAD retry logic excluded that read-only POST.

**Enforcement:** `infra/cloudflare/workers/api-router/worker.test.mjs` consumes both attempt bodies, verifies recovery, bounds failures to two attempts and keeps mutations, gateway requests and origin HTTP errors single-attempt.
