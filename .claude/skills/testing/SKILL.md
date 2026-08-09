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
pnpm test -- --full            # Browser plus all app/package tests
```

Full mode also builds, dry-packs, and install-smokes publishable npm packages.
Do not replace this package contract with a separate CI workflow.

Browser and full modes start local Supabase, migrations, API, gateway, and web.
They reuse a running API only when it proves the deterministic test profile.

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

## Run CI on Platinum

Keep the test command unchanged. GitHub Actions invokes
`bun tests/bin/platinum-ci.ts`, and the Platinum worker runs `pnpm test` or
`pnpm test -- --full` at the exact requested SHA.

- Use one `kortix-ci-v*` template per `pnpm-lock.yaml` hash.
- Build one OCI base and one stateful derived template per lockfile hash.
- Bake Node, Bun, pnpm, Docker, Chromium, linked `node_modules`, and the warm
  checkout into the base.
- Pre-pull Supabase images during the stateful capture. Remove the temporary
  database before capture.
- Ignore initial Supabase service health only until migrations create the schema.
- Keep `/workspace/suna` warm. Fetch and force-checkout the requested SHA into
  it, then validate the lockfile with an offline install.
- Request Platinum's `kernel_modules: container` template profile.
- Load the injected container modules before starting dockerd.
- Record `via=restore` or `via=cold-boot` for every worker benchmark.
- Fetch the public pull-request or branch ref inside the sandbox.
- Verify the full 40-character SHA before installing or testing.
- Use a persistent 8 vCPU, 16 GiB RAM, 50 GiB disk worker for Platinum's
  stateful restore path. Treat it as disposable and always delete it.
- Stream the worker log through the Platinum file API.
- Download `tests/test-results` before deleting the sandbox.
- Delete the sandbox in an unconditional cleanup path.
- Retry transient provider failures with bounded backoff.
- Fail the workflow when sandbox deletion exhausts its retry budget.
- Keep product sandbox-lifecycle flows separate from the CI worker sandbox.

Do not add CI-only test logic. Change `pnpm test` when local and CI behavior
must change together.
