# Test Suite Audit — Kortix Platform

**Audit date:** 2026-06-21
**Branch:** `test-suite`
**Scope:** Full monorepo test infrastructure — every test file, config, CI lane, and tooling surface.
**Auditor mandate:** Assess fitness for enterprise sale (auditability, determinism, coverage, compliance-readiness, onboarding speed).

> This is the **before** state. Phase 2 (architecture) and Phase 3 (refactor) will be measured against the findings here. Phase 4 reconciles this file with the post-refactor delta.

---

## 1. Executive Summary

Kortix is a **TypeScript / Bun + pnpm monorepo** (Hono API, Next.js web, React Native mobile, Tauri desktop, Rust-bundled CLI, Drizzle/Supabase/Postgres, Stripe). The test estate is **far more mature than a typical greenfield audit** — there is a deliberate 17-category strategy documented in `TESTING.md`, a custom **`ke2e` API-flow framework** (`tests/src`, ~10,677 LOC, ~283 flows, route-coverage gate), Playwright e2e + visual + a11y, k6 performance, Toxiproxy/Pumba chaos, Semgrep/Trivy/ZAP/gitleaks security lanes, Pact contracts, Stryker mutation, and an Allure portal published to `qa.kortix.com` via S3 + Argo.

The problem is **not absence of testing — it is integrity of the testing that exists.** The headline strategy is undermined by gaps that an enterprise buyer's technical due-diligence would find immediately:

- The **127-file `apps/api` Bun suite is never executed in CI** and its local runner is a hand-maintained glob that **silently skips 12 test files** and **fails-fast** on the first failure.
- **~50 real co-located unit tests** (web, cli, mobile, sandbox-agent-server, packages) have **no `test` script, no runner config, and no root/turbo pipeline** — they are orphaned from every quality gate.
- Several layers (`unit`, `integration`, `api`, `contract`, `mutation`) are **example-only scaffolds** that exercise demonstrator helpers, not product code — so the **80% coverage gate is effectively vacuous** (it measures the examples).
- There is **no lint/format gate**: no ESLint/Biome/Prettier/`.editorconfig` at the root or in `tests/`, and `make lint` ends in `|| true` so it can never fail a build.

**Net:** strong bones, world-class ambition, but the load-bearing gates are either bypassed, vacuous, or non-blocking. The work ahead is to make the existing strategy *real and enforced*, fill the untested surfaces, and remove the structural foot-guns — not to rebuild from scratch.

### Maturity scorecard

| Dimension | Score (1–10) | Rationale |
|---|---|---|
| Strategy & documentation | 8 | `TESTING.md`, `CONTRIBUTING.md`, `AGENTS.md`, 17-category model, ADRs. Ambitious and largely coherent. |
| API test breadth (ke2e) | 8 | 283 flows, route-coverage gate, env-driven, infra-only retry. Genuinely strong. |
| E2E / Playwright | 7 | Real golden-path specs, SLO observe/enforce modes, env-driven. Serial (`workers:1`) ceiling. |
| Unit test reality | 3 | Real unit tests exist but are orphaned (no scripts) or example-only; coverage gate measures scaffolds. |
| Integration / contract | 3 | One Testcontainers "example", one Pact test covering only `/v1/health`. |
| CI enforcement | 4 | api Bun suite not run; e2e.yml non-gating; lint non-fatal; no dep caching. |
| Coverage enforcement | 3 | 80% gate only instruments the vitest example suite; Bun code uninstrumented. |
| Lint / format / hygiene | 2 | No root or tests/ lint config; `make lint` is `|| true`. |
| Security testing | 6 | Many tools wired (Semgrep/Trivy/ZAP/gitleaks/CodeQL/OSV) but several are soft-fail/report-only. |
| Performance / chaos | 7 | Real k6 + Toxiproxy/Pumba, nightly-gated. Baselines not version-pinned for regression. |
| Determinism / flakiness | 6 | ke2e never retries assertions (excellent); Playwright retry policy inconsistent across configs. |
| Test data / fixtures | 7 | Two real factory/fixture layers (`_support`, `tests/src/fixtures`). Good. |
| **Overall** | **~5.0** | Sophisticated surface, compromised core. |

