---
name: testing
description: Use for every Kortix test task, behavior change, bug fix, refactor, API route change, CLI change, SDK change, browser journey, test failure, coverage question, local benchmark, or testing infrastructure change. Enforce the single local-first runner, black-box flow contracts, package-local SDK tests, browser-only Playwright tests, and real input/output verification.
---

# Testing

Use one repository-level command: `pnpm test`.

Read `tests/README.md` before changing the runner or adding a product flow. Read
the **sdk** skill before editing the SDK.

## Select the correct test

- Add pure logic and internal invariant tests beside their package code.
- Add a test that needs real PostgreSQL as a DB suite: `integration-*.test.ts`
  or `*.integration.test.ts` in `apps/api/src`, `*.integration.test.ts` in
  `packages/db/scripts`. Read `TEST_DATABASE_URL`; the `db-suites` lane gives
  every file its own fresh migrated database. Create every row you read. See
  `tests/README.md` "DB suites".
- Never `return` early from a DB test when a fixture row is missing. Seed it.
  An early return passes with zero assertions: one suite borrowed an existing
  account and asserted nothing in CI for all 12 of its tests.
- Prove a SQL guard (a `WHERE` predicate, a compare-and-set, a tombstone check)
  in a DB suite. A mocked `db` whose stub returns the receipt proves the stub,
  not the query. Keep mocked-collaborator tests for ordering and branching.
- Add API and CLI product contracts to `tests/spec/end-to-end.md` and
  `tests/src/flows`.
- Keep SDK tests in `packages/sdk`.
- Add Playwright only when the assertion requires a browser.
- Do not create another cross-cutting harness or ad hoc smoke script.

## Write product flows

1. Assign or reuse one stable flow ID.
2. Describe the complete contract in `tests/spec/end-to-end.md`.
3. Implement the contract through HTTP or a real CLI process.
4. Write each `ctx.step()` as one natural-language action and result.
5. Cover authentication, setup, the action, read-back proof, negative paths, and
   cleanup when the contract includes them.
6. List every touched API route in `meta.routes`.
7. Regenerate `tests/spec/routes.generated.json` after route changes.

Do not import API handlers into a product flow. Do not mock the product boundary.
Use reusable local database and bare Git fixtures unless the contract requires
resource isolation.

## Run tests

```bash
pnpm test                       # Whole core suite; refused on a Mac (CI and Linux only)
pnpm test -- --id ACC-4        # One flow
pnpm test -- --domain access   # One domain
pnpm test -- --sdk-only        # SDK only
pnpm test -- --db-only [path-filter ...] # PostgreSQL-backed suites only
pnpm test -- --browser-only    # Browser only; owns the deterministic local stack
pnpm test -- --browser-only --browser-shard=1/4 # One browser shard
pnpm test -- --packages-only   # Every app/package test and publish contract
pnpm test -- --agentic-only tests/example.e2e.ts # Opt-in browser-agent pilot
pnpm test -- --full            # Browser plus all app/package tests
pnpm test -- --target-smoke    # Deployed staging API SHA and Playwright smoke
pnpm test -- --target-full     # Every deployed staging flow and browser journey
```

Plain `pnpm test` runs the whole core suite: flows, DB suites, runner units,
route coverage, worktree units, the SDK, and package quality. It runs in CI
and on Linux. On a Mac it exits `2` (below). A box without Docker drops the
two DB lanes and logs them as skipped, never as a pass.

Full mode also builds, dry-packs, and install-smokes publishable npm packages.
Do not replace this package contract with a separate CI workflow.

The [e2e evaluation and runbook](references/e2e-evaluation.md) defines the opt-in
browser-agent pilot. Keep it outside the default/full/release gates until its
reliability and false-pass criteria are measured. Preserve all existing lanes.

Browser and full modes start local Supabase, migrations, API, gateway, and web.
They reuse a running API only when it proves the deterministic test profile.
Browser runs use two Playwright workers, locally and in each CI shard.

No hook or `dev` merge gate requires a test run, and nothing records one: the
attestation system was removed on 2026-10-16. Write in the PR body what you
ran and why.

Run the narrowest relevant command. A diff that no test reads (docs, a skill,
a standalone script) needs no run.

**A Mac runs targeted tests only.** On macOS the runner refuses a suite-wide run
(plain `pnpm test`, `--full`, `--packages-only`, `--browser-only`, `--db-only`
with no path filter) and exits `2`. 2026-10-16: five agent sessions ran the
suite at once on one laptop (load average 112, swap full). Run one flow, one
DB suite path, the SDK, or one package's test file. The whole suite runs in CI:
add the `test` label once, or set `KORTIX_FULL_TEST=1` when a person asks.

## Prove the result

