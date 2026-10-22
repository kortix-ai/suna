---
recorded: 2026-10-01T15:43:20Z
incident_date: 2026-09-18
---
# Never revoke a session token while its box still holds it, and record why every credential is revoked

**Rule:** The provider injects `KORTIX_TOKEN` at sandbox create and re-applies it on
every start, so a box can never adopt a successor token. Never revoke a
session token that is still a session's `config.serviceKey`. Never mint a
successor and revoke the old token in the same job. Record why you revoke:
`account_tokens` has no reason column, so a deliberate revoke and a rotation
are indistinguishable after the fact.

**Trigger surface:** Writing a migration or rehome job that rotates session credentials; a bulk `UPDATE account_tokens SET revoked_at`; any new revoke path.

**Incident:** Verified 2026-10-01. A prod sample put 89 of 250 migrated stopped sessions
(about 6,000 sessions) on a revoked box token, after a migration rotation and a
bulk revoke of 11,726 session tokens on 2026-09-18. The box claim got
`401 PAT not found or revoked`, never turned ready, and the proxy answered
`initial_opencode_session_failed`. 0 of 250 non-migrated sessions were
affected. Fixed in the PR that adds `healSupersededSessionToken`: `/start`
reactivates the token that equals the session's recorded box key, under five
guards.

**Enforcement:** `apps/api/src/__tests__/integration-heal-superseded-box-token.test.ts`
covers the heal and each guard. None yet for the rule itself: add a
`revoke_reason` column and make the revoke helpers require it.
