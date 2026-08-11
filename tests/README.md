# Testing

`pnpm test` is the only repository-level test command.

The default run executes five lanes concurrently:

1. Black-box REST and CLI flows against local Supabase, API, and gateway.
2. `@kortix/sdk` tests in `packages/sdk`.
3. Test-runner unit tests.
4. API route coverage.
5. Worktree-tool unit and contract tests.

The REST runner is language-agnostic at the product boundary. It sends HTTP
requests and starts the compiled CLI as a process. It never imports API route
handlers.

## Commands

```bash
pnpm test                       # Fast local core
pnpm test -- --id ACC-4        # One flow
pnpm test -- --domain access   # One flow domain
pnpm test -- --sdk-only        # SDK only
pnpm test -- --browser-only    # Browser journeys with the deterministic local stack
pnpm test -- --browser-only --browser-shard=1/2 # One deterministic browser shard
pnpm test -- --packages-only   # Every app/package test and publish contract
pnpm test -- --full            # Core, browser, and every app/package test
pnpm test -- --target-smoke    # Deployed staging API SHA and browser smoke
pnpm test -- --target-full     # Every deployed staging API flow and browser journey
```

Browser and full modes start local Supabase, apply migrations, and start the
deterministic API, gateway, and web processes. The runner stops only processes
that it owns. It rejects an ordinary development API because that process can
use live provider settings. The runner reads worktree ports from
`.kortix-worktree.json`. The primary checkout defaults to web `3000`, API
`8008`, gateway `8090`, and Supabase `54321`.

Every root run writes a machine-readable benchmark to:

```text
tests/test-results/local/benchmark-<timestamp>.json
```

The file contains the Git SHA, total duration, lane duration, command, and exit
code.

## Sandbox CI workers

GitHub Actions uses `.github/workflows/tests.yml` for local-profile PR tests.
`tests-pr.yml` calls it once for pull requests into `main` or `staging`. Full
mode starts four warm workers in parallel. Core and package workers run
`pnpm test` and `pnpm test -- --packages-only`. Two browser workers run shards
`1/2` and `2/2` through `pnpm test -- --browser-only --browser-shard=CURRENT/TOTAL`.
Set `provider` to `auto`, `platinum`, or `daytona`. Automatic PR tests use
Daytona directly to avoid Platinum restore latency. Manual runs can select
either provider or `auto`. Auto tries Platinum first. It falls back to Daytona
only when Platinum infrastructure throws. A non-zero test exit returns directly
and does not trigger fallback. Each worker has a unique sandbox run ID and
artifact. The four workers are the parallel equivalent of `pnpm test -- --full`.
Each local browser shard uses one Playwright worker in CI. Two or more workers
can exhaust the 12 GiB Daytona guest while Next.js compiles cold routes. A
disposable worker prestarts Supabase so the root runner reuses it and sandbox
deletion replaces the local Supabase teardown.
Deployed staging browser runs also set two workers explicitly.
Platinum warm restore readiness is capped at 2 minutes. A missing marker or
unreachable guest after that cap is an infrastructure error and triggers auto
fallback. A sandbox reported as `via=cold-boot` gets 45 minutes to prepare the
warm image. This cold preparation budget does not weaken the restore cap.

Both providers use a content-addressed warm image. The image name includes the
`pnpm-lock.yaml` hash. Both images contain pinned Node, Bun, pnpm, Docker,
Chromium, linked `node_modules`, a warm checkout, and pre-pulled Supabase images.
Each worker fetches the requested ref, verifies the exact SHA, runs an offline
lockfile install, starts nested Docker, and invokes the unchanged root command.
Both runners stream logs, download `tests/test-results`, and delete the worker.

## Pull request preview sandboxes

Add the `preview` label to a same-repository pull request into `main`.
`.github/workflows/deploy-preview.yml` then performs this sequence:

1. A repository writer authorizes the exact pull request SHA.
2. Three credential-free jobs build the API, gateway, and frontend images for
   `linux/amd64`.
3. The trusted controller from `main` publishes the three exact SHA tags.
4. The controller restores one warm Platinum sandbox. `auto` uses Daytona only
   when Platinum infrastructure fails.
5. The sandbox generates the standard `kortix self-host` Compose distribution.
6. One overlay adds Caddy, Mailpit, the report mount, and loopback PostgreSQL.
7. The sandbox runs `pnpm test -- --target-full` against its public HTTPS origin.
8. The workflow posts the preview URL and `/_tests/` report URL to the pull
   request. It also creates a GitHub Deployment for `preview/pr-<number>`.

The preview owns PostgreSQL, Supabase Auth, REST, Storage, API, gateway,
frontend, and Mailpit. It does not use the Dev, staging, or production database.
The warm image contains dependencies and Docker layers only. It contains no
preview database and no runtime secret.

The runtime secret allowlist contains `DAYTONA_API_KEY`,
`KE2E_STRIPE_SECRET_KEY`, `KE2E_STRIPE_WEBHOOK_SECRET`, `OPENROUTER_API_KEY`, and the five fields required
for the dedicated preview GitHub App installation. Mailpit handles preview
email. The GitHub App runs the real managed repository and CLI push flows. Its
single `managed-kortix` organization installation must grant access to all
repositories with `Administration: write` and `Contents: write`.
OAuth initiation is the only allowed preview browser exclusion. All API flow
exclusions and all other browser journey exclusions fail the preview test.