---

## 2. Tech Stack (as detected)

| Concern | Technology |
|---|---|
| Languages | TypeScript (primary), some Go (Terratest), shell, SQL |
| Runtime | **Bun** (api, cli, sandbox-agent-server, packages, ke2e), Node 22 (CI), JSC coverage limitation |
| Package manager | **pnpm 8.11.0** workspaces (`pnpm-workspace.yaml`) |
| API framework | Hono (+ `@hono/zod-openapi`, Scalar reference) |
| Web | Next.js 15 (App Router), React |
| Mobile / Desktop | React Native; Tauri (Rust) |
| Data | Postgres (Supabase), Drizzle ORM |
| Billing | Stripe |
| Unit runners (actual) | `bun:test`, `node:test` (co-located); **Vitest** only under `tests/unit` |
| E2E | Playwright 1.61 (+ `@axe-core/playwright`) |
| Contract | Pact (`@pact-foundation/pact` 15) |
| Integration infra | `@testcontainers/postgresql` 11 **and** `docker-compose.test.yml` (tmpfs Postgres) — two strategies |
| Performance | k6 (external binary) |
| Chaos | Toxiproxy + Pumba (docker) |
| Mutation | Stryker (vitest runner) |
| Security | Semgrep, Trivy, OWASP ZAP, Schemathesis, gitleaks, OSV-Scanner, CodeQL, Checkov, Hadolint, Drata |
| Reporting | Allure 3 (awesome plugin), JUnit XML, v8 lcov/html, Playwright HTML |
| CI | GitHub Actions (18 workflows), Makefile cadence targets, Argo CD / EKS for portal |
| Secrets | dotenvx (encrypted `.env`), AWS Secrets Manager (runtime), GitHub secrets (CI test creds) |

---

## 3. Inventory — what exists

### 3.1 Test file distribution

| Location | Files | Runner | Has `test` script? | Notes |
|---|---|---|---|---|
| `apps/api/src/__tests__` | 127 | `bun:test` | Yes (glob, **skips 12**) | The bulk: `unit-*` (~80), `e2e-*` (~25), `billing/` (10), `integration-*` (2), llm-gateway (4), co-located (6) |
| `tests/src` (ke2e flows) | 42 `.flow.ts` / ~283 flows | custom Bun harness | via `ke2e` CLI | **Crown jewel** — ~10.7k LOC, route-coverage gate |
| `tests/e2e` | 9 Playwright specs | Playwright | yes | Golden-path + Gate5 evidence scripts |
| `tests/performance` | 4 k6 scripts | k6 | yes | load/soak/spike/stress + thresholds |
| `tests/migration` | 3 shell tests | bash | yes | idempotency/rollback/schema |
| `tests/security` | 5 scanner wrappers | shell | yes | sast/dast/deps/container/secrets |
| `tests/chaos` | 2 shell + compose | shell | yes | Toxiproxy + Pumba |
| `tests/infra` | Terratest (Go) | go test | yes | network module + tflint/checkov/kubeconform |
| `tests/pentest` | 1 harness (358 LOC) | Bun | yes | custom probes, prod-guard |
| `tests/contract` | 1 Pact test | vitest+pact | yes | **only `/v1/health`** |
| `tests/integration` | 1 "example" | Testcontainers | yes | demonstrator |
| `tests/unit` | 2 "example" | vitest | yes | **demonstrators only** — drives the 80% gate |
| `tests/api` | 1 "example" | bun:test | yes | demonstrator |
| `tests/accessibility` | 1 axe spec | Playwright | yes | landing page WCAG 2.0/2.1 A/AA |
| `tests/visual` | 1 spec + baselines | Playwright | yes | landing page |
| `tests/mutation` | config only | stryker | yes | **mutates only `_support` examples** |
| `apps/web` | 19 | bun:test + node:test | **NO** | hydration/i18n/auth/security helpers — orphaned |
| `apps/cli` | 6 | bun:test | **NO** | agents/manifest/sandbox-auth — orphaned |
| `apps/kortix-sandbox-agent-server` | 9 | bun:test | **NO** | proxy-auth/env-file/git-cred — orphaned |
| `apps/mobile` | 9 | bun:test + node:test | **NO** | auth/billing/cache — orphaned |
| `packages/agent-tunnel` | 3 | bun:test | **NO** | orphaned |
| `packages/registry` | 1 | bun:test | **Yes** | only package with a real `test` script |
| `packages/shared` | 1 | bun:test | **NO** | only credit-formatter |
| `packages/manifest-schema` | 1 | bun:test | **NO** | validator — orphaned |
| `packages/starter` | 1 | bun:test | **NO** | orphaned |
| **apps/desktop** | **0** | — | — | **untested** (Tauri) |
| **apps/sandbox** | **0** | — | no package.json | **untested** |
| **packages/db** | **0** | — | — | **untested** |
| **packages/executor-sdk** | **0** | — | — | **untested** |

