---
recorded: 2026-08-21T21:08:36Z
incident_date: 2026-08-21
commit: 7a9d9f6038
---
# Normalize missing User-Agent at webhook ingress before AWS WAF

**When:** proxying public provider webhooks through the API router to an AWS
WAF-protected origin. Providers may omit `User-Agent`; signatures, not that
informational header, authenticate these requests. AWS Managed Rules reject the
request before the API can verify its signature. Add a relay `User-Agent` only
for POST webhook routes and only when absent. Preserve sender headers elsewhere.
*Incident:* Agency webhooks returned origin `403`; the same body with any
`User-Agent` reached Suna. *Enforcer:* `api-router/worker.test.mjs` covers every
webhook path family, sender-header preservation, and non-webhook exclusion.
