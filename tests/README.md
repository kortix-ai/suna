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
pnpm test -- --browser-only    # Browser journeys; pnpm dev must be running
pnpm test -- --full            # Core, browser, and every app/package test
```

`--full` requires the local stack. Run `pnpm dev` in the primary checkout. In
an isolated worktree, run `pnpm worktree start <name> --billing`; external
Stripe webhook flows remain excluded. The runner reads the current worktree
ports from `.kortix-worktree.json`. The primary checkout defaults to web
`3000`, API `8008`, gateway `8090`, and Supabase `54321`.

Every root run writes a machine-readable benchmark to:

```text
tests/test-results/local/benchmark-<timestamp>.json
```

The file contains the Git SHA, total duration, lane duration, command, and exit
code.

## Platinum CI workers

GitHub Actions uses `.github/workflows/test.yml` for PR, staging, and release
tests. The workflow starts an ephemeral Platinum sandbox and runs the same
`pnpm test -- --full` command inside it.

The template name includes the `pnpm-lock.yaml` hash. Platinum first builds a
base OCI template with pinned Node, Bun, pnpm, Docker, Chromium, linked
`node_modules`, and a warm `/workspace/suna` checkout. Platinum then derives a
stateful template from that base. The stateful capture boots nested Docker,
pulls the exact Supabase images, removes the temporary Supabase database, and
captures the prepared disk. A lockfile change creates one new pair. Other
commits reuse it.

The worker fetches the requested ref into that warm checkout. It force-checks
out the exact SHA and runs `pnpm install --offline --frozen-lockfile`. It starts
dockerd against the captured image store. `pnpm dev` creates a fresh Supabase
database from current migrations without registry pulls. Source changes do not
require a template rebuild.

The capture and worker load the required container modules before they start
dockerd. This infrastructure does not change test logic.

The worker logs whether Platinum used `via=restore` or `via=cold-boot`. It waits
for the warm marker before it runs tests. It fetches the requested public Git
ref and verifies its full SHA. It streams `kortix-test.log`, downloads
`tests/test-results`, and deletes the sandbox. The worker auto-stops after 15
idle minutes if workflow cancellation prevents immediate deletion.

The control client retries `502`, `503`, `504`, `524`, the provider's transient
`500 operation was aborted` response, timeouts, and connection resets. It uses
bounded exponential backoff. Sandbox deletion uses eight attempts. A failed
deletion fails the workflow and keeps the exact sandbox ID in the log.

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

The browser lane uses the current worktree web, API, and Supabase ports. Start
the development stack first:

```bash
pnpm dev
pnpm test -- --browser-only
```

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
