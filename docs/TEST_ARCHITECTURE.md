# Test Architecture — Kortix Platform

**Status:** Adopted (Phase 2 of the test-suite hardening initiative)
**Audience:** Engineers, QA, security, and enterprise technical due-diligence reviewers.
**Companion docs:** [`TEST_AUDIT.md`](./TEST_AUDIT.md) (before-state) · [`../TESTING.md`](../TESTING.md) (how-to) · [`HANDOVER.md`](./HANDOVER.md) (delta).

This document defines the target architecture. It builds on the genuinely strong foundation already in the repo (the `ke2e` flow framework, Playwright e2e, k6, the tiered CI cadence) and closes the integrity gaps the audit identified. The guiding principle is **make the gates real** — every reported metric must reflect product code, and every gate must be able to fail a build.

---

## 1. Principles

1. **Integrate, don't duplicate.** One framework per concern. The existing `ke2e` Bun harness owns API/contract/smoke; Playwright owns browser e2e/visual/a11y; `bun test` owns unit; Vitest+Testcontainers owns service-boundary integration. We do not add a second tool where one already works.
2. **Gates must gate.** A coverage number, mutation score, or lint pass that cannot fail a build is theatre. Every quality signal is wired to a blocking gate at a defined tier.
3. **Measure product code, not the harness.** Coverage and mutation run against `apps/**`/`packages/**` source, never against example/demonstrator helpers.
4. **Deterministic and isolated.** No shared mutable state, no order dependency, no wall-clock/network flakiness. Retries are for infrastructure faults only — never for assertion failures.
5. **Config from the environment.** No hardcoded URLs, ports, or credentials. Env precedence (`KE2E_*` → `E2E_*` → standard) with safe localhost fallbacks. Secrets come from dotenvx/AWS Secrets Manager (runtime) and GitHub OIDC/secrets (CI).
6. **Fast feedback, full assurance.** The PR tier runs in minutes and blocks; the expensive suites run nightly/pre-prod. Wall-clock budgets: unit < 30s/package, integration < 60s, e2e < 5min, full suite parallelised.
7. **Behaviour over implementation.** Tests assert observable contracts so they survive refactors.

---

## 2. The Testing Pyramid

```
                   ┌───────────────────────┐
                   │   Manual / Exploratory │   periodic, human
                   ├───────────────────────┤
                   │  Performance · Chaos   │   nightly (k6, Toxiproxy/Pumba)
                   │  Security (DAST/SAST)  │   nightly + PR SAST
                   ├───────────────────────┤
                   │   E2E (browser+API)    │   ~5%   Playwright + Gate5
                   │   ke2e flows (283)     │  ~15%   black-box REST contract
                   ├───────────────────────┤
                   │     Integration        │  ~15%   Vitest + Testcontainers
                   │     Contract (Pact)    │         consumer/provider
                   ├───────────────────────┤
                   │        UNIT            │  ~65%   bun:test (product code)
                   └───────────────────────┘
```

| Layer | Target share | Runner | Scope | Tier |
|---|---|---|---|---|
| **Unit** | ~65% | `bun:test` (+ Vitest for `tests/unit` cross-cutting) | Pure logic, isolated, mocked at boundaries | PR (blocking) |
| **Integration** | ~15% | Vitest + `@testcontainers/postgresql` | Real DB/cache/queue at the service boundary | PR (blocking) |
| **Contract** | within integration | Pact | Consumer/provider API contracts | PR (blocking) |
| **API (ke2e)** | ~15% | custom Bun harness | Black-box REST against a live API, 1 flow ⇄ 1 route, route-coverage gate | PR + main (blocking) |
| **E2E** | ~5% | Playwright (+ axe, visual) | Critical user journeys, golden paths, Gate5 evidence | main + release |
| **Performance** | — | k6 | Load/soak/spike/stress with SLO thresholds + regression gate | nightly + release |
| **Chaos** | — | Toxiproxy + Pumba | Resilience under fault injection | nightly |
| **Security** | — | Semgrep/Trivy/ZAP/gitleaks/OSV/CodeQL | SAST (PR), DAST/pentest (nightly/release) | mixed |
| **Accessibility** | — | axe-core via Playwright | WCAG 2.1 A/AA on landing + authenticated app | main |

