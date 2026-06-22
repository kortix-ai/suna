# Migration tests

Validates the repo's `packages/db/migrations/*.sql` against a throwaway Postgres
by applying them with **node-pg-migrate** (the same `pnpm migrate` the deploy
pipeline uses). Output is JUnit XML in `test-results/migration/`.

## What it checks

1. **Apply up** — `pnpm --filter @kortix/db migrate` builds the schema from
   scratch in a `postgres:16-alpine` container (each migration transactional,
   advisory-locked). Tracking lives in `kortix_migrations.pgmigrations`.
2. **Schema is non-empty / key tables exist** — `schema.test.sh` asserts the
   `kortix` schema has tables, that a list of business-critical tables exist,
   that enum types are present, and that the Supabase grant roles can see them.
3. **Idempotency** — `idempotency.test.sh` re-runs migrate and asserts it exits
   0, applies nothing, and reports "No migrations to run".
4. **Rollback** — `rollback.test.sh`. The flow is forward-only (the baseline has
   no paired down section; prod rollback is a NEW forward migration), so
   rollback is exercised via `db-reset.sh`: drop all app schemas and re-apply
   from scratch, asserting the schema rebuilds cleanly.

## Prerequisite shim

A vanilla `postgres:16-alpine` image lacks the Supabase platform objects the
baseline assumes. `packages/db/scripts/test-prereqs.sql` pre-creates the
`anon`/`authenticated`/`service_role` roles and minimal `auth`/`basejump` stubs
so the FK/RLS/grant DDL applies cleanly. The storage-bucket migration self-skips
when the `storage` schema is absent. This tests DDL correctness, **not** RLS or
JWT behaviour.

> Unlike the old supabase/migrations flow, this needs host tooling (bun + a
> workspace `pnpm install`) because node-pg-migrate runs on the host against the
> container.

## Run

```bash
# Full run: up -> migrate -> seed -> test -> teardown
bash tests/migration/run.sh

# Keep the DB running afterwards (inspect with psql on localhost:55432)
KEEP_DB=1 bash tests/migration/run.sh

# Skip the slower rollback/reset suite
NO_DOWN=1 bash tests/migration/run.sh
```

Individual steps:

```bash
bash tests/migration/scripts/db-up.sh      # start Postgres + wait healthy
bash tests/migration/scripts/migrate-up.sh # apply all migrations
bash tests/migration/scripts/db-seed.sh    # load fixtures/*.sql
bash tests/migration/scripts/db-reset.sh   # drop + re-apply (in-place)
bash tests/migration/scripts/db-down.sh    # stop + remove container/volume
```

## Config (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `TEST_DB_USER` | `kortix_test` | Postgres user |
| `TEST_DB_PASSWORD` | `kortix_test` | Postgres password |
| `TEST_DB_NAME` | `kortix_test` | Database name |
| `TEST_DB_PORT` | `55432` | Host port mapping |
| `RESULTS_DIR` | `test-results/migration` | JUnit output dir |

These match `tests/docker-compose.test.yml`.

## How to add a check

- **A new key table**: add `"kortix.<table>"` to `KEY_TABLES` in
  `tests/schema.test.sh`.
- **An arbitrary assertion**: in any `tests/*.test.sh`, run
  `psql_query "<SQL returning '1' on success>"` and wrap the result in a
  `junit_case "<name>" pass|fail "<message>"`. See `schema.test.sh` for the
  pattern (`junit.sh` provides `junit_init` / `junit_case` / `junit_write`).
- **A new suite**: drop a `tests/<name>.test.sh` that sources `env.sh` +
  `junit.sh`, then add a line to `run.sh`.
- **Seed data**: add an idempotent `fixtures/NNN_*.sql` (use
  `ON CONFLICT DO NOTHING`); `db-seed.sh` runs them in filename order.

## Worktree wrapper (end-to-end)

`run.sh` validates the migrate flow directly (`psql` prereqs + `pnpm migrate`).
`worktree-migrate.test.ts` validates the worktree's own wrapper — it drives the
real `runMigrate()` + `hasKortixSchema()` from `scripts/worktree/lib` against a
throwaway Postgres and asserts the `kortix` schema builds (≥80 tables) and a
second run is a no-op. It manages its OWN container because the worktree always
uses `postgres:postgres@/postgres` (a fresh Supabase-local), not the
`kortix_test` creds above. Needs Node 22 (the worktree's engine floor) and
docker; skips cleanly when docker is absent.

```bash
pnpm test:migration:worktree          # or: bun test migration/worktree-migrate.test.ts
WT_MIGRATE_TEST_PORT=55440 ...         # override the host port if 55440 is taken
```

## Prerequisites

- Docker with the Compose v2 plugin (`docker compose`).
- That's it — `psql` runs inside the container.
