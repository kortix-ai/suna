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
pnpm test -- --swift-only      # Swift tests + iOS Simulator package build (requires macOS + Xcode)
pnpm test -- --browser-only    # Browser only; owns the deterministic local stack
pnpm test -- --browser-only --browser-shard=1/2 # One browser shard
pnpm test -- --packages-only   # Every app/package test, Rust check, and publish contract
pnpm test -- --full            # Browser plus all app/package tests
pnpm test -- --target-smoke    # Deployed staging API SHA and Playwright smoke
pnpm test -- --target-full     # Every deployed staging flow and browser journey
```

`--swift-only` runs strict `swift format` lint and `swift test` first. It then
runs `xcodebuild build` with
the `KortixSwift-Package` SwiftPM scheme and the `generic/platform=iOS Simulator`
destination. The root runner owns both commands.

`--packages-only` requires Docker and `cargo-deny 0.20.2`. The Rust workspace
pins Rust `1.85.0`. CI installs the policy tool with pinned Rust `1.88.0`, then
runs project checks with the workspace toolchain.

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

## Run CI lanes natively on Blacksmith

Keep the test commands unchanged. `.github/workflows/tests.yml` runs four lanes
in parallel, each on one Blacksmith runner (`CI_RUNNER_L`, 8 vCPU / 32 GB).
Core and package lanes run `pnpm test` and `pnpm test -- --packages-only`. Two
browser lanes run shards `1/2` and `2/2` through
`pnpm test -- --browser-only --browser-shard=CURRENT/TOTAL` at the exact
requested SHA.

- Check out the pull-request head SHA with `fetch-depth: 1`.
- Run `pnpm install --frozen-lockfile`; Blacksmith serves the pnpm store from
  its cache transparently.
- Browser lanes: `pnpm --dir tests exec playwright install --with-deps chromium`
  (cached under `PLAYWRIGHT_BROWSERS_PATH`) and
  `pnpm exec supabase start --ignore-health-check` before the root command, and
  `supabase stop --no-backup` in an `always()` step after it.
- Use one Playwright worker for each local-stack browser shard in CI. Keep two
  workers for deployed staging runs, which set `E2E_BROWSER_WORKERS` explicitly.
- Export `KORTIX_PACKAGE_SKIP_SDK_TESTS=1` for the packages lane in full mode;
  the SDK tests run in the core lane.
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