Use **Run workflow** to select `platinum` or `daytona` explicitly for one
provider proof. A new deployment deletes any existing provider sandbox for the
same pull request. A test failure keeps the sandbox available for diagnosis.
Removing the label, closing the pull request, or pushing a new commit deletes
the sandbox. A new commit also removes the stale `preview` label. A scheduled
reconciler deletes sandboxes whose pull request is closed, unlabeled, or at a
different SHA.

`tests-release.yml` runs `pnpm test -- --target-full` against deployed staging
for pull requests into `prod`. It does not repeat the local-profile suite.
This mode rejects development and production hosts. It requires the API and gateway
health commits to equal `RELEASE_SOURCE_SHA`. It runs every selected REST and
CLI flow with `--require-all`, then runs all configured Playwright journeys
against `staging.kortix.com` with the Vercel bypass header. A missing external
capability fails the release gate instead of counting as a pass.

The strict browser lane also runs the Stripe-backed billing journey. It proves
that the web app starts Team checkout, reads the activated subscription, starts
a credit purchase, and opens Stripe Billing Portal. The REST `BILL-*` flows own
cancel, reactivate, upgrade, downgrade, and read-back contracts because those
actions do not have separate controls in the Kortix web app.

`pnpm test -- --target-smoke` remains the narrow deployed rehearsal. It runs
only smoke-tagged REST flows and the tagged Playwright smoke.

### Platinum

Platinum first builds a base OCI template. It then derives a stateful template.
The stateful capture boots nested Docker, pulls the Supabase images, removes the
temporary Supabase database, and captures the prepared disk. A lockfile change
creates one new pair. Other commits reuse it.

The worker fetches the requested ref into that warm checkout. It force-checks
out the exact SHA and runs `pnpm install --offline --frozen-lockfile`. It starts
dockerd against the captured image store. The root runner creates fresh
Supabase containers, applies current migrations, and owns the API, gateway, and
web processes. Source changes do not require a template rebuild.

The worker fixes `HOME=/root` before the offline install. This keeps pnpm on the
same store path that the base template used. It prevents pnpm from discarding
the baked `node_modules` trees after a stateful restore.

The base template requests Platinum's `kernel_modules: container` profile.
The capture and worker load those modules before they start dockerd. This
infrastructure does not change test logic.

The capture retries Supabase startup for up to 40 minutes. This absorbs bounded
registry rate limits while preserving the 45-minute cold preparation budget.
The capture and fresh local stack use Supabase's `--ignore-health-check` only
before migrations. This prevents PostgREST from rejecting a new database before
the `kortix` schema exists. The runner still requires migrations and service
readiness before it starts flows.

The worker logs whether Platinum used `via=restore` or `via=cold-boot`. It waits
for the warm marker before it runs tests. It fetches the requested public Git
ref and verifies its full SHA. It streams `kortix-test.log`, downloads
`tests/test-results`, and deletes the sandbox. The worker auto-stops after 15
idle minutes if workflow cancellation prevents immediate deletion.

The control client retries `502`, `503`, `504`, `524`, the provider's transient
`500 operation was aborted` response, timeouts, and connection resets. It uses
bounded exponential backoff. Sandbox deletion uses eight attempts. A failed
deletion fails the workflow and keeps the exact sandbox ID in the log.

### Daytona

Daytona first builds an OCI base snapshot. It starts a temporary builder from
that base. The builder starts nested Docker, creates the exact local-profile
Supabase containers, removes them without a database backup, stops dockerd,
writes a warm marker, and captures the warm snapshot. This capture keeps the
Sysbox nested-Docker mounts that Daytona restores for the disposable worker.
`DAYTONA_CI_TARGET` selects the nested-Docker region. It falls back to
`DAYTONA_TARGET`, then `us`. Do not reuse the product `DAYTONA_WARM_TARGET`.
That product variable can select a different sandbox class or region.

The disposable worker uses 6 vCPU, 12 GiB RAM, and 40 GiB disk. These are the
current Daytona organization maxima. The worker is private.
Its labels include the repository, exact SHA, workflow run ID, and run attempt.
The cleanup command deletes only the exact worker whose name and labels match.
The worker first uses the captured overlay image store. If one Daytona host
cannot mount overlay, it starts a clean `vfs` Docker data root and lets the
unchanged root runner pull the pinned images. Package-only workers skip Docker.

Run a provider explicitly from a checkout with the provider key loaded:

```bash
TEST_SANDBOX_PROVIDER=platinum bun tests/bin/sandbox-ci.ts --full
TEST_SANDBOX_PROVIDER=daytona bun tests/bin/sandbox-ci.ts --full
TEST_SANDBOX_PROVIDER=auto bun tests/bin/sandbox-ci.ts --full
```

## Product flows

`tests/spec/end-to-end.md` is the human-readable contract. Each contract has a
stable flow ID such as `ACC-4`, `BILL-5`, or `LOGIN-1`.

