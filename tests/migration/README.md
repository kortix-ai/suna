# Migration tests

Validates the repo's `supabase/migrations/*.sql` against a throwaway Postgres,
using only Docker + `psql` (no host tooling, no Supabase CLI). Output is JUnit
XML in `test-results/migration/`.

## What it checks

1. **Apply up, in order** — every `supabase/migrations/*.sql` runs in filename
   order inside a `postgres:16-alpine` container, each in a single transaction.
2. **Schema is non-empty / key tables exist** — `schema.test.sh` asserts the
   `kortix` schema has tables, that a list of business-critical tables exist,
   that enum types are present, and that Supabase grant roles can see the tables.
3. **Idempotency** — `idempotency.test.sh` re-runs the apply step and asserts it
   exits 0 and applies nothing (mirrors `supabase db push` run twice in CI).
4. **Rollback / down** — `rollback.test.sh`. These migrations are forward-only
   (no paired `*.down.sql`), so rollback is exercised the way it happens here:
   `db-reset.sh` drops all app schemas and re-applies from scratch. The test
   auto-detects `*.down.sql` or `down/*.sql` and, if present, applies them in
   reverse and asserts the schema empties out.

## Supabase compatibility shim

A vanilla `postgres:16-alpine` image lacks the Supabase-managed roles the
migrations `GRANT` to. `scripts/bootstrap-roles.sql` pre-creates `anon`,
`authenticated`, `service_role`, and `authenticator` as no-login placeholders so
the grant DDL applies cleanly. Migrations that touch the `auth`/`storage`
schemas are already guarded in-repo (they no-op when those schemas are absent),
so no further shimming is needed. This shim tests DDL correctness, **not** RLS
or JWT behaviour.

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

## Prerequisites

- Docker with the Compose v2 plugin (`docker compose`).
- That's it — `psql` runs inside the container.