### 3.2 Fixtures / factories / mocks (genuine strengths)

- `tests/_support/{factories,fixtures,mocks}.ts` — `defineFactory`/`buildMany`, deterministic seeds, `fakeClock`, `fakeKeyValueStore`.
- `tests/src/fixtures/` — `world.ts`, `principals.ts` (OWNER/ANON identities), `provision.ts`, `gc.ts` (orphan garbage collection) — a real seeded-world + teardown-stack model.
- `apps/api/src/__tests__/billing/mocks.ts` — centralized mock registry with `resetMockRegistry()` in `beforeEach`. **The strongest mock discipline in the repo.**

---

## 4. Findings (prioritized)

Severity: **P0** = blocks an enterprise sale / silently hides failures · **P1** = material gap · **P2** = quality/tech-debt.

| # | Sev | Finding | Evidence | Impact |
|---|---|---|---|---|
| F-1 | P0 | **`apps/api` Bun suite (127 files) never runs in CI.** No workflow invokes `bun test`/`test:all`. | grep across 18 workflows; `ci.yml` runs only `typecheck`. | The largest suite in the repo provides zero regression protection on PRs or main. |
| F-2 | P0 | **Glob test runner silently skips 12 files and fails-fast.** | `apps/api/package.json:17` — `for f in billing/*.test.ts e2e-*.test.ts unit-*.test.ts; do bun test "$f" || exit 1; done` | `integration-*`, `llm-gateway/*`, and 6 co-located tests never run; first failure hides all later results. |
| F-3 | P0 | **~50 co-located unit tests are orphaned** — no `test` script, no runner config, no root/`turbo.json` pipeline. | web(19)/cli(6)/sandbox-agent-server(9)/mobile(9)/packages — only `apps/api` & `packages/registry` have a `test` script. | Real tests for auth, billing gates, HMAC proxy-auth, i18n, hydration safety are never executed anywhere. |
| F-4 | P0 | **80% coverage gate is vacuous.** Vitest v8 only instruments `tests/unit` which tests *example* helpers; Bun (api/cli) is uninstrumented (JSC). | `tests/unit/vitest.config.ts`, `quality-gates.sh:41-52`; `tests/spec/end-to-end.md:452-470`. | Coverage % is a compliance theater number — it does not reflect product-code coverage. |
| F-5 | P1 | **No lint/format gate anywhere.** No ESLint/Biome/Prettier/`.editorconfig` at root or in `tests/`; `make lint` = `pnpm -r --if-present lint \|\| true`. | root `ls`; `Makefile:40-41`. | Lint findings can never block a PR or release. Inconsistent style, undetectable dead code. |
| F-6 | P1 | **`apps/desktop`, `apps/sandbox`, `packages/db`, `packages/executor-sdk` are entirely untested.** | per-package scan. | `packages/db` (Drizzle schema/migrations) untested is a notable data-integrity risk. |
| F-7 | P1 | **`unit`/`integration`/`api`/`contract`/`mutation` layers are example-only scaffolds.** Stryker mutates only `_support`. | `tests/*/example-*`; `tests/mutation/stryker.conf.json`. | Mutation score and coverage % are vanity metrics; layers signal capability but cover ~0 product code. |
| F-8 | P1 | **"e2e" api tests assert against a re-implemented mock app, not the real Hono app.** | `apps/api/src/__tests__/helpers.ts:29-107` reimplements health/version/404 inline; `e2e-health.test.ts` asserts on it. | False confidence — these tests pass even if production routing breaks. |
| F-9 | P1 | **Contract testing covers only `/v1/health`.** | `tests/contract/health.consumer.pact.test.ts`. | No real provider/consumer contracts for billing, projects, IAM, etc. |
| F-10 | P1 | **`e2e.yml` (ke2e black-box) is non-gating WIP** — no `pull_request` trigger; not wired into promote/deploy. | `e2e.yml:14-50`. | The 283-flow suite cannot block a regression from merging. |
| F-11 | P1 | **Enterprise surfaces thin/untested:** `scim` (SSO provisioning) referenced in 1 test; `marketplace`, `git-proxy`, `ops`, `admin`, `deployments` shallow. | api module-vs-test cross-ref. | SCIM/SSO is exactly what enterprise buyers scrutinize. |
| F-12 | P2 | **Real-DB integration tests lack rollback/teardown convention** — additive migrations to local Postgres risk state bleed. | `integration-*`, `e2e-billing-routes`; no transaction-rollback wrapper observed. | Order-dependent flakiness on shared DB. |
| F-13 | P2 | **Inconsistent flaky-retry policy.** Playwright retries 2 (qa-pr/main), 1 (a11y), 0 (visual/local-dev). No flaky quarantine/reporting. | `tests/playwright.config.ts` vs `tests/visual/playwright.config.ts:19`. | Visual/local flakes fail hard; no flake-rate observability across the fleet. |
| F-14 | P2 | **No dependency caching in CI** (only Rust cached). Every job cold-installs. | `ci.yml`, `qa-*.yml`. | Slow, costly pipelines; discourages running full suites. |
| F-15 | P2 | **Several security scanners are soft-fail/report-only.** Checkov `soft_fail`, `security-scan.yml` Trivy `exit-code:0`, nightly static-security `continue-on-error`. | respective workflows. | Misconfig/vuln findings don't block; only ci.yml Trivy-fs, gitleaks, Drata, deploy-dev image scan are hard gates. |
| F-16 | P2 | **Anti-patterns in api tests:** `expect(true).toBe(false)` should-throw guards; module-level mutable fixtures (`let projectSecretValue` mutated across tests); ~10 files use sleeps/timers. | `billing/webhooks.test.ts:104-110`; `e2e-session-llm-router.test.ts:11`. | Brittle assertions, order-dependency, flake risk. |
| F-17 | P2 | **`tests/README.md` drift** — documents <20% of the actual suite (only Playwright + VPS); omits ke2e, performance, security, chaos, mutation, contract, pentest. | `tests/README.md`. | Onboarding mismatch; contributors won't discover the real architecture. |
| F-18 | P2 | **Two overlapping Postgres strategies** (compose tmpfs vs Testcontainers) with no documented canonical choice. | `docker-compose.test.yml` vs `tests/integration/example-postgres.test.ts`. | Ambiguity; divergent local vs CI behavior. |
| F-19 | P2 | **Pre-commit/pre-push hooks only guard secrets**, are opt-in (`git config core.hooksPath .githooks`), and run no lint/typecheck/fast-tests. No husky/lint-staged. | `.githooks/pre-commit`, `pre-push`. | Broken code reaches CI before any local feedback. |
| F-20 | P2 | **External tool assumption is implicit** — k6, Semgrep, Checkov, Toxiproxy, Pumba, psql, go are required but not declared in any manifest; layers silently skip if absent. | `tests/package.json` devDeps vs shell wrappers. | Non-reproducible runs; "green" can mean "skipped." |

