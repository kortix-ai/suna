# LibreMax legacy identity cutover

Supabase creates a separate Auth user for SAML SSO. Four LibreMax users currently have both an old email Auth ID and a new SSO Auth ID. The old IDs own migrated sessions. `libremax-pairs.json` records only pairs verified by matching email and distinct Auth identities.

`reconcile.ts` transfers current membership, SCIM bindings, roles, groups, session ownership, session grants, and session-scoped tokens in one database transaction. It also transfers an old personal account's member and primary-owner references. It leaves immutable audit actors, historical `created_by` fields outside sessions, account IDs, session IDs, titles, timestamps, files, and Auth user rows unchanged. A user whose old membership is already revoked gets no new membership or group grant.

Run from the repository root with the production `DATABASE_URL` supplied through Dotenvx. The default runs every update and rolls back. Save its output as the preflight ledger:

```sh
dotenvx run -f apps/api/.env.prod --quiet -- bun --no-env-file scripts/identity-cutover/reconcile.ts --pairs=scripts/identity-cutover/libremax-pairs.json
```

After confirming every row count and testing the API behavior, apply the same input:

```sh
dotenvx run -f apps/api/.env.prod --quiet -- bun --no-env-file scripts/identity-cutover/reconcile.ts --pairs=scripts/identity-cutover/libremax-pairs.json --apply --confirm-identity-cutover
```

Verify each transferred user with an SSO JWT against a restricted session. Verify the old ID no longer has an account membership. Verify that the deprovisioned user still receives 403. Read `account_scim_users` after Entra's next sync: its stable `scim_id` must still point at the new `user_id`.

The production cutover ran on 2026-09-18. Its apply ledger is stored outside Git at `.legacy-transfer/production/identity-cutover/apply-2026-09-18.json`. Verify the committed row counts with:

```sh
dotenvx run -f apps/api/.env.prod --quiet -- bun --no-env-file scripts/identity-cutover/verify-state.ts --pairs=scripts/identity-cutover/libremax-pairs.json --ledger=.legacy-transfer/production/identity-cutover/apply-2026-09-18.json
dotenvx run -f apps/api/.env.prod --quiet -- bun --no-env-file scripts/identity-cutover/verify-access.ts --phase=after
```

Run these commands from a checkout that has the production ledger at that relative path, or use an absolute ledger path. The access test signs short-lived JWTs for the eight real Auth IDs and checks production API responses. The deprovisioned user's old and SSO IDs must both receive 403. The cutover does not deploy the account-member deletion fix; that change remains in this draft PR.

This run covers the four pairs in the file. Other old identities have no SSO Auth ID until their first SSO sign-in. Do not synthesize SAML identities or delete the old Auth users: those IDs still anchor historical references and, for one user, a personal account ID. Add each future verified pair to a new cutover input and repeat the same dry-run and API checks.
