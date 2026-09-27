---
recorded: 2026-09-15T02:16:43Z
commit: de41287e3e
---
# Pass the deployed database URL to browser database helpers

**Incident (2026-09-15, PR #7240):** the preview admin journey inserted its
synthetic `super_admin` grant without passing `KE2E_DATABASE_URL`. The UI then
queried the preview API, which did not see the grant, and rendered `Admin access
required` on every retry.

**Rule:** browser journeys that write deployment state must pass
`KE2E_DATABASE_URL || E2E_DATABASE_URL` to each database helper call. Do not let
the helper fall back to a repository dotenv file for a deployed target.

**Enforcer:** `09-admin-console.spec.ts` passes the selected database URL to both
the role insert and cleanup delete. The preview journey must observe the grant
through `/v1/user-roles` and render the admin overview.
