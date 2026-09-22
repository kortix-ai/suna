# CI/CD Pipeline

Local development and CI use one test command.

`pnpm worktree` owns checkout isolation, ports, dependencies, Supabase topology,
and the callback tunnel. The root test runner reads `.kortix-worktree.json` and
uses that lifecycle instead of creating a second worktree abstraction.

## Test command

- `pnpm test` runs local REST and CLI flows, SDK tests, runner tests, route
  coverage, and worktree tests.
- `pnpm test -- --full` adds Playwright and every app/package test.
- `pnpm test -- --packages-only` isolates every app/package and publish check.
- `pnpm test -- --target-smoke` proves the deployed staging SHA and web surface.
- `pnpm test -- --target-full` runs every configured staging flow and browser
  journey after the same SHA proof. Release QA uses this mode.
- REST and CLI flows use local Supabase, PostgreSQL, API, gateway, and Git.
- External Stripe, email, managed-Git, and cloud-sandbox flows remain explicit
  exclusions in the local profile.

See `tests/README.md` for flow authoring and result files.

## Where the test suite runs

`.github/workflows/tests.yml` is the only local-profile test implementation. It
runs six lanes in parallel — `core`, `browser-1` … `browser-4`, `packages` —
each natively on one Blacksmith runner (`CI_RUNNER_L`, 8 vCPU / 32 GB). The six
lanes equal one `pnpm test -- --full` run. The slowest lane defines the
duration. `--browser-shard=N/4` maps straight to Playwright's native `--shard`.
Each lane is capped at 20 min (57 runs: `packages` p50 370s, max 570s); the cap
is a hang detector, and a hung lane concludes `cancelled`, which the trunk
verdict still reports.

Browser lanes went 2 → 4 on 2026-09-18. Suite wall clock fell from 10m19s
(run `35384964452`) to 8m17s (run `35388565759`). `packages` (~8 min) is now the
slowest lane, so a fifth browser shard buys nothing. The concurrency settings in
`tests/bin/package-quality.ts` bound Bun workers and Docker IO deliberately. Do
not raise them.

| Event | Runs the suite |
| --- | --- |
| push to `main` | yes — post-merge, blocks nothing |
| pull request into `staging` | yes — release candidate |
| pull request labelled `test` or `preview` | yes — the label re-triggers it, no push needed |
| manual dispatch | yes |
| plain pull request into `main` | no — its check shows as skipped |
| pull request into `prod` | no — `tests-release.yml` tests deployed staging |

The old per-pull-request gate cost ~11 min median and 68 min worst case and
gated nothing: `main` and `staging` require no status check. A plain pull request
into `main` now goes green in ~3m20s (measured on PR #7432; CodeQL is the
slowest remaining check). Run the suite locally before merging into `main`: the
narrowest relevant command first, then `pnpm test`.

A red push-to-`main` run comments on the offending commit and names the failing
lanes. A cancelled run means a newer commit superseded it, not a break.

Two workflows test a deployed origin instead of the local profile:

- `deploy-preview.yml` — `pnpm test -- --target-full` against a full self-host
  preview origin, on the `preview` label. It is the only workflow that still uses
  a cloud sandbox.
- `tests-release.yml` — `--target-*-full` against deployed staging on a pull
  request into `prod`. Its aggregator job `full suite + quality gates` is the
  only required status check in the repository.

## Release path

1. Merge development changes to `main`.
2. `deploy-dev.yml` deploys the merged API, gateway, and web SHA to ECS dev.
   `tests.yml` runs the six lanes on the same push in parallel and does not
   gate the deploy.
3. Promote a release candidate to `staging` through a PR. That PR runs
   `tests.yml`; merge it only when the six lanes are green.
4. `build-staging.yml` and `deploy-staging.yml` build and deploy staging.
5. Open the reviewed `staging` to `prod` release PR.
6. `tests-release.yml` requires the deployed staging API and gateway to report
   `RELEASE_SOURCE_SHA`. It runs every configured REST, CLI, and Playwright
   journey against staging. Any excluded API flow fails the gate.
7. Merge the release PR.
8. `deploy-prod.yml` publishes and deploys the approved artifact.

The staging push does not repeat local-profile tests. The production PR does
not repeat them either. The staging PR owns local-profile coverage. The
production PR owns deployed-staging coverage.

Deployment workflows must still prove the deployed SHA and live health. Test
success does not prove deployment success.
