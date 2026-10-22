---
recorded: 2026-10-02T22:03:57Z
incident_date: 2026-10-02
---
# Queue CREATE INDEX CONCURRENTLY through pgm.sql(): a statement issued directly from an async up() runs inside the still-open single transaction

**Rule:** In a `.concurrent.ts` migration, issue the CONCURRENTLY statement through `pgm.sql()`, never `await pgm.db.query(...)` — even when `up()` is async and needs to branch on a query result first (a guard SELECT via `pgm.db.query` is fine; the DDL that follows it is not).

**Trigger surface:** Writing a `.concurrent.ts` migration (node-pg-migrate 8.0.4 under `packages/db/scripts/migrate.ts`, `singleTransaction: true`).

**Incident:** 2026-10-02, KRTX-1124 (guarded `CREATE INDEX CONCURRENTLY` for `public.user_roles`). The first draft issued the build through `await pgm.db.query(...)`; the real-Postgres verification failed with `25001 PreventInTransactionBlock`, because `Migration._apply` only splices its `COMMIT`/`BEGIN` break around the QUEUED steps (`pgm.getSqlSteps()`) — a statement awaited during `up()` runs inside the runner's still-open single transaction. The existing pure-`pgm.sql()` index migrations and the DML-only `pgm.db.query` backfills never exposed the trap. Caught by the fresh throwaway-Postgres run before any deploy; no prod impact.

**Enforcement:** `tests/migration/user-roles-legacy-fk-index.test.ts` — the has-table case runs the real runner against a throwaway Postgres and fails (exit 1, 25001) when the CONCURRENTLY statement is issued directly instead of queued; the fresh-database case fails when the guard is removed and the table is absent.
