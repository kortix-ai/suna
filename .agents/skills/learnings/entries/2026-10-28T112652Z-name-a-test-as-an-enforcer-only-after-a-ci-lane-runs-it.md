---
recorded: 2026-10-28T11:26:52Z
incident_date: 2026-10-28
supersedes: 2026-08-23T183033Z-resolve-a-pnpm-global-package-through-pnpm-root-g.md
---
# Name a test as an enforcer only after a CI lane runs it

**Rule:** A test file is a gate only when a lane discovers it. Each package's `test` script, `tests/unit/vitest.config.ts` (`**/*.test.ts` only), `tests/bin/package-quality.ts` (repo-level files) and the workflows each have their own discovery rule. Before you cite a test in a ledger entry, `.trivyignore`, or a PR body, find the lane that runs it. A green `bun test <file>` on your machine does not prove that. A test outside every discovery rule goes into the nearest lane, or it is deleted.

**Trigger surface:** Adding a test outside a package's own test directory (`scripts/`, `infra/`, `tests/` root, `apps/api/scripts/`, a non-workspace app), a `.test.js` file under `tests/unit`, a test that skips on a condition no lane meets, or a Go or Python test.

**Incident:** 2026-10-28. A dead-test audit found 18 test files that no lane ran, 4 Mailtrap tests skipped in every lane, and an SDK bundle test skipped in CI. Among them: the two lockfile advisory tests that `.trivyignore` cites for the v0.14.9 release scanners (`tests/unit/dependency-advisories.test.js`, `undici-advisory.test.js`, both added 2026-10-27), the app runtime Go tests that guard the 2026-10-22 path-traversal fix, and the enforcer of the superseded entry (`apps/sandbox/opencode-warmup.test.ts`, never run since it was added). The superseded rule stands; its enforcer is gone because OpenCode is sunset.

**Enforcement:** The wired lanes. The `packages-rest` lane runs `bun test ./infra` (every infra test file, current and future), `scripts/eslint-policy.test.mjs`, `scripts/refresh-staged-web-artifacts.test.mjs` and both advisory tests (`tests/bin/package-quality.ts`). `ci.yml` runs `go test ./...` for `apps/kortix-app-runtime`. `terraform-ci.yml` runs every `test_*.py` in `infra/terraform/compliance-monitoring/functions`. None yet for a new orphan elsewhere: a check that every tracked test file matches some lane's discovery rule.
