---
recorded: 2026-09-29T14:18:32Z
incident_date: 2026-09-29
---
# Refuse a connected app's OAuth token on every route that mints a durable credential

**Rule:** A route that creates and returns a credential (PAT, CLI token, SCIM token, OAuth client secret, service account, gateway key, or anything "shown once") returns `403` when `c.get('authType') === 'oauth'`, before any lookup or entitlement gate. A connected app (MCP client) is revocable; a credential it mints is not.

**Trigger surface:** Adding or changing a route that returns a secret, key, or token in its response body; adding a new token type.

**Incident:** 2026-09-29 MCP audit, PR #8251. A `kortix_oat_` token held by an owner or admin could `POST /v1/accounts/tokens` and `/projects/:id/cli-token` (201, no expiry), plus SCIM tokens, OAuth clients, service accounts and gateway keys. Revoking the app in Connected apps left all of those alive. Found before exploitation. No customer impact known.

**Enforcement:** OAU-9 (`tests/src/flows/oauth.flow.ts`) asserts `403` for an OAuth token on all 7 mint routes. A new mint route is not covered automatically: add it to OAU-9 in the same PR.