> **Correction to a preliminary finding:** vitest cache `results.json` files exist under `tests/*/node_modules/.vite/` but are **not** git-tracked (`git ls-files tests | grep node_modules` → 0). Not a committed-artifact issue.

---

## 5. Coverage gaps by layer

| Layer | State | Gap |
|---|---|---|
| **Unit** | Real tests exist but ~50 orphaned (F-3) + example-only gate suite (F-4, F-7) | No enforced, product-code unit coverage. Untested: db, executor-sdk, desktop, sandbox. |
| **Integration** | 1 Testcontainers demonstrator | No real service-boundary tests (DB, Stripe, Supabase, daytona) under the integration label; api integration-* tests skipped by glob. |
| **API / E2E (ke2e)** | Strong (283 flows) | Not gating in CI (F-10); coverage-baseline allowlists known-uncovered routes. |
| **Browser E2E** | 9 real specs | Serial only (`workers:1`); golden paths gated behind env flags (may not run by default). |
| **Contract** | 1 endpoint | ~no real microservice contracts (F-9). |
| **Performance** | 4 k6 scripts, nightly | Baselines not version-pinned; no automated >10% regression gate against stored baseline. |
| **Security** | Many tools | Several soft-fail (F-15); SAST/DAST not blocking on PRs. |
| **Accessibility** | 1 page | Only landing; no authenticated-app a11y coverage. |
| **Mutation** | config only | Mutates examples; no product-code mutation testing. |

