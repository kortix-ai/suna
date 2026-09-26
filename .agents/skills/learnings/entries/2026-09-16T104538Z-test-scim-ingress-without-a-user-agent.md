---
recorded: 2026-09-16T10:45:38Z
incident_date: 2026-09-16
commit: 53a426c8d8
---
# Test SCIM ingress without a User-Agent

**When:** routing enterprise directory provisioning through AWS WAF. Entra omits
`User-Agent`; supply a relay identity only on account-scoped SCIM routes when
the header is absent or empty. Preserve the bearer, body, and sender headers.
*Incident:* Azure's dev connection test returned HTML `403` before SCIM auth;
the identical request with a User-Agent reached Kortix. All five local SCIM
flows passed because their HTTP client sent a header. *Enforcer:*
`api-router/worker.test.mjs` covers SCIM methods, discovery, and route boundaries.