The pyramid is deliberately bottom-heavy. The audit's biggest correction is to **stop treating the strong ke2e/e2e top of the pyramid as a substitute for a real unit base** — the unit layer must exercise product code and feed an enforced coverage gate.

---

## 3. Tooling Selection (open-source) and Justification

| Concern | Tool | Why this one (vs alternatives) |
|---|---|---|
| Unit runner (apps/packages) | **`bun:test`** | The runtime is Bun; native runner = zero extra deps, fastest startup, built-in `--coverage` (lcov). Jest/Vitest would add a second toolchain over Bun-incompatible internals. |
| Unit runner (cross-cutting) | **Vitest** | Already present under `tests/unit`; v8 coverage + Stryker integration. Kept for Node-targeted cross-cutting logic and as the mutation host. |
| Integration infra | **Testcontainers (postgres)** | Real Postgres per suite, disposable, no shared-state bleed — supersedes the ambiguous tmpfs-compose path for *isolated* integration tests. Compose tmpfs remains for fast local shared runs. |
| Contract | **Pact** | Already adopted; the standard for consumer-driven contracts across the API surface. |
| Browser E2E / visual / a11y | **Playwright + @axe-core/playwright** | One driver for e2e, visual snapshots, and accessibility; trace/video on failure; first-class CI. |
| Performance | **k6** | Scriptable JS, SLO thresholds as code, machine-readable summaries already wired into `quality-gates.sh`. |
| Chaos | **Toxiproxy + Pumba** | Network fault + container chaos without a service mesh; lightweight and already integrated. |
| SAST | **Semgrep + CodeQL** | Semgrep (OWASP rulesets, custom `semgrep.yml`) for fast PR feedback; CodeQL for deep security-and-quality on a schedule. |
| Dependency/container/IaC scan | **Trivy + OSV-Scanner + Checkov + Hadolint** | Trivy (fs+image), OSV (deps), Checkov (IaC), Hadolint (Dockerfile) — full supply-chain coverage, all OSS. |
| Secret scan | **gitleaks** | PR + full-history, hard-fail. |
| DAST | **OWASP ZAP + Schemathesis** | ZAP baseline + schema-fuzz against the OpenAPI spec. |
| Mutation | **Stryker** | The OSS standard; retargeted at product code (see §6). |
| Lint + format | **Biome** | One fast Rust binary for lint **and** format across the whole TS monorepo — replaces the absent ESLint/Prettier sprawl with a single blocking gate and a single config. |
| Reporting | **Allure 3** | Trend history, epic/story grouping, single-file output; published to `qa.kortix.com` via S3 + Argo. JUnit XML + lcov feed it. |
| Orchestration | **Make + pnpm workspaces + GitHub Actions** | Make targets map 1:1 to CI lanes; pnpm `-r` fans tests across packages; Actions tiered cadence. |

**Why Biome over ESLint+Prettier:** the repo had *no* root lint/format config and `make lint` was non-blocking. Introducing ESLint flat config + Prettier + plugins is heavy and slow on a monorepo this size. Biome is a single dependency, formats and lints in one pass, is fast enough to run in pre-push and PR, and gives us one blocking `lint` gate immediately. App-local ESLint (`apps/web`) is retained where Next.js-specific rules are needed.

---

## 4. Directory Structure

The repo uses **two complementary locations** by design:

```
<repo root>
├── apps/<app>/src/**/*.test.ts        ← co-located unit tests (bun:test), next to the code they cover
├── packages/<pkg>/src/**/*.test.ts    ← co-located unit tests (bun:test)
└── tests/                             ← cross-cutting & black-box suites (one home, run via @kortix/tests)
    ├── src/            ke2e flow framework: core/, fixtures/, flows/*.flow.ts   (API/contract/smoke)
    ├── unit/           cross-cutting Vitest unit + mutation host
    ├── integration/    Vitest + Testcontainers (service boundaries)
    ├── contract/       Pact consumer/provider
    ├── e2e/            Playwright specs + Gate5 evidence scripts
    ├── visual/         Playwright visual snapshots + baselines
    ├── accessibility/  axe-core specs
    ├── performance/    k6 load/soak/spike/stress + lib/
    ├── security/       sast/dast/deps/container/secrets scanner wrappers
    ├── pentest/        custom Bun probe harness
    ├── chaos/          Toxiproxy + Pumba
    ├── migration/      DB migration idempotency/rollback/schema
    ├── infra/          Terratest + tflint/checkov/kubeconform
    ├── mutation/       Stryker config (targets product code)
    ├── smoke/          unauthenticated probes
    ├── _support/       factories.ts, fixtures.ts, mocks.ts   (vitest data layer)
    ├── spec/           coverage-baseline.json, routes.generated.json
    ├── scripts/        quality-gates.sh, junit-to-allure.mjs, publish-allure.sh
    └── *.config.ts / allurerc.mjs / docker-compose.test.yml
```

