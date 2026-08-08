# CI/CD Pipeline

Local development and CI use one test command.

## Test command

- `pnpm test` runs local REST and CLI flows, SDK tests, runner tests, route
  coverage, and worktree tests.
- `pnpm test -- --full` adds Playwright and every app/package test.
- REST and CLI flows use local Supabase, PostgreSQL, API, gateway, and Git.
- External Stripe, email, managed-Git, and cloud-sandbox flows remain explicit
  exclusions in the local profile.

See `tests/README.md` for flow authoring and result files.

## Platinum execution

`.github/workflows/test.yml` is the only test workflow implementation.
`qa-pr.yml`, `qa-staging.yml`, and `qa-release.yml` call it.

The workflow performs this sequence:

1. Resolve `kortix-ci-v*-<lock-hash>`.
2. Build the template only when the lockfile hash is new.
3. Create an ephemeral 8 vCPU, 16 GiB RAM, 50 GiB disk sandbox.
4. Fetch the requested public Git ref inside the sandbox.
5. Verify the full Git SHA.
6. Run `pnpm test -- --full`.
7. Upload `tests/test-results` to the GitHub workflow.
8. Delete the sandbox.

The template contains pinned Node, Bun, pnpm, Docker, Chromium, and a warm pnpm
store. Product flows that test sandbox lifecycle create separate sandboxes.

The repository requires `PLATINUM_API_KEY`. `PLATINUM_API_URL` defaults to
`https://api.platinum.dev`.

## Release path

1. Merge development changes to `main`.
2. `deploy-dev.yml` deploys the merged SHA to dev.
3. Promote a release candidate to `staging` through a PR.
4. `build-staging.yml` and `deploy-staging.yml` build and deploy staging.
5. `qa-staging.yml` runs the full local suite at the staging SHA on Platinum.
6. Open the reviewed `staging` to `prod` release PR.
7. `qa-release.yml` runs the full local suite at the release SHA on Platinum.
8. Merge the release PR.
9. `deploy-prod.yml` publishes and deploys the approved artifact.

Deployment workflows must still prove the deployed SHA and live health. Test
success does not prove deployment success.
