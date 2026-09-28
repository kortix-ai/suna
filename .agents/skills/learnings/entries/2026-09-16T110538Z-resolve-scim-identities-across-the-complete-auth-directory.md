---
recorded: 2026-09-16T11:05:38Z
incident_date: 2026-09-16
commit: eb574fb44f
---
# Resolve SCIM identities across the complete auth directory

**When:** matching provisioned users by email. Query the normalized email in
`auth.users` and prefer the existing account member for duplicate identities.
Do not treat a lookup failure as a missing user and create an invitation.
*Near-miss:* SCIM searched only the first 1,000 auth users; dev held 2,816 users.
*Enforcer:* `scim/user-lookup.test.ts` covers the truncated directory and lookup
failures; `SCIM-6` verifies provisioning and deactivation over HTTP.