**Rule of placement:**
- A test that exercises one module in isolation → **co-located** `*.test.ts` next to the source.
- A test that crosses package/service boundaries, drives a browser, or is cross-cutting (perf/security/chaos/migration) → **`tests/`**.

**Unified entrypoint (the audit's F-3 fix):** every package declares `"test": "bun test"`; the root exposes `pnpm test` → `pnpm -r --if-present test` plus `pnpm test:unit`, `test:integration`, `test:e2e`, etc. that delegate into `@kortix/tests`. No test can be orphaned from a runnable command.

---

## 5. Test Data Management

- **Factories over fixtures over hardcoded objects.** `tests/_support/factories.ts` (`defineFactory`/`buildMany`, deterministic sequences, epoch-based timestamps) for Vitest; `tests/src/fixtures/` (`world.ts`, `principals.ts`, `provision.ts`, `gc.ts`) for ke2e seeded-world + teardown stack.
- **Deterministic seeds.** No `Date.now()`/random in expected values; sequence counters and `new Date(0)` baselines so reruns are identical.
- **Disposable infrastructure.** Integration tests provision Postgres via Testcontainers (per-suite, auto-torn-down) or a tmpfs compose DB; **every DB test wraps work in a transaction that rolls back** (or targets a throwaway/ephemeral DB) — never the real/shared `kortix` DB. This is a hard rule (see [memory: DB tests ephemeral only]).
- **Garbage collection.** ke2e tracks created entities and reaps orphans (`fixtures/gc.ts`) so live-API runs leave no residue.
- **No production data, ever.** All fixtures are synthetic. Sampled "secrets" are obvious test values (`whsec_test`, `sk_test_*`).

---

## 6. Coverage & Mutation Strategy

| Signal | Tool | Target | Gate |
|---|---|---|---|
| Unit line/branch/func/stmt | `bun test --coverage` (lcov) + Vitest v8 | **80% line + branch** on product code | blocking on PR via `quality-gates.sh` |
| Route coverage | ke2e `catalog.ts` vs `spec/routes.generated.json` | 100% of public routes covered or explicitly allow-listed | blocking |
| Mutation | Stryker (retargeted to `packages/**/src` + selected `apps/api/src`) | informational → ratchet | nightly, report-only initially |

**Critical correction (F-4):** coverage now instruments **product code** via Bun-native lcov (apps/api, packages) merged with Vitest v8 (tests/unit cross-cutting), not the example helpers. The 80% threshold applies to the merged product-code report. Stryker's `mutate` glob moves off `_support/**` onto real source.

Coverage is enforced in `quality-gates.sh` (reads `coverage-summary.json`, fails if `lines.pct < MIN_COVERAGE`, default 80). The gate also fails on: any JUnit failure, any CRITICAL/HIGH SARIF finding, any k6 threshold breach.

---

## 7. CI/CD Integration & Tiering

Tiers map to Make targets and GitHub Actions lanes:

| Lane | Trigger | Runs | Blocking? |
|---|---|---|---|
| **qa-pr** | PR → main/staging/prod | lint · typecheck · **unit (product-code coverage)** · integration · contract · **api/ke2e flows** · SAST (Semgrep) · gates | **Yes** (fast, < 15min) |
| **package-tests** *(new)* | PR | `pnpm -r test` across all apps/packages (the previously-orphaned suites) with dependency caching | **Yes** |
| **qa-staging** | push → staging | e2e · visual · a11y · migration · publish Allure | Yes |
| **qa-nightly** | cron | performance (k6) · DAST (ZAP) · pentest · mutation · chaos · static-security | report + alert |
| **qa-release** | PR → prod | full suite in sequence + gates | **Yes** (pre-prod) |

**Hardening applied:**
- Dependency caching (pnpm store, Bun, Playwright browsers) on every lane — the audit found none.
- `make lint` becomes **blocking** (the `|| true` is removed once Biome config exists).
- The api Bun suite and the ~50 orphaned co-located tests are **run in CI** via the new `package-tests` lane.
- ke2e flow suite is wired into `qa-pr` as a blocking gate (was non-gating WIP).
- Secrets via GitHub OIDC role-assumption for report publishing; `KE2E_*` test creds from GitHub Actions secrets; never static keys.

---

## 8. Determinism, Parallelism & Flakiness

- **Parallelism:** `bun test` runs files in parallel within a package; pnpm `-r` parallelises across packages; Playwright e2e is serial (`workers:1`) only where specs share live-stack state — sharded elsewhere. k6 controls its own concurrency.
- **Isolation:** `bunfig.toml` `isolation=true` (per-file process) prevents `mock.module` leakage; integration tests get a fresh container/transaction.
- **Retry policy (standardised):** infra-only. ke2e never retries `AssertionError` (only `ke2eRetryable`); Playwright retries 2 in CI for genuinely network-bound specs, 0 for visual; no blanket retries that mask product flakiness.
- **Flakiness observability:** Allure `history.jsonl` trends + a flake-rate report; repeatedly-flaky specs are quarantined (tagged, excluded from the blocking gate, tracked) rather than retried into green.

---

## 9. Mocking Strategy

- **Mock at the boundary, not deep in the implementation.** Stub the HTTP client / Stripe SDK / Supabase edge, not internal functions, so tests survive refactors.
- **Centralised, reset per test.** `apps/api/src/__tests__/billing/mocks.ts` (mock registry + `resetMockRegistry()` in `beforeEach`) is the reference pattern; new mocks follow it rather than ad-hoc per-file `mock.module`.
- **Real crypto/signatures.** HMAC/webhook tests construct real signatures (as sandbox-agent-server already does) rather than stubbing crypto — higher fidelity.
- **No mock-app substitution.** Tests labelled "e2e" must exercise the real Hono app, not a re-implemented handler (F-8 fix).
- **MSW** is the chosen browser/edge HTTP mock where Playwright/unit code needs deterministic external responses.

---

## 10. Reporting & Observability

- **Allure 3** is the single pane: epic/story grouping, trend history, single-file artifacts, published to `qa.kortix.com` (S3 bucket `kortix-qa-reports` + Argo-deployed nginx/IRSA pod).
- **JUnit XML** from every runner feeds `quality-gates.sh` and the Allure converter (`junit-to-allure.mjs`).
- **Coverage** as lcov + json-summary (gate input) + HTML (human review).
- **PR comments:** sticky Allure-link comment on `qa-pr`.
- **k6 summaries** as machine-readable JSON consumed by the gate and compared against a committed baseline for regression.

---

## 11. Enterprise / Compliance Readiness

- **Auditability:** every reported metric (coverage %, route coverage, mutation, SARIF) traces to a real artifact in CI; no vanity numbers.
- **Determinism & reproducibility:** external tool versions pinned; "skipped because tool absent" is logged, never silently counted as pass.
- **Traceability:** each ke2e flow maps 1:1 to a route; `CONTRIBUTING.md` requires a flow for every new/changed route (route-coverage gate enforces it).
- **Security evidence:** SAST/DAST/secret/IaC/container scans produce SARIF into GitHub code-scanning; pentest lane provides regression evidence (manual periodic pentest still required for SOC 2/ISO).
- **Onboarding:** `TESTING.md` + `CONTRIBUTING.md` give a new engineer a single command per layer and a clear PR checklist.

---

## 12. Mapping to Audit Findings

| Architecture section | Closes |
|---|---|
| §4 unified entrypoint | F-1, F-2, F-3 |
| §6 product-code coverage | F-4, F-7 |
| §3/§7 Biome + blocking lint | F-5 |
| §3c new package tests | F-6 |
| §9 no mock-app | F-8 |
| §2/§7 ke2e gating | F-10 |
| §5 rollback DB tests | F-12 |
| §8 standardised retries | F-13 |
| §7 dependency caching | F-14 |
| §7 blocking SAST | F-15 |
| §9 mock discipline | F-16 |
| §10/§4 README reconcile | F-17, F-18 |
| §7 pre-push hooks | F-19 |
| §3 pinned tools | F-20 |

---

*Adopted as the target architecture. Phase 3 implements it; Phase 5 validates against §6/§7 gates.*
