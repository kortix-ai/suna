---
recorded: 2026-10-03T05:55:00Z
incident_date: 2026-10-03
---
# A Docker-less sandbox can still verify a DB migration: install native PostgreSQL and run the repo's own migrate runner and a catalog-backed regression test against it

**Rule:** When the sandbox has no Docker, do not hand a migration off unverified. Install a native PostgreSQL in the session, run `test-prereqs.sql` and the repo's own `pnpm --filter @kortix/db migrate` against it, prove the change with a catalog-backed regression test, then re-apply after deleting the new ledger row to prove the migration is repeatable. `skipped-no-db` is a skip, never proof.

**Trigger surface:** Any PR that adds or changes `packages/db/migrations`, written from a sandbox whose Docker daemon cannot start.

**Incident:** 2026-10-03, KRTX-1101 (a concurrent FK covering index for `kortix.oauth_authorization_requests`). The first handoff ran focused tests against a session-native PostgreSQL 15 but committed no test attestation; the merge gate's attestation check failed the head and sent the PR through a rework cycle. The migration itself was verifiable all along: fresh full-chain apply, repeat apply, and repeat after a ledger-row delete all ran green on the native instance.

**Enforcement:** `packages/db/scripts/oauth-authorization-requests-client-index.integration.test.ts` — a real-Postgres catalog test that fails red on a missing or invalid covering index for `oauth_auth_requests_client_fk`. Run it with `TEST_DATABASE_URL` wherever a reachable PostgreSQL exists.
