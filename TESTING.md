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
make fast         # lint + typecheck + unit + smoke  (the local loop)
make all          # everything runnable without a cloud target, then quality gates
make help         # list every target
```

One target per category: `make unit integration api contract smoke e2e visual a11y performance
security migration infra chaos mutation`.

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
| Migration | `tests/migration` | psql (Docker) | `make migration` | docker |
| Infra / IaC | `tests/infra` | tflint, checkov, kubeconform | `make infra` | docker |
| Chaos / resilience | `tests/chaos` | Toxiproxy, pumba (Docker) | `make chaos` | docker, target |
| Mutation | `tests/mutation` | Stryker | `make mutation` | node |
| Linting | — | workspace linters | `make lint` | pnpm |
| Type checking | `tests` | tsc | `make typecheck` | node |
| Static analysis | `tests/security/sast` + CodeQL | Semgrep / CodeQL | `make security` | docker |

Each folder has its own `README.md` with how to write and run that category's tests, plus a
copyable example. Shared test data factories/fixtures/mocks live in `tests/_support`.

## CI cadences

Workflows mirror the `make` cadence targets, so CI == local.

| Workflow | Trigger | Runs |
|---|---|---|
| `.github/workflows/qa-pr.yml` | every PR | lint, typecheck, unit, integration, api, contract, static security, **quality gates** |
| `.github/workflows/qa-main.yml` | merge to `main` | e2e, visual, a11y, migration, publish Allure report |
| `.github/workflows/qa-nightly.yml` | nightly cron | performance/load, DAST + fuzz, mutation, chaos |
| `.github/workflows/qa-release.yml` | release / dispatch | full suite + **blocking quality gates** |

The existing `e2e.yml` (ke2e) and `ci.yml` build/typecheck gates remain; these add the broader QA
matrix alongside them.

## Quality gates

`make gates` (script: `tests/scripts/quality-gates.sh`) aggregates everything under
`test-results/` and fails the build on:

- any failing test in any JUnit report,
- code coverage below `MIN_COVERAGE` (default 80%),
- any CRITICAL/HIGH security finding in SARIF,
- any k6 performance threshold breach.

It treats missing artifacts as SKIP, so it scales to whatever ran. Migration/contract/a11y failures
surface as JUnit failures and are caught by gate #1.

## Reporting

- **JUnit XML** per category → `tests/test-results/<category>/junit.xml` (CI consumes these).
- **Coverage** → `tests/test-results/unit/coverage/`.
- **Allure portal** (hosted, history/trends): `make report` builds it; `make portal-up` serves it at
  `localhost:5051`. Convert a real run with `bun bin/ke2e.ts allure --from <results.json>`.
- **Catalog** (browse all flows/cases): `bun bin/ke2e.ts catalog`.
- **Screenshots / videos / traces** for failed E2E are retained under `test-results/e2e/artifacts`.

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
- **Pen-test depth** — automated DAST/fuzz covers the breadth; periodic manual pentest is still
  recommended for business-logic abuse.
- **Visual baselines** must be generated on a consistent renderer (CI container) and reviewed by a
  human on first creation.
