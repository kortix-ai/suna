---
recorded: 2026-09-29T18:23:27Z
incident_date: 2026-09-29
---
# Mint a multi-tenant app's token only for a tenant an install proved, never for one read from a writable secret

**Rule:** Mint a token for a multi-tenant app (the managed Teams bot's Graph and
Bot Framework credentials) only for a tenant that an install path proved and
recorded (`chat_installs`). Never take the tenant from a project secret, a
request body, or any other value a project manager can write.

**Trigger surface:** Any code that calls `graphToken(tenant, creds)` or builds a
connector token for a chat platform, and any new `MS_TEAMS_*`-style secret that
an install writes and a runtime reads back.

**Incident:** 2026-09-29, a Teams permissions audit (near-miss, no exploitation
found). `loadTeamsTenantForProject` read `MS_TEAMS_TENANT_ID` from project
secrets, and the generic secrets API let any project manager overwrite it. The
connector channel token and the Graph file proxy minted app-only Graph tokens
with the managed multi-tenant app for that tenant, so a manager of one project
could have read Teams data of another organization that consented to the app.
Fixed on branch `ino/teams-permissions`: the tenant comes from `chat_installs`,
and the secrets API refuses to write or delete `MS_TEAMS_*` names.

**Enforcement:** `apps/api/src/services/secrets/secret-write-input.test.ts` (an
`MS_TEAMS_*` write is refused), and `unit-teams-file-proxy.test.ts` (Graph
tokens are minted for the proven tenant, never the secret).
