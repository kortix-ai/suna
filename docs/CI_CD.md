# CI/CD Pipeline

Local development and CI use one test command.

## Test command

- `pnpm test` runs local REST and CLI flows, SDK tests, runner tests, route
  coverage, and worktree tests.
- `pnpm test -- --full` adds Playwright and every app/package test.
- `pnpm test -- --packages-only` isolates every app/package and publish check.
- `pnpm test -- --target-smoke` proves the deployed staging SHA and web surface.
- REST and CLI flows use local Supabase, PostgreSQL, API, gateway, and Git.
- External Stripe, email, managed-Git, and cloud-sandbox flows remain explicit
  exclusions in the local profile.

See `tests/README.md` for flow authoring and result files.

## Warm sandbox execution

`.github/workflows/test.yml` is the only test workflow implementation.
`qa-pr.yml`, `qa-staging.yml`, and `qa-release.yml` call it.

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
2. `deploy-dev.yml` deploys the merged SHA to dev.
3. Promote a release candidate to `staging` through a PR.
4. `build-staging.yml` and `deploy-staging.yml` build and deploy staging.
5. `qa-staging.yml` runs the three local lanes at the staging SHA in warm
   sandboxes.
6. Open the reviewed `staging` to `prod` release PR.
7. `qa-release.yml` runs the three local lanes in warm sandboxes.
8. Release QA also requires the deployed staging API and gateway to report
   `RELEASE_SOURCE_SHA`. It runs tagged Playwright against staging web.
9. Merge the release PR.
10. `deploy-prod.yml` publishes and deploys the approved artifact.

Deployment workflows must still prove the deployed SHA and live health. Test
success does not prove deployment success.
