# Test Suite Hardening — Handover

**Date:** 2026-06-21 · **Branch:** `test-suite`
**Companion docs:** [`TEST_AUDIT.md`](./TEST_AUDIT.md) · [`TEST_ARCHITECTURE.md`](./TEST_ARCHITECTURE.md) · [`../TESTING.md`](../TESTING.md) · [`../CONTRIBUTING.md`](../CONTRIBUTING.md)

## 1. What this was

An enterprise audit + hardening of the Kortix test estate. The codebase already had an ambitious, well-documented suite (the `ke2e` flow framework, Playwright e2e, k6, security lanes, Allure portal). The audit found the problem was **integrity, not absence**: the load-bearing gates were bypassed, vacuous, or non-blocking. This pass made the existing strategy real and enforced, filled the untested packages, and removed the structural foot-guns — without rebuilding what already worked.

## 2. Headline result

- **831 unit tests passing, 0 failing** across all 11 bun-native workspaces (was: ~50 of these orphaned and unrunnable, with hidden red tests).
- **5 previously-untested packages now covered** — `db`, `shared`, `executor-sdk`, `manifest-schema`, `starter` (18 new test files; all typecheck clean).
- **10 pre-existing red/bitrotted tests discovered and fixed** — they were red precisely because they were excluded from CI (the audit's central thesis, now proven).
- **Every package and app is wired to a `test` script and run in CI** via a new pnpm-cached `package-tests` lane.
- The `kortix-api` runner no longer silently skips 12 files or fails-fast.

## 3. Coverage delta

| Package | Before | After |
|---|---|---|
| `packages/db` | untested | 77 tests (schema/enum/FK/PK introspection, lazy client) |
| `packages/shared` | 1 file | 189 tests (utils, tools, constants, formatters) |
| `packages/executor-sdk` | untested | 39 tests (client, URL norm, error mapping, discovery) |
| `packages/manifest-schema` | 1 file | 116 tests (schema validation, grants, triggers, sandbox bounds) |
| `packages/starter` | 1 file | 27 tests (template layers, interpolation, skill listing) |
| `apps/web`, `apps/cli`, `apps/kortix-sandbox-agent-server`, `apps/mobile`, `packages/agent-tunnel` | orphaned (no `test` script) | wired + green in CI |

## 4. Discovered defects fixed (all caused by CI exclusion / bitrot)

| Where | Was failing because | Fix | Type |
|---|---|---|---|
| `packages/agent-tunnel` `config.ts` (3 tests) | `loadConfig` never validated `apiUrl`/`wsPath` | Added `normalizeApiUrl` (reject non-http, strip query/hash) + `absoluteWsPath`, wired into `loadConfig` | **Product** (security-positive) |
| `packages/shared` `credit-formatter.ts` (2) | test imported `CREDITS_PER_DOLLAR`, `creditsToDollars`, `formatDollarsAsCredits` that didn't exist | Added the three exports | **Product** (additive) |
| `apps/cli` `manifest.test.ts` (1) | missing `kortix_version` became an **error**, test still expected a warning | Updated test to assert the stricter behaviour | Test |
| `apps/cli` `scaffold.test.ts` (2) | `BASE_STARTER_PATHS` pinned an exact file list that drifted | Replaced brittle list with invariant + minimal⊆full subset assertions (derived at runtime) | Test (de-brittled) |
| `apps/web` `local-time.test.ts` (1) | exact ICU string (`", "` vs `" at "`) is runtime-dependent | Assert the stable invariant (contains Sun / Jun 7 / 11:30 PM) | Test (determinism) |
| `apps/web` `use-authenticated-preview-url.test.ts` (1) | eager env-validation on import threw; and the test asserted pre-hardening cross-origin behaviour | Added deterministic Bun preload (env scrub) + rewrote the test to lock the **current origin-allowlist security check** | Test + isolation (security-positive) |

Every product change is additive or security-strengthening; none weakens behaviour.

## 5. Structural changes

- **Unified entrypoint** — root `pnpm test` / `test:packages` / `test:apps`; every package/app declares `"test": "bun test"`. No orphaned tests.
- **`apps/api` runner** (`apps/api/scripts/test.sh`) — directory discovery (no globs), no fail-fast, recovers the 9 non-DB tests the old glob dropped, and isolates DB-backed (`test:integration`) and live-external (`test:live`) suites. Adds `test:coverage` (Bun lcov).
- **`apps/web` test preload** (`test-setup.ts` + `bunfig.toml`) — scrubs `encrypted:` dotenvx placeholders and supplies safe `NEXT_PUBLIC_*` config so env-validated modules import deterministically without secrets.
- **Lint/format** — `biome.json` + `.editorconfig` (single config for the TS surface); `noFocusedTests` is an error rule.

## 6. CI / perf

- **`.github/workflows/package-tests.yml`** (new, PR-blocking): runs all co-located `bun:test` suites across packages + apps, **pnpm-store cached** (the audit found no caching), a **focused-test guard** (fails on any committed `.only(`), an **env-gated `kortix-api` job** (runs when `DOTENV_PRIVATE_KEY` is present), and an **advisory Biome ratchet**.
- **Performance regression gate** — `tests/performance/compare-baseline.mjs` + `baseline.json` + `make perf-regression`; fails on >10% p95/error-rate regression vs the committed baseline (SKIPs until a baseline is captured with `pnpm --filter @kortix/tests test:perf:baseline`).

## 7. How to run

```bash
pnpm test                         # all co-located unit suites
pnpm --filter @kortix/shared test # one package
pnpm --filter kortix-api test     # api (needs dotenvx-decrypted env)
make fast                         # lint + typecheck + unit + smoke (cross-cutting)
make gates                        # quality gates over test-results/
pnpm lint:biome                   # lint the TS surface
make perf-regression              # k6 regression vs baseline
```

## 8. Decisions & rationale

- **Biome over ESLint+Prettier** — the repo had no root lint config; one fast binary gives a single blocking gate immediately. Introduced as an **advisory ratchet** (the unlinted backlog can't block PRs on day one); flip to blocking once `pnpm lint:biome` is clean.
- **`make lint` left as `|| true`** — flipping it blocking now would fail every PR against an unlinted monorepo. The focused-test guard + advisory Biome are the enforced lint signals today; the ratchet is documented.
- **`apps/api` in-test anti-patterns documented, not edited** — the `expect(true).toBe(false)` guards (9, across 4 billing files) and the mock-app `helpers.ts` (F-8) are env-gated (need dotenvx to run). They are ugly but **not broken** (a non-throw still fails via the catch assertion). Rather than make unverifiable edits, they're recorded as tracked tech-debt.
- **Coverage gate** — the architecture moves coverage onto Bun-native lcov against product code (`test:coverage`); wiring it as the hard 80% number is the next ratchet step once a baseline run exists in CI.

## 9. Known gaps / next steps (prioritised)

1. **Flip the coverage gate to product code** — run `kortix-api test:coverage` in CI with secrets, merge with Vitest v8, enforce 80% on the merged report (replaces the example-only gate, audit F-4).
2. **Promote the scaffold layers** — `tests/{unit,integration,api,contract,mutation}` still exercise example helpers; point them at real product modules (audit F-7) and retarget Stryker off `_support`.
3. **Capture the perf baseline** — first clean k6 run → `test:perf:baseline` → commit, then the regression gate enforces.
4. **Biome ratchet → blocking** — run `pnpm lint:biome:fix`, resolve residue, make `make lint` fail on findings.
5. **Clean up `apps/api` in-test anti-patterns** — convert `expect(true).toBe(false)` to `rejects.toThrow`; make `helpers.ts` import the real Hono app (F-8).
6. **Pre-existing product typecheck errors in `apps/cli`** (`@kortix/executor-sdk` resolution, implicit anys in `registry.ts`/`mcp.ts`) — out of test-suite scope but worth a follow-up; `apps/web`/`apps/mobile` have no `typecheck` script.
7. **Wire ke2e flows as a blocking PR gate** (audit F-10) and add rollback-wrapped DB integration tests (F-12).

## 10. Files added / changed

**Added:** `docs/TEST_AUDIT.md`, `docs/TEST_ARCHITECTURE.md`, `docs/HANDOVER.md`, `biome.json`, `.editorconfig`, `.github/workflows/package-tests.yml`, `apps/api/scripts/test.sh`, `apps/web/test-setup.ts`, `apps/web/bunfig.toml`, `tests/performance/baseline.json`, `tests/performance/compare-baseline.mjs`, and 18 co-located `*.test.ts` files.

**Changed (source):** `packages/agent-tunnel/src/agent/config.ts`, `packages/shared/src/utils/credit-formatter.ts` (additive/security fixes); test scripts in every package/app `package.json`; root `package.json` (test + lint scripts, Biome devDep); `Makefile` (`perf-regression`); `TESTING.md`, `CONTRIBUTING.md`; and the 6 bitrotted test files in §4.

*Install note:* `@biomejs/biome` was added to root `devDependencies`; run `pnpm install` to materialise it before `pnpm lint:biome` (the `package-tests` lane installs it in CI).
