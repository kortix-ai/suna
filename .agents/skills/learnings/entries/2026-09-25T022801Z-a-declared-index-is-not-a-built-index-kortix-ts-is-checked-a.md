---
recorded: 2026-09-25T02:28:01Z
incident_date: 2026-09-25
commit: 63089345bb
---
# A declared index is not a built index; kortix.ts is checked against the migrated catalog

**Rule:** Every index, unique constraint, table and view in `kortix.ts` must
exist in a freshly migrated database, and the reverse. Declaring an index in
`kortix.ts` builds nothing: build it in a `.concurrent.ts` migration in the
same PR. Declare a compatibility view with `.view(...).existing()`, never as a
table. **Trigger surface:** any edit to `packages/db/src/schema/kortix.ts` or
an index migration. **Near-miss:** `kortix.ts` declared
`uniq_sandbox_compute_sessions_one_open` from 2026-07-16; no migration built
it until 2026-09-24, so compute metering's de-duplication could never fire.
Eight RBAC compatibility views were declared as tables. Found by a codebase
audit. **Enforcer:** `packages/db/scripts/schema-contract.ts` in the
`shadow-db` job of `db-migrations.yml`; exceptions only on
`schema-contract-sql-only.ts`, which can only shrink.
