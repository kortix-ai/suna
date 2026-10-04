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
pnpm test                       # Local REST/CLI flows + SDK + runner units + coverage
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

Full mode also builds, dry-packs, and install-smokes publishable npm packages.
Do not replace this package contract with a separate CI workflow.

The [e2e evaluation and runbook](references/e2e-evaluation.md) defines the opt-in
browser-agent pilot. Keep it outside the default/full/release gates until its
reliability and false-pass criteria are measured. Preserve all existing lanes.

Browser and full modes start local Supabase, migrations, API, gateway, and web.
They reuse a running API only when it proves the deterministic test profile.
Browser runs use two Playwright workers, locally and in each CI shard.

A green `pnpm test` writes `tests/attestations/<branch>.json` (`/` and every char
outside `[A-Za-z0-9._-]` become `-`; a detached HEAD writes
`detached-<short-sha>.json`) and deletes every other file in `tests/attestations/`
plus the legacy `tests/test-attestation.json`; commit `tests/attestations/`.
One file per branch keeps PRs from conflicting on it; deleting a merged PR's
file is conflict-free because no branch edits it again. Format:
`{source_hash, diff_files, diff_hash, head, passed, lanes: {<lane>: pass|fail|skipped-no-db|skipped-sandbox-image}, at}`.
`diff_files` is the files the PR itself changed (`git diff origin/main...HEAD`,
minus every attestation file) and `diff_hash` their sha256; both are recomputed from
the verified rev, so committing the attestation does not change them. Verify
stays green after a merge of `origin/main` that touches other files, and goes
stale only when a file the PR changed is edited after the run. `source_hash`
(the sha256 of every file the commit would contain except attestation files) is
the full-tree fallback used on a direct main push, where there is no diverging
merge-base. Lanes: `core` (sdk, runner units, route coverage, worktree units), `packages`
(package quality), `db-suites` (API/CLI flows + DB suites; both need Docker:
local Supabase, GoTrue, per-suite Postgres containers), and `browser` when
run. Plain `pnpm test` runs all but `browser`. A lane is written only when all
its runner lanes ran in that run or one failed. A filtered or sharded run
(`--id`, `--domain`, a path filter, `--browser-shard`) writes nothing, and a
lane-only mode updates only the lanes it fully covers, on unchanged source.
`pnpm test:verify [--rev <sha>] [--branch <name>]` (`tests/verify-attestation.mjs`)
reads the file the rev's PR diff adds or edits under `tests/attestations/` (with
several, the `--branch` match, else the newest `at`), else `<branch>.json` at the
rev (`--branch`, else the checked-out branch), else the legacy file. It
recomputes the diff: exit `0` green, `1` missing/stale/red. `core` and `packages` must be `pass`,
every other lane must be `pass`. Two skips exist, neither a pass: `db-suites`
`skipped-no-db` (no Docker) and `packages` `skipped-sandbox-image` (a Kortix
sandbox image breaks those tests identically at `origin/main`; the scheduled
clean-runner `Tests` run is the backstop). `--strict` exits `3` for either skip. No in-sandbox
Postgres: the DB lanes depend on Docker in three places, so a Docker-less box
records the skip and the merge gate holds DB PRs.
The `.githooks/pre-push` hook enforces this on every branch push except
`scratch/*`. Never push with `--no-verify`.

Run the narrowest relevant command first. Run `pnpm test` before handoff. Run
`pnpm test -- --full` for testing infrastructure, broad refactors, and release
work.

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

## Your machine is the pre-merge gate

A pull request into `main` runs **no** GitHub Actions job by itself. Every test
for a change runs in the developer's own box before the merge. CI runs on a
schedule on `main` (`Tests` daily, `CI` and `CodeQL` weekly; a push to `main` runs none of
them) and on release pull requests into `staging`
and `prod`. In the rare case you want CI before a `main` merge, add a label: `test`
runs the six lanes once (~9 min), `preview` deploys once (~7 min) with no tests. A push
re-runs neither. Never add them by default. `tests/unit/sandbox-workflow.test.ts`
fails when a workflow other than the label-gated `tests.yml` and
`deploy-preview.yml` triggers on a pull request into `main`: put a new check on
`push: main` or on the release pull requests.

Before a `main` merge, run the narrowest relevant command first, then
`pnpm test`. Add the local equivalent of every CI job your change touches:

| Change touches | CI job (post-merge / release) | Run locally before the merge |
| --- | --- | --- |
| anything | `pnpm test:verify` (merge gate); `Tests` lanes on `staging`/`prod` PRs | `pnpm test` (core) and `pnpm test -- --packages-only` |
| browser-visible behavior | `Tests` browser lanes | `pnpm test -- --browser-only` (or `--full` for everything) |
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

## Run CI lanes natively on Blacksmith

Keep the test commands unchanged. `.github/workflows/tests.yml` runs six lanes
in parallel, each on one Blacksmith runner (`CI_RUNNER_L`, 8 vCPU / 32 GB).
Core and package lanes run `pnpm test` and `pnpm test -- --packages-only`. Four
browser lanes run shards `1/4` through `4/4` via
`pnpm test -- --browser-only --browser-shard=CURRENT/TOTAL` at the exact
requested SHA.

- Check out the requested SHA with `fetch-depth: 1`: the pushed `main` commit,
  or a release pull request's head.
- Run `pnpm install --frozen-lockfile`; Blacksmith serves the pnpm store from
  its cache transparently.
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