`tests/src/flows/*.flow.ts` implements those contracts. Write every step as a
complete natural-language action and result:

```ts
await ctx.step("owner invites a new email -> 201 pending invite", async () => {
  // Send the same REST request that a client sends.
  // Assert the response that proves the invitation exists.
});
```

A flow must cover the complete observable sequence. Include authentication,
setup, action, read-back proof, failure paths, and cleanup when those steps are
part of the product contract.

The local profile uses real local services. It creates confirmed Supabase users,
PostgreSQL rows, HTTP requests, and temporary bare Git repositories. It disables
Stripe, managed GitHub repositories, cloud sandboxes, external email delivery,
and live catalog refreshes. The result records every excluded external flow.
An excluded selected flow does not count as a pass.

Run deployed targets directly with explicit `KE2E_*` credentials:

```bash
cd tests
bun bin/ke2e.ts run --domain system,access
```

Each flow run writes `results.json` and `report.html` under
`tests/test-results/<runId>/`. Use `results.json` to prove fixture and request
counts. Do not infer those counts from source files.

## Browser journeys

Playwright exists only for behavior that requires a browser. Browser tests live
in `tests/e2e/specs`. API-only behavior belongs in a REST flow.

The browser suite does not repeat every REST contract. It covers selected
browser-visible journeys. REST flows remain authoritative for complete API and
CLI contracts. The browser suite does not claim complete customer-journey
coverage. A browser journey is incomplete when it skips for a missing provider,
OAuth, or mutation capability; report that skip explicitly.

Local browser runs use two Playwright workers. Four workers make cold Next.js
route compilation slower and can exceed the five-minute journey timeout.

The browser lane uses the current worktree web, API, and Supabase ports. It
starts and owns the deterministic local stack. Run it directly:

```bash
pnpm test -- --browser-only
```

The lane writes its Playwright HTML report to
`tests/test-results/html/index.html`. CI includes that directory in the browser
artifact.

The regular browser lane excludes provider-mutating journeys. Set
`E2E_ENABLE_SANDBOX_TEMPLATE_BUILD=1` only for the dedicated sandbox-template
journey. That journey creates and deletes its own product snapshot. The
Platinum CI worker remains a separate infrastructure sandbox.

## SDK tests

SDK tests stay in `packages/sdk`. They protect the published package contract
and framework-free core. Run them through `pnpm test -- --sdk-only` or the
package command documented in `packages/sdk/AGENTS.md`.

## Adding or changing coverage

1. Update `tests/spec/end-to-end.md` when the product contract changes.
2. Add or update the matching flow in `tests/src/flows`.
3. Keep the flow `meta.routes` list exact.
4. Regenerate `tests/spec/routes.generated.json` after route changes with
   `bun run apps/api/scripts/dump-routes.ts`.
5. Run the narrow flow first.
6. Run `pnpm test` before handoff.
7. Run `pnpm test -- --full` for broad refactors or release work.

Full mode also builds, dry-packs, and install-smokes every publishable npm
package before it runs all package and app tests. This keeps published-package
contracts in the same local and Platinum command.

Keep co-located package tests for pure logic and internal invariants. Do not add
a second cross-cutting harness, Makefile lane, Pact suite, Testcontainers suite,
k6 suite, mutation suite, accessibility suite, visual suite, or ad hoc smoke
script under `tests/`.

## Retired harness audit

The August 2026 consolidation removed the parallel runners below. Unique
contracts moved into the canonical lanes before deletion.

| Retired path                                                       | Canonical disposition                                                                                                                            |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tests/accessibility`                                              | Axe checks moved to `tests/e2e/specs/00-accessibility.spec.ts`.                                                                                  |
| `tests/pentest`                                                    | Unique transport checks moved to REST flow `SEC-J`. Existing auth and webhook checks stay in `SEC-A` through `SEC-I`.                            |
| `tests/migration` shell runner                                     | Four unique disposable-Postgres contracts run from `pnpm test -- --packages-only`.                                                               |
| `tests/e2e/specs/10-production-*`                                  | API behavior moved to REST access, project, session, trigger, and security flows. Browser-visible behavior stays in focused Playwright journeys. |
| `tests/self-host-e2e/fast`                                         | Co-located `apps/cli/src/self-host/__tests__` contracts run from the package lane.                                                               |
| `tests/self-host-e2e/live`                                         | Removed as opt-in image-orchestration scripts. They never gated changes and duplicated the CLI and API contracts without deterministic fixtures. |
| Pact, example API, integration, mutation, smoke, and visual suites | Removed because they were placeholders, duplicates, or unmaintained snapshot harnesses.                                                          |
| k6 and session benchmark scripts                                   | Removed from correctness testing. Every root run now writes measured lane timing to the benchmark JSON artifact.                                 |
| Allure, standalone JUnit, portal, and shell quality wrappers       | Removed. The root runner emits its own report and provider workers upload `tests/test-results`.                                                  |
| Infrastructure and security shell wrappers                         | Removed from `tests/`. Dedicated deployment and security workflows retain their platform-specific scanners.                                      |
