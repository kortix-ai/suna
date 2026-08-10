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

## Warm sandbox execution

`.github/workflows/tests.yml` is the only warm-sandbox test implementation.
`tests-pr.yml` calls it once for pull requests into `main` or `staging`.
The three parallel lanes equal one `pnpm test -- --full` run.

The workflow starts three workers in parallel. They run core, browser, and
package modes. The slowest worker defines the gate duration.

Each worker performs this sequence:

1. Resolve `kortix-ci-v*-<lock-hash>`.
2. Build the template only when the lockfile hash is new.
3. Create a persistent 8 vCPU, 16 GiB RAM, 50 GiB disk sandbox. This type uses
   Platinum's stateful-restore path. The worker remains disposable.
4. Fetch the requested public Git ref inside the sandbox.
5. Verify the full Git SHA.
6. Run its unchanged root test mode.
7. Upload `tests/test-results` to the GitHub workflow.
8. Delete the sandbox in unconditional runner and workflow cleanup paths.

The template contains pinned Node, Bun, pnpm, Docker, Chromium, and a warm pnpm
store. Product flows that test sandbox lifecycle create separate sandboxes.

Set the provider to `auto`, `platinum`, or `daytona`. Auto tries Platinum first.
It falls back to Daytona only for a Platinum infrastructure error. It does not
hide a non-zero test result.

## Release path

1. Merge development changes to `main`.
2. `deploy-dev.yml` deploys the merged API, gateway, and web SHA to ECS dev.
3. Promote a release candidate to `staging` through a PR.
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