---

## 6. Structural problems

1. **No unified test entrypoint.** No root `test` script, no `turbo.json`, no `pnpm -r test` convention. Each suite is discovered and run differently; ~50 tests have no entrypoint at all.
2. **Gates that don't gate.** Coverage (vacuous), lint (`|| true`), e2e (non-gating WIP), several scanners (soft-fail). The *appearance* of enforcement exceeds the reality — the most dangerous failure mode for an audited buyer.
3. **Two test-data infra strategies, two unit runners** (`bun:test`/`node:test` vs Vitest) with no documented boundary — `TESTING.md` says Vitest, the code uses Bun.
4. **Self-referential testing.** Example scaffolds, mock-app "e2e" tests, and example-only mutation/coverage create metrics that measure the test harness, not the product.

---

## 7. Missing tooling

- ESLint/Biome **flat config** + Prettier (or Biome formatter) at root, applied to `tests/**` and app code, wired to a **blocking** `lint` gate.
- `.editorconfig` at root.
- `turbo.json` (or a root `test`/`test:unit` script) so every package's tests run via one command and in CI.
- **Bun-native coverage** (`bun test --coverage`) wired into the gate so product code — not examples — is measured.
- **husky + lint-staged** (or non-opt-in `.githooks`) running lint + fast unit + typecheck pre-push.
- **Dependency caching** (pnpm store, Bun, Playwright browsers) in CI.
- A **flaky-test tracker** (Allure history is present; needs a quarantine + flake-rate report wired into the gate).
- **Performance regression gate** comparing k6 output to a committed baseline (fail >10%).

---

## 8. Risk areas (enterprise lens)

- **Auditability:** Coverage and mutation numbers do not reflect product code — a SOC 2 / due-diligence reviewer comparing reported metrics to reality would flag this. (`docs/WHATS_MISSING.md` already concedes the broader compliance posture is process-incomplete.)
- **Regression protection:** The two largest real suites (api Bun, ke2e flows) are not enforced on the PR path — the merge gate is weaker than the suite implies.
- **Enterprise feature risk:** SCIM/SSO, marketplace, billing edge cases under-covered exactly where enterprise contracts care most.
- **Data integrity:** `packages/db` (Drizzle schema/migrations) untested; integration tests mutate a shared DB without rollback.
- **Reproducibility:** "Green" can mean "skipped" when external tools are absent; no manifest pins them.

---

## 9. Tech-debt register

| Item | Location | Action |
|---|---|---|
| Glob test runner | `apps/api/package.json:17` | Replace with directory-based `bun test src/__tests__` (no globs, no fail-fast). |
| Mock-app "e2e" helpers | `apps/api/src/__tests__/helpers.ts` | Import the real Hono app; delete the re-implementation. |
| `expect(true).toBe(false)` | `billing/webhooks.test.ts` + repeats | Convert to `expect(...).rejects.toThrow()`. |
| Module-level mutable fixtures | `e2e-session-llm-router.test.ts:11` et al. | Move into `beforeEach`-scoped state. |
| README drift | `tests/README.md` | Rewrite to describe all 17 categories (Phase 4). |
| Example scaffolds | `tests/{unit,integration,api,contract,mutation}` | Either point at real product modules or relabel clearly as templates. |
| `make lint \|\| true` | `Makefile:40` | Make lint blocking once a config exists. |
| Orphaned tests | web/cli/mobile/sandbox-agent-server/packages | Add `test` scripts + root pipeline (F-3). |

