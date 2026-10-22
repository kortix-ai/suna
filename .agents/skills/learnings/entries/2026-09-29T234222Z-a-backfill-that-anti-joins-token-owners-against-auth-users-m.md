---
recorded: 2026-09-29T23:42:22Z
incident_date: 2026-09-30
---
# A backfill that anti-joins token owners against auth.users must exclude service accounts

**Rule:** Before a migration revokes or deletes credentials "whose user no longer exists" (`NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = t.user_id)`), exclude every principal that is not an auth user. Today that is service accounts: their `account_tokens` rows (PATs and service-account-launched session tokens) carry `user_id = kortix.service_accounts.service_account_id`, which is never in `auth.users`. Count the rows the backfill touches on dev with `BEGIN READ ONLY`, grouped by token kind, before merging.

**Trigger surface:** Writing a migration or script that joins `account_tokens`, `oauth_*_tokens` or `yolo_member_tokens` on `user_id` against `auth.users`; adding a new principal kind that mints tokens.

**Incident:** 2026-09-30, PR #8318 (revoke credentials when an auth user is deleted). Review counted the backfill on dev before merge: 552 live tokens had no auth user, and 3 of their owners were service accounts, with tokens used in the last 7 days. The first version would have revoked every live service-account token at deploy, breaking every integration that uses one. Fixed before merge; dev after deploy: 0 orphaned tokens, 4 service-account tokens still active.

**Enforcement:** `apps/api/src/__tests__/integration-revoke-credentials-on-user-delete.test.ts` seeds a service-account PAT and session token and asserts they survive the backfill and an unrelated auth-user delete (fails with the exclusion removed: expected 2, received 0).