- Report the exact command, exit code, pass count, fail count, and duration.
- Use `tests/test-results/<runId>/results.json` for request and fixture counts.
- Distinguish parallel flow workers from serialized external provisioning.
- Open `report.html` when a REST or CLI flow fails.
- For browser behavior, assert the DOM result and the relevant network request.
- State every external flow excluded by the local profile.
- Never describe an excluded or skipped flow as passed.

Each root run writes a benchmark to
`tests/test-results/local/benchmark-<timestamp>.json`.

An API performance change reports a measured before/after from
`apps/api/scripts/prompt-latency-bench.ts`. The runbook and the baseline are
in `references/api-latency-baseline.md`.

## Where tests run: one tree, one run

The philosophy is in `AGENTS.md` ("Testing philosophy"). A pull request into
`dev` runs **no** GitHub Actions job by itself, and a push to `dev` runs no
`Tests` lane. Before the merge you run T0 and the tests that cover your change,
and you use the change for real. The `Tests` lanes run on the pull request into
`staging` (the gate) and nightly on `dev`; a red night comments the failing
lanes and suspect commits once per new set of failing lanes. `CI` and `CodeQL`
run weekly on `dev` and on the pull request into `staging`. The pull request
into `prod` runs only `Tests - release` against deployed staging plus the
path-gated SOC 2 scanners. In the rare case
you want CI before a `dev` merge, add a label: `test` runs the lanes once
(~20 min), `preview` deploys once (~7 min) with no tests. A push re-runs
neither. Never add them by default. `tests/unit/sandbox-workflow.test.ts` fails
when a workflow other than the label-gated `tests.yml` and `deploy-preview.yml`
triggers on a pull request into `dev`: put a new check on `push: dev` or on the
release pull requests.

Before a `dev` merge, run the narrowest relevant command first. Add the local
equivalent of every CI job your change touches:

| Change touches | CI job (post-merge / release) | Run locally before the merge |
| --- | --- | --- |
| shared code, the API, the SDK, a migration, the runtime | `Tests` lanes on the `staging` PR and nightly on `dev` | the package's test file, `pnpm test -- --id <ID>` |
| browser-visible behavior | `Tests` browser lanes | drive the page with agent-browser; the `test` label for the browser lanes |
| `apps/api` | `CI` → API typecheck; `Tests` packages lane → API lint | `pnpm --filter kortix-api typecheck` and `pnpm --filter kortix-api lint` (after fixing a violation: `lint:prune`) |
| `apps/web` | `CI` → Frontend build | `pnpm --filter ./apps/web build` |
| `apps/kortix-sandbox-agent-server` | `CI` → Sandbox agent build | `bun run typecheck && bun run lint && bun run test:architecture` in that directory |
| `packages/db/migrations` | `DB Migrations` | the four commands in `packages/db/MIGRATIONS.md` → "CI gates" |
| `apps/web/translations` | `i18n-catalogs` | `node apps/web/scripts/i18n-catalogs.mjs check` |
| `infra/terraform` | `Terraform CI` | `terraform fmt -check -recursive infra/terraform` |
| a `package.json` | install in every lane | `pnpm install --frozen-lockfile --lockfile-only --ignore-scripts` |

Secrets and customer terms need no extra command: the `.githooks` pre-commit
hook encrypts `.env` files and runs `scripts/check-blocked-terms.sh`.

The post-merge `Tests` run on `main` blocks nothing. A red run comments the
failing lanes and every commit since the last green run on the commit. The
author whose commit broke `main` fixes forward; after 1 hour red, anyone may
revert the culprit PR.
The only required check in the repository is `tests-release.yml`'s
`full suite + quality gates`, on a pull request into `prod`, and it tests
DEPLOYED staging.

## Quarantine a browser test

A `@quarantine` tag removes one test from the blocking release gate. It does
not remove the test. The nightly lane runs it.

1. **When.** Quarantine a test only when its root cause is outside our code:
   a real third-party service (Composio toolkit, Google or GitHub OAuth pages),
   a real model reply, or a real cloud sandbox boot. A race, a stale locator, a
   shared fixture, or a product bug is never a reason. Fix those.
2. **Scope.** Tag the one test that depends on the third party. Our own UI
   contract (dialogs, requests, validation) stays in an untagged test with a
   stubbed or no-auth backend. `test.describe.serial` shares a fixture across
   tests, so split the fixture before you tag only part of a file.
3. **Write the reason.** Put a comment above the tag: what is external, the
   run id that showed it, and the condition for removing the tag.
4. **Watcher.** `.github/workflows/tests-browser-nightly.yml` runs
   `@quarantine` against deployed staging every night at 04:20 UTC. It fails
   when a quarantined test is red or when no quarantined test ran, and it
   comments on the commit. It lists each test with its green-night streak.
