---
name: testing
description: "The mandatory test-with-every-change discipline for this monorepo. Load WHENEVER you write, change, refactor, or remove ANY code under apps/** or packages/** — a function, class, route, component, hook, schema, migration, config, or bug fix — and whenever you touch anything under tests/, add coverage, run a suite, set up CI, or are asked why a gate failed. Defines which test type each change needs (unit/integration/contract/api/e2e/a11y/visual/perf/security), the exact commands and conventions (co-located bun:test, factories, determinism, no comments), and the CI gates that enforce it. Enforces THE RULE: every possible change ships with tests in the same change."
---

# Testing — every change ships with tests

Kortix is sold to enterprises: the suite must be flawless, deterministic, and auditable.
This is the non-negotiable testing discipline. Companion docs: [`TESTING.md`](../../../TESTING.md),
[`docs/TEST_ARCHITECTURE.md`](../../../docs/TEST_ARCHITECTURE.md), [`docs/CI_CD.md`](../../../docs/CI_CD.md),
[`CONTRIBUTING.md`](../../../CONTRIBUTING.md). For API-route contract flows specifically, also load
[`ke2e-tests`](../ke2e-tests/SKILL.md).

## THE RULE — no change without tests

**Every change that touches behaviour ships with tests in the same change.** New code, changed
code, bug fixes, refactors — all of it. A PR that changes behaviour and adds no test is incomplete
and will not pass review.

- **New export** (function/class/hook/component/schema) → add a co-located `*.test.ts` next to it.
- **Changed behaviour** → update the test to assert the new contract *and* add a case for what
  changed.
- **Bug fix** → first add a test that **fails** reproducing the bug, then fix it (regression lock).
  Reference the incident/issue in the test name.
- **New/changed HTTP route** → add/update the `ke2e` flow in `tests/src/flows/` with `meta.routes`
  in sync (the route-coverage gate enforces this — see the `ke2e-tests` skill).
- **Deleted code** → delete its tests in the same change; never leave orphaned tests.

Carve-outs (no test required): pure formatting/whitespace, comment/docs-only edits, renames with no
behaviour change, generated files. **When in doubt, write the test.**

## Which test for which change

| You changed… | Write… | Where | Runner |
|---|---|---|---|
| A pure function / util / parser | unit test | co-located `*.test.ts` | `bun:test` |
| A React component / hook | unit test (behaviour, a11y where relevant) | co-located `*.test.ts` | `bun:test` |
| A DB schema / Drizzle model | schema-shape unit test (introspection, no live DB) | `packages/db/**` | `bun:test` |
| A service boundary (DB/cache/queue) | integration test | `tests/integration/` | Vitest + Testcontainers |
| An HTTP route / status / auth gate / response shape | `ke2e` flow + `meta.routes` | `tests/src/flows/` | ke2e |
| A consumer/provider API contract | Pact test | `tests/contract/` | Pact |
| A critical user journey / page | e2e | `tests/e2e/specs/` | Playwright |
| UI markup / interactive controls | a11y assertion | `tests/accessibility/` | axe-core |
| Landing/marketing visual surface | visual snapshot | `tests/visual/` | Playwright (platform-suffixed baselines) |
| A hot path's latency/throughput | k6 scenario + SLO threshold | `tests/performance/` | k6 (Docker) |
| Anything with a security surface | a Semgrep rule or pentest probe | `tests/security/`, `tests/pentest/` | Docker scanners |

## Run it (CI == local)

```sh
pnpm test                      # all co-located bun:test suites (every package + app)
pnpm --filter <name> test      # just the package you touched
make fast                      # lint + typecheck + unit + smoke — the pre-push loop
make <lane>                    # unit|integration|api|contract|e2e|visual|a11y|performance|security|migration|chaos|mutation
make gates                     # evaluate quality gates over test-results/
```

The PR gates that enforce THE RULE: `package-tests.yml` (all co-located suites + focused-test guard),
`qa-pr.yml` (`make ci-pr` + 80% product-code coverage gate + ke2e route-coverage). A red gate blocks
the merge.

## Non-negotiable conventions

1. **Deterministic.** No real wall-clock, no network in unit tests, no runner-timezone/ICU/OS
   dependence (assert invariants, not exact locale/ICU strings). Same result every run.
2. **Isolated.** No shared mutable module state, no order dependency. Restore any env/global a test
   touches in `afterEach`. Env-sensitive code: provide config via a `bunfig.toml` preload, never the
   ambient (often `encrypted:`) `.env`.
3. **Arrange → Act → Assert**, one behaviour per test, descriptive `describe`/`test` names.
4. **Targeted assertions** — behaviour, not implementation. No `expect(true).toBe(false)` guards
   (use `rejects.toThrow`), no over-broad snapshots, no exact file-list pins that bitrot.
5. **Factories over fixtures over hardcoded objects** (`tests/_support`, `tests/src/fixtures`).
   No production data, no real credentials, ever. No hardcoded URLs/ports — read from env.
6. **No `.only(`** committed (the focused-test guard fails the build). No `.skip` without a tracked
   reason.
7. **No code comments / docstrings** in test files — lean on names (repo-wide rule).
8. **Tests must typecheck** — green `bun test` is not enough; run the package's `typecheck` too.

## When you finish a change

1. Did every behavioural change get a test? If not, you are not done.
2. `pnpm --filter <name> test` (and `typecheck`) green for what you touched.
3. `make fast` green.
4. New route? `ke2e` flow added and `meta.routes` in sync.
5. The test would **fail** if your change were reverted — verify it actually exercises the change.
