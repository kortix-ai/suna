---
name: testing
description: Use for every Kortix test task, behavior change, bug fix, refactor, API route change, CLI change, SDK change, browser journey, test failure, coverage question, local benchmark, or testing infrastructure change. Enforce the single local-first runner, black-box flow contracts, package-local SDK tests, browser-only Playwright tests, and real input/output verification.
---

# Testing

Use one repository-level command: `pnpm test`.

Read `tests/README.md` before changing the runner or adding a product flow. Read
`packages/sdk/AGENTS.md` and `packages/sdk/PROGRESS.md` before editing the SDK.

## Select the correct test

- Add pure logic and internal invariant tests beside their package code.
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
pnpm test -- --browser-only    # Browser only; owns the deterministic local stack
pnpm test -- --browser-only --browser-shard=1/2 # One browser shard
pnpm test -- --packages-only   # Every app/package test and publish contract
pnpm test -- --full            # Browser plus all app/package tests
pnpm test -- --target-smoke    # Deployed staging API SHA and Playwright smoke
pnpm test -- --target-full     # Every deployed staging flow and browser journey
```

Full mode also builds, dry-packs, and install-smokes publishable npm packages.
Do not replace this package contract with a separate CI workflow.

Browser and full modes start local Supabase, migrations, API, gateway, and web.
They reuse a running API only when it proves the deterministic test profile.
Local browser runs use two Playwright workers. CI browser shards use one worker.

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

## Run CI in a warm sandbox

Keep the test commands unchanged. GitHub Actions starts four warm workers in
parallel. Core and package workers run `pnpm test` and
`pnpm test -- --packages-only`. Two browser workers run shards `1/2` and `2/2`
through `pnpm test -- --browser-only --browser-shard=CURRENT/TOTAL` at the exact
requested SHA. PR QA selects Daytona to avoid Platinum restore latency. Manual
runs can select `auto`, `platinum`, or `daytona` with
`TEST_SANDBOX_PROVIDER`.

Use one Playwright worker for each local-stack browser shard in CI. Two or more
workers can exhaust the 12 GiB Daytona guest during cold Next.js compilation.
Prestart Supabase in disposable browser workers so sandbox deletion replaces
local Supabase teardown. Keep two workers for deployed staging runs, which set
`E2E_BROWSER_WORKERS` explicitly.

- Use Daytona for the required PR gate. Use `auto` for manual provider fallback.
- In `auto`, try Platinum first when its key exists.
- Fall back to Daytona only when the Platinum runner throws an infrastructure
  error. Return a non-zero test exit without fallback.
- Cap Platinum warm restore readiness at 2 minutes. Treat a missing marker or
  unreachable guest after that cap as infrastructure failure. Keep the cold
  template build budget separate.
- Keep provider selection in sandbox infrastructure. Keep test behavior in the
  unchanged root command.
- Give each provider one content-addressed warm image per lockfile hash.
- Bake Node, Bun, pnpm, Docker, Chromium, linked `node_modules`, and the warm
  checkout into the provider image.
- Pre-pull Supabase images before capturing the warm image.
- Fetch the public pull-request or branch ref inside the sandbox.
- Verify the full 40-character SHA before installing or testing.
- Run the offline lockfile install before starting the root command.
- Stream the worker log and download `tests/test-results` before deletion.
- Delete the sandbox in an unconditional cleanup path.
- Retry transient provider failures with bounded backoff.
- Fail the workflow when sandbox deletion exhausts its retry budget.
- Keep product sandbox-lifecycle flows separate from the CI worker sandbox.
- Give each parallel lane a unique sandbox run ID.

Before a production merge, run `pnpm test -- --target-smoke` against the exact
staging hosts for a narrow rehearsal. The production release gate runs
`pnpm test -- --target-full`. It fails when any selected API flow is skipped,
todo, or failed. Both commands require `RELEASE_SOURCE_SHA` to match the API and
gateway health commits. Keep the Vercel bypass header for Playwright. Reject
development and production targets.

For Platinum:

- Use one `kortix-ci-v*` template per `pnpm-lock.yaml` hash.
- Build one OCI base and one stateful derived template per lockfile hash.
- Pre-pull Supabase images during the stateful capture. Remove the temporary
  database before capture.
- Ignore initial Supabase service health only until migrations create the schema.
- Keep `/workspace/suna` warm. Fetch and force-checkout the requested SHA into
  it, then validate the lockfile with an offline install.
- Set `HOME=/root` before the worker's offline install. The restored process
  must use the same pnpm store path as the base-template build.
- Request Platinum's `kernel_modules: container` template profile.
- Load the injected container modules before starting dockerd.
- Record `via=restore` or `via=cold-boot` for every worker benchmark.
- Use a persistent 8 vCPU, 16 GiB RAM, 50 GiB disk worker for Platinum's
  stateful restore path. Treat it as disposable and always delete it.
- Stream the worker log through the Platinum file API.

For Daytona:

- Build one OCI base snapshot and one warm captured snapshot per lockfile hash.
- Use `DAYTONA_CI_TARGET`, then `DAYTONA_TARGET`, to select the nested-Docker
  region. Do not reuse the product `DAYTONA_WARM_TARGET`.
- Start nested Docker in a temporary builder and pull the exact local-profile
  Supabase images without starting containers.
- Stop dockerd before capturing the warm snapshot.
- Require the warm marker after restore before starting tests.
- Use a private 6 vCPU, 12 GiB RAM, 40 GiB disk worker. These are the current
  Daytona organization maxima.
- Label the worker with the repository, SHA, run ID, and run attempt.
- Delete only a worker whose exact name and labels match the cleanup request.

Do not add CI-only test logic. Change `pnpm test` when local and CI behavior
must change together.

## Run a full-stack pull request preview

- Add `preview` only after a writer reviews the exact same-repository PR SHA.
- Build the API, gateway, and frontend without credentials in separate jobs.
- Run the trusted preview controller from `main`.
- Restore Platinum first. Use Daytona only for an infrastructure failure.
- Generate the regular `kortix self-host` Compose distribution in the sandbox.
- Give each preview a fresh PostgreSQL and Supabase data plane.
- Run `pnpm test -- --target-full` against the sandbox HTTPS origin.
- Post the preview URL and `/_tests/` report URL in one sticky PR comment.
- Keep a failed product-test sandbox. Do not hide its failure with fallback.
- Delete the sandbox on unlabel, close, or PR head change.
- Remove the `preview` label after a PR head change.
- Reconcile stale Platinum and Daytona previews each day.

The preview warm image can contain dependencies and Docker layers. It must not
contain a database or runtime secret. Keep the runtime secret allowlist in
`tests/src/core/preview-stack.ts`. Use the dedicated preview GitHub App for the
managed repository and CLI push flows. OAuth initiation remains an explicit
preview exclusion until a stable callback broker exists.