---

## 10. What is genuinely good (preserve in refactor)

- **ke2e framework** — 283 flows, route-coverage gate, infra-only retry (never retries `AssertionError`), env precedence (`KE2E_*` → `E2E_*`), garbage collection of orphaned fixtures. Best-in-class.
- **Billing mock registry** — centralized, reset per test.
- **`tests/_support` + `tests/src/fixtures`** factory/seeder layers.
- **Env-driven configuration everywhere** — localhost fallbacks, no hardcoded prod URLs or real secrets (sampled fixtures only: `whsec_test`, `sk_test_*`).
- **Quality-gates aggregator** (`tests/scripts/quality-gates.sh`) unifying JUnit + coverage + SARIF + k6.
- **Allure portal** (`qa.kortix.com`) with trend history via S3 + Argo.
- **Tiered CI cadence** (`qa-pr` → `qa-staging` → `qa-nightly` → `qa-release`) — the right shape; it just needs the gates made real.

---

## 11. Recommended remediation order (preview of Phase 2/3)

1. **Make existing gates real** (P0): unify a root test entrypoint, run the api Bun suite + orphaned tests in CI, replace the glob runner, switch coverage to Bun-native against product code, make `qa-pr` block on the ke2e flow suite.
2. **Add the missing hygiene layer** (P1): ESLint/Biome flat config + Prettier + `.editorconfig` + blocking lint gate; husky/lint-staged; dependency caching.
3. **Fill coverage gaps** (P1): real unit tests for db/executor-sdk/shared/manifest-schema; promote example layers to product-code integration/contract tests; SCIM/SSO and billing edge cases; authenticated-app a11y.
4. **Harden** (P2): rollback-wrapped integration DB tests, consistent retry/flake policy, performance regression baseline, blocking SAST on PRs, README reconciliation.

---

---

## 12. Remediation delta (post-Phase 3)

See [`HANDOVER.md`](./HANDOVER.md) for full detail. Summary of what changed against the findings above:

| Finding | Status | What was done |
|---|---|---|
| F-1 api suite not in CI | **Resolved** | New `package-tests.yml` runs it (env-gated job) |
| F-2 glob skips 12 / fails-fast | **Resolved** | `apps/api/scripts/test.sh` — directory discovery, no fail-fast, lanes for integration/live |
| F-3 ~50 orphaned tests | **Resolved** | Every package/app has a `test` script + root entrypoint + CI lane |
| F-4 vacuous coverage gate | **Partially** | Bun-native `test:coverage` lane added; flipping the 80% gate onto it is next step (HANDOVER §9.1) |
| F-5 no lint gate | **Partially** | `biome.json` + `.editorconfig` + focused-test guard added; full lint is an advisory ratchet |
| F-6 untested packages | **Resolved** | db/shared/executor-sdk/manifest-schema/starter now covered (478 tests) |
| F-7 example-only scaffolds | **Open** | Promotion path documented (HANDOVER §9.2) |
| F-8 mock-app "e2e" | **Documented** | Tech-debt; env-gated, tracked |
| F-12 DB rollback | **Open** | Documented |
| F-13 retry/flake inconsistency | **Partially** | ICU/TZ determinism bugs fixed in web; policy documented in architecture |
| F-14 no CI caching | **Resolved** | pnpm-store cache in `package-tests.yml` |
| F-16 anti-patterns | **Partially** | Brittle/non-deterministic test assertions fixed (web, cli); `expect(true).toBe(false)` documented |

**Before → after (unit layer):** ~50 real tests orphaned and unrunnable, with hidden red tests → **831 passing, 0 failing** across all bun-native workspaces, all wired into CI; 5 packages went from untested to covered; 10 bitrotted tests discovered and fixed.

*Audit complete. Architecture in [`TEST_ARCHITECTURE.md`](./TEST_ARCHITECTURE.md); implementation summary in [`HANDOVER.md`](./HANDOVER.md).*