5. **Owner.** The author who tagged the test owns it. A red nightly run is a
   ticket for that owner, not a release blocker.
6. **Un-quarantine.** When the nightly comment reports a test green for 7
   nights in a row, remove its tag in the next pull request. The blocking gate
   then runs it. A quarantined test with a streak under 7 and no open reason
   is a defect: fix or delete it.

## Run CI lanes natively on GitHub-hosted runners

Keep the test commands unchanged. `.github/workflows/tests.yml` runs four lanes
in parallel, each on one free GitHub-hosted runner (`CI_RUNNER_L`, default
`ubuntu-24.04`: 4 vCPU / 16 GB on this public repo).
Core and package lanes run `pnpm test` and `pnpm test -- --packages-only`. Two
browser lanes run shards `1/2` and `2/2` over the 9 money-path specs (list in
`tests/README.md`), one Playwright worker each, via
`pnpm test -- --browser-only --browser-shard=CURRENT/TOTAL` at the exact
requested SHA.

- Check out the requested SHA with `fetch-depth: 1`: the pushed `main` commit,
  or a release pull request's head.
- Run `pnpm install --frozen-lockfile`.
- Browser lanes: `pnpm --dir tests exec playwright install --with-deps chromium`
  (cached under `PLAYWRIGHT_BROWSERS_PATH`) and
  `pnpm exec supabase start --ignore-health-check` before the root command, and
  `supabase stop --no-backup` in an `always()` step after it.
- Use one Playwright worker for each local-stack browser shard in CI. Keep two
  workers for deployed staging runs, which set `E2E_BROWSER_WORKERS` explicitly.
- Export `KORTIX_PACKAGE_SKIP_SDK_TESTS=1` for the packages lane; the SDK tests
  run in the core lane.
- Keep the guard step and the artifact upload `if: always()`.
- Do not reintroduce a cloud-sandbox worker for these lanes. The
  Platinum/Daytona path (`tests/bin/sandbox-ci.ts`) was removed on 2026-08-26
  after the provider chain failed on its own on about every third lane.
  `deploy-preview.yml` keeps a sandbox because a preview needs a public HTTPS
  origin.

Before a production merge, run `pnpm test -- --target-smoke` against the exact
staging hosts for a narrow rehearsal. The production release gate runs
`pnpm test -- --target-full`. It fails when any selected API flow is skipped,
todo, or failed. Both commands require `RELEASE_SOURCE_SHA` to match the API and
gateway health commits. Keep the Vercel bypass header for Playwright. Reject
development and production targets.

Do not add CI-only test logic. Change `pnpm test` when local and CI behavior
must change together.

## Run a full-stack pull request preview

The `preview` label is not part of the development flow: verify a change on
your worktree's local stack. These rules govern the preview infrastructure for
the rare explicit request.

- Add `preview` only after a writer reviews the exact same-repository PR SHA.
- Build the API, gateway, and frontend without credentials in separate jobs.
- Run the trusted preview controller from `main`.
- Run on Platinum only: the preview host and every session inside it. A
  Platinum failure fails the preview. Never fall back to Daytona.
- Generate the regular `kortix self-host` Compose distribution in the sandbox.
- Give each preview a fresh PostgreSQL and Supabase data plane.
- On a dispatch, run `pnpm test -- --target-full` against the sandbox HTTPS origin.
- Post the preview URL and `/_tests/` report URL in one sticky PR comment.
- Keep a failed product-test sandbox. Do not hide its failure with fallback.
- Deploy only when the label is added or the workflow is dispatched. A push starts nothing. Run `--target-full` only on a dispatch.
- Delete the sandbox on unlabel or branch deletion. Closing the PR does not.
- Tag every preview session box with its host: the preview API runs with
  `KORTIX_INSTANCE_ID=<host sandbox name>` (Platinum `kortix.instance`) and its
  deadline reaper on. Teardown and replacement stop the host's session boxes.
  Each deploy and the hourly reconcile stop session boxes whose host is gone or
  that idled over 6 hours (`tests/src/core/preview-session-reaper.ts`). A suite
  stops the session boxes it created when it ends, on a branch environment too.
- Reconcile stale previews each hour. It stops hosts of closed pull requests
  and hosts idle over 1 hour. Daytona reconciliation only deletes previews
  created before 2026-09-22.

The preview warm image can contain dependencies and Docker layers. It must not
contain a database or runtime secret. Keep the runtime secret allowlist in
`tests/src/core/preview-stack.ts`. Use the dedicated preview GitHub App for the
managed repository and CLI push flows. OAuth initiation remains an explicit
preview exclusion until a stable callback broker exists.
