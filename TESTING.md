# Testing

One testing framework for the whole platform: every test category has a home under `tests/`,
a single OSS tool, a `make` target, and machine-readable output that rolls up into quality gates
and the Allure report portal. Heavy tools run via Docker so contributors need almost nothing
installed locally.

> Design principle: **integrate, don't duplicate.** The API/E2E/contract/smoke layers are powered
> by the existing `ke2e` suite (`tests/src`, 283 flows, route-coverage gate). New categories fill the
> gaps. Per-package unit tests stay next to their code; this tree owns the cross-cutting suites.

## Quick start

```bash
make install      # node deps + Playwright chromium
make fast         # lint + typecheck + unit + contract + route coverage (no live target)
make all          # broad suite for a configured local/staging target, then quality gates
make help         # list every target
```

One target per category: `make unit integration api contract smoke e2e visual a11y performance
security security-dast pentest migration infra chaos mutation`.

## Categories

| Category | Folder | Tool (OSS) | Command | Needs |
|---|---|---|---|---|
| Unit | `tests/unit` | Vitest + v8 coverage | `make unit` | node |
| Integration | `tests/integration` | Vitest + Testcontainers | `make integration` | docker |
| API | `tests/api` → `ke2e` | ke2e (Bun) | `make api` | live API |
| Contract | `tests/contract` | Pact | `make contract` | node |
| Smoke | `tests/smoke` | Bun + fetch | `make smoke` | live API |
| E2E / UI | `tests/e2e` | Playwright | `make e2e` | browser, web app |
| Visual regression | `tests/visual` | Playwright snapshots | `make visual` | browser |
| Accessibility | `tests/accessibility` | axe-core + Playwright | `make a11y` | browser |
| Performance / load | `tests/performance` | k6 (Docker) | `make performance` | docker, target |
| Security (SAST/deps/secrets/container) | `tests/security` | Semgrep, Trivy, gitleaks, OSV | `make security` | docker |
| Security (DAST/fuzz) | `tests/security/dast` | OWASP ZAP, Schemathesis | `make security-dast` | docker, target |
| Enterprise automated pentest | `tests/pentest` | Bun black-box adversarial probes | `make pentest` | dedicated target |
| Migration | `tests/migration` | psql (Docker) | `make migration` | docker |
| Infra / IaC | `tests/infra` | tflint, checkov, kubeconform | `make infra` | docker |
| Chaos / resilience | `tests/chaos` | Toxiproxy, pumba (Docker) | `make chaos` | docker, target |
| Mutation | `tests/mutation` | Stryker | `make mutation` | node |
| Linting | — | workspace linters | `make lint` | pnpm |
| Type checking | `tests` | tsc | `make typecheck` | node |
| Static analysis | `tests/security/sast` + CodeQL | Semgrep / CodeQL | `make security` | docker |

Each folder has its own `README.md` with how to write and run that category's tests, plus a
copyable example. Shared test data factories/fixtures/mocks live in `tests/_support`.

## Per-package unit tests (co-located)

Unit tests live next to the code they cover (`apps/<app>/src/**/*.test.ts`,
`packages/<pkg>/src/**/*.test.ts`) and run on **`bun:test`**. Every package and app declares a
`test` script, and there is a single root entrypoint so nothing is orphaned from CI:

```bash
pnpm test            # every workspace with a test script (pnpm -r --if-present test)
pnpm test:packages   # packages/** only
pnpm test:apps       # apps/** only
pnpm --filter <name> test    # one package, e.g. pnpm --filter @kortix/shared test
```

- **`kortix-api`** runs through `apps/api/scripts/test.sh` (invoked by `pnpm --filter kortix-api test`).
  It discovers every `*.test.ts` under `src/` — no hand-maintained globs, no fail-fast — and splits
  DB-backed and live-external suites into explicit lanes: `test` (default, no external deps),
  `test:integration` (`integration-*`, needs Postgres), `test:live` (opt-in, real LLM provider),
  `test:coverage` (Bun lcov). Run via `dotenvx` so encrypted env is provided.
- **`apps/web`** uses a deterministic Bun preload (`apps/web/test-setup.ts`, wired in
  `apps/web/bunfig.toml`) that scrubs `encrypted:` placeholders and supplies safe `NEXT_PUBLIC_*`
  test config, so env-validated modules import cleanly without secrets.

CI runs these on every PR via **`.github/workflows/package-tests.yml`** (pnpm-store cached). The
`kortix-api` suite runs there only when `DOTENV_PRIVATE_KEY` is configured for the context.

## Lint & format (Biome)

`biome.json` (+ `.editorconfig`) is the single lint/format config for the TS surface. App-local
ESLint (e.g. `apps/web`) is retained where Next.js-specific rules apply.

```bash
pnpm lint:biome        # check
pnpm lint:biome:fix    # check + safe fixes
pnpm format            # format in place
```

Biome's `noFocusedTests` is an error rule; the `package-tests` workflow additionally greps for any
committed `.only(` and fails the build. Biome runs repo-wide as an **advisory ratchet** today
(`continue-on-error`) so the unlinted backlog can be paid down without blocking PRs; flip it to
blocking once `pnpm lint:biome` is clean.

## CI cadences

Workflows mirror the `make` cadence targets, so CI == local.

