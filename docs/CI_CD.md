# CI/CD Pipeline

Local development and CI use the same test contracts. CI owns target selection,
credentials, installation, and artifact upload. The test implementation does not
contain CI-specific behavior.

## Test commands

- `pnpm test` runs local REST and CLI flows, SDK tests, runner units, and route
  coverage.
- `pnpm test -- --full` adds Playwright and every app/package test.
- `bun tests/bin/ke2e.ts run` executes the same REST and CLI flows against an
  explicit deployed target.
- `cd tests && bun run test:browser` executes browser journeys against explicit
  `E2E_*` targets.

See `tests/README.md` for the local contract.

## Test workflows

- `package-tests.yml` runs co-located app and package tests on pull requests.
- `qa-pr.yml` runs SDK tests, runner tests, and API route coverage.
- `qa-staging.yml` runs Playwright against staging.
- `qa-release.yml` runs app/package tests, route coverage, deployed REST and CLI
  flows, and Playwright against staging. Its `full suite + quality gates` job is
  the production release check.

There is no separate Pact, Testcontainers, k6, mutation, Gate 5, visual,
accessibility, self-host, or Allure test framework.

## Release path

1. Merge development changes to `main`.
2. `deploy-dev.yml` deploys the merged SHA to dev.
3. Promote a release candidate to `staging` through a PR.
4. `build-staging.yml` and `deploy-staging.yml` build and deploy staging.
5. `qa-staging.yml` verifies the staging browser surface.
6. Open the reviewed `staging` to `prod` release PR.
7. `qa-release.yml` verifies the deployed staging candidate.
8. Merge the release PR.
9. `deploy-prod.yml` publishes and deploys the approved artifact.

Staging must use `STAGING_DATABASE_URL`. A staging check that targets dev or
production is invalid.
