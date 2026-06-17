# Integration tests

Tests that exercise a module against a **real** dependency instead of a mock.
The example spins a throwaway PostgreSQL in a Docker container with
[Testcontainers](https://node.testcontainers.org) (OSS), runs real SQL, and
tears the container down afterward.

Runner: [Vitest](https://vitest.dev) (OSS).

## What's here

| File                         | Purpose |
|------------------------------|---------|
| `example-user-repo.ts`       | Module under test — a tiny user repository issuing real SQL. |
| `example-postgres.test.ts`   | Starts a `postgres:16-alpine` testcontainer, migrates, and asserts round-trip, unique constraint, and an aggregate. |
| `docker-available.ts`        | Probe (`docker info`) so the suite **skips cleanly** when Docker is missing. |
| `vitest.config.ts`           | Node env, 120s timeouts, JUnit -> `test-results/integration/junit.xml`. |

## Docker guard

The suite is gated on `isDockerAvailable()`. If `docker info` fails (no daemon,
CI without Docker, etc.) or `SKIP_DOCKER_TESTS=1` is set, the whole `describe`
becomes `describe.skip` and the run passes with the suite reported as skipped —
it never hard-fails locally.

## Run

```bash
cd tests

# requires a running Docker daemon to actually exercise Postgres
npx vitest run --config integration/vitest.config.ts

# force-skip the docker-backed suites
SKIP_DOCKER_TESTS=1 npx vitest run --config integration/vitest.config.ts
```

JUnit XML is written to `test-results/integration/junit.xml`.

## Add an integration test

1. Create `integration/<name>.test.ts`.
2. Gate any docker-backed suite behind `isDockerAvailable()`:
   ```ts
   const describeWithDocker = (await isDockerAvailable()) ? describe : describe.skip;
   ```
3. Start the dependency in `beforeAll`, stop it in `afterAll`. Use a fresh
   container per suite so tests stay isolated.
4. Reuse data from `../_support/factories`.
5. No docstring or inline comments — lean on clear names (repo style).