| Workflow | Trigger | Runs |
|---|---|---|
| `.github/workflows/qa-pr.yml` | every PR | lint, typecheck, unit, integration, contract, route coverage, **quality gates** |
| `.github/workflows/package-tests.yml` | every PR | co-located `bun:test` suites across all packages + apps (pnpm-cached), focused-test guard, env-gated `kortix-api` suite, advisory Biome lint |
| `.github/workflows/qa-main.yml` | merge to `main` | browser regression when a dev/staging web target is configured, migration tests, Allure report |
| `.github/workflows/qa-nightly.yml` | nightly cron / dispatch | static security, automated pentest, performance/load, DAST + fuzz, mutation, chaos when dedicated targets are configured |
| `.github/workflows/qa-release.yml` | PR into `prod` / dispatch | full suite against staging + **blocking quality gates** before the release PR can merge |
| `.github/workflows/hotfix-prod.yml` | manual dispatch | emergency production hotfix: approval + fast checks + exact image build, then push `prod` to trigger deploy |

The existing `e2e.yml` (ke2e) and `ci.yml` build/typecheck gates remain; these add the broader QA
matrix alongside them.

Every PR builds an Allure report from its JUnit outputs and uploads it as a workflow artifact. To
also post a stable clickable PR report link, configure:

- `QA_REPORTS_ROLE_ARN` secret — OIDC role allowed to write report objects.
- `QA_REPORTS_BUCKET` repo variable — S3 bucket for reports.
- `QA_REPORTS_PUBLIC_BASE_URL` repo variable — public CloudFront/site base URL for that bucket.
- `QA_REPORTS_PREFIX` repo variable — optional, defaults to `reports`.

### Production release and hotfix model

- Normal release: run `Promote to Production`, which opens a PR into `prod`. The `qa-release`
  workflow runs on that PR and should be required by branch protection. Merging the PR triggers
  `deploy-prod.yml`, which publishes the tag/release and deploys.
- Emergency hotfix: run `Emergency Hotfix to Production` only when waiting for the full release gate
  would materially prolong a production incident. It requires a `production-hotfix` environment
  approval, a typed `HOTFIX PROD` acknowledgement, fast tests, and exact `dev-<sha>` images before it
  pushes `prod`. The same `deploy-prod.yml` still handles the actual publish/deploy.
- Recommended GitHub setup: protect `prod`; require the release QA check for normal PR merges; create
  the `production-hotfix` environment with senior/on-call reviewers; if branch protection blocks
  workflow pushes, store a tightly scoped `PROD_HOTFIX_TOKEN` that can bypass protection only for the
  hotfix workflow.

## Quality gates

`make gates` (script: `tests/scripts/quality-gates.sh`) aggregates everything under
`test-results/` and fails the build on:

- any failing test in any JUnit report,
- code coverage below `MIN_COVERAGE` (default 80%),
- any CRITICAL/HIGH security finding in SARIF,
- any k6 performance threshold breach.

It treats missing artifacts as SKIP, so it scales to whatever ran. Migration/contract/a11y failures
surface as JUnit failures and are caught by gate #1.

**Performance regression gate:** `make perf-regression` (`tests/performance/compare-baseline.mjs`)
compares each k6 profile's `http_req_duration p(95)` and `http_req_failed rate` against the committed
`tests/performance/baseline.json` and fails on a >10% regression. Capture/refresh the baseline from a
clean run with `pnpm --filter @kortix/tests test:perf:baseline` (writes the observed numbers). Until a
baseline is committed it reports SKIP rather than failing.

## Reporting

- **JUnit XML** per category → `tests/test-results/<category>/junit.xml` (CI consumes these).
- **Coverage** → `tests/test-results/unit/coverage/`.
- **Allure portal** (hosted, history/trends): `make report` builds it; `make portal-up` serves it at
  `localhost:5051`. Convert a real run with `bun bin/ke2e.ts allure --from <results.json>`.
- **Catalog** (browse all flows/cases): `bun bin/ke2e.ts catalog`.
- **Screenshots / videos / traces** for failed E2E are retained under `test-results/e2e/artifacts`.

## Penetration Testing Evidence

`make pentest` is the enterprise automated penetration-style e2e lane. It runs black-box probes
against a dedicated staging/QA target and produces JUnit/JSON evidence under
`tests/test-results/pentest/`. Coverage includes auth bypass, admin exposure, malformed tokens,
CORS reflection, header/info disclosure, sensitive path traversal, injection/content-type abuse,
method fuzzing, open-relay behavior, and setup/bootstrap leakage.

This lane is required in `qa-release` and scheduled in `qa-nightly`. It intentionally refuses
production-looking URLs and requires `PENTEST_LIVE_CONFIRM=ci` because it sends adversarial traffic.

Compliance boundary: automated pentest evidence is necessary but not sufficient for enterprise
assurance. Keep an annual or major-release external/manual penetration-test report with remediation
tracking for SOC 2 / ISO customer evidence. The automated lane proves continuous regression coverage;
the external report proves expert human review of chained exploits and business-logic abuse.

## Writing a test

1. Pick the category folder; copy its example.
2. Reuse `tests/_support` factories/fixtures/mocks for data.
3. Keep it deterministic; tests assert behaviour, not implementation.
4. New API route? Add a `ke2e` flow (the route-coverage gate enforces this — see
   `.claude/skills/ke2e-tests`).
5. `make <category>` locally, then `make gates`.

## Remaining manual / recommended areas

- **Exploratory & usability testing** of new UX — not automatable.
- **Real-world load profiles & capacity planning** — k6 scripts are starting points; tune stages to
  production traffic shapes.
- **DR/failover game-days** — `tests/chaos/dr-runbook.md` lists drills; the destructive ones (region
  loss, restore-from-backup) need a human-run staging exercise.
- **Manual pen-test depth** — automated DAST/fuzz/pentest covers continuous regression. Periodic
  independent manual pentest remains required for chained exploit discovery and customer evidence.
- **Visual baselines** must be generated on a consistent renderer (CI container) and reviewed by a
  human on first creation.
