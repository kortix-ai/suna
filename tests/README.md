# Kortix Test Suite

`tests/` is the source of truth for black-box API and CLI product flows.
Each flow has a stable ID and a natural-language contract in
`spec/end-to-end.md`. The implementation uses HTTP and real CLI processes. It
does not import API handlers.

SDK unit and integration tests stay in `packages/sdk`. Browser tests stay in
`tests/e2e`. Those suites use framework-specific assertions and do not belong
in the language-agnostic REST runner.

## Quick Start

```bash
cd suna

# Fast local API + CLI product flows
pnpm test:flows

# One domain or flow
pnpm test:flows -- --domain system,access
pnpm test:flows -- --id ACC-4

# Playwright E2E
pnpm --filter @kortix/tests test:e2e

# Browser tests only (stack already running)
pnpm --filter @kortix/tests test:e2e:browser

```

## Local Flow Runner

`pnpm test:flows` is the default developer test loop. It performs these actions:

1. Reuse local Supabase when it is running. Start it when it is absent.
2. Apply pending `packages/db` migrations to that local database. The loopback-only
   migration mode tolerates ledger order created by switching between worktrees.
3. Reuse the worktree API and gateway when both health checks pass.
4. Otherwise start only the API and gateway on the worktree ports.
5. Run all local-capable REST and CLI flows with one attempt and 4-16 API workers.
6. Stop only the processes that the runner started.
7. Write `test-results/<runId>/results.json` and `report.html`.

The local profile disables Stripe, managed GitHub repositories, cloud sandboxes,
email delivery, Cloudflare tunnels, schedulers, external marketplace sources,
and live `models.dev` refreshes. Flows that require those capabilities do not
silently skip. The runner records each one in `excludedFlows` in `results.json`.
Any selected failure, skip, or todo returns exit code `1`.

Local project fixtures insert rows in local PostgreSQL and create temporary bare
Git repositories. This keeps repository flows real without network calls.

Use `--no-start` to require an already-running API, gateway, and Supabase:

```bash
pnpm test:flows -- --no-start
```

Use `bun tests/bin/ke2e.ts run` only for deployed targets with explicit
`KE2E_*` credentials and capabilities.

## Structure

```
tests/
  package.json            # scripts + playwright dep
  playwright.config.ts    # unified Playwright config
  tsconfig.json
  README.md

  spec/end-to-end.md       # Natural-language flow contracts and stable IDs
  src/flows/*.flow.ts      # Black-box REST and CLI flow implementations
  src/core/                # Runner, reports, local profile, and concurrency

  e2e/                    # End-to-end Playwright + Gate 5 verification
    specs/                #   Playwright specs (run in order)
      01-containers.spec.ts
      02-services.spec.ts
      03-frontend-config.spec.ts
      04-auth-flow.spec.ts
      08-accounts-project-access.spec.ts
      09-admin-ops.spec.ts
      10-production-golden-paths.spec.ts
      11-production-boundaries.spec.ts
      12-sandbox-templates.spec.ts
    helpers/              #   Shared TS utilities
      auth.ts
    scripts/              #   Helper scripts
      run-gate5-local-verification.sh
      run-gate5-target-rehearsal.sh
      secrets-injection-smoke.ts
      terminal-pty-smoke.ts
      verify-gate5-release-evidence.sh

  shell/                  # Shell-based live checks
    vps/                  #   VPS deployment tests (run on VPS)
      test-vps-e2e.sh

```

## Test Categories

### API and CLI flows (`tests/src/flows/`)

These flows cover product behavior from authentication through accounts,
members, invites, billing boundaries, projects, sessions, Git, and CLI commands.
`spec/end-to-end.md` describes each flow from input through final observable
result. `bun tests/bin/ke2e.ts coverage` verifies the route-to-flow mapping.

### Playwright E2E Specs (`tests/e2e/specs/`)

| Spec                         | Tests | What it verifies                                             |
| ---------------------------- | ----- | ------------------------------------------------------------ |
| `01-containers`              | 6     | All Docker containers running                                |
| `02-services`                | 4     | HTTP health checks on all ports                              |
| `03-frontend-config`         | 4     | Runtime config URLs correct (no placeholders)                |
| `04-auth-flow`               | 4     | API auth + browser login                                     |
| `08-accounts-project-access` | 4     | Accounts, invites, project access, and no legacy route leaks |
| `09-admin-ops`               | 2     | Admin overview and operations dashboard                      |
| `10-production-golden-paths` | gated | SPEC 10.5 golden paths when enabled                          |
| `11-production-boundaries`   | gated | SPEC 10.6/10.7 boundaries, SLOs, and negative-space probes   |
| `12-sandbox-templates`       | gated | Sandbox template and snapshot behavior                       |

### Shell Checks (`tests/shell/`)

| Suite                 | What it verifies                               |
| --------------------- | ---------------------------------------------- |
| `vps/test-vps-e2e.sh` | Caddy HTTPS, basic auth, firewall (run on VPS) |

### Real provider smokes (`tests/e2e/scripts/`)

`secrets-injection-smoke.ts` provisions a disposable project and cloud sandbox.
It verifies boot injection, identical-revision sync, deny-all scope, restored
scope, deletion, and shell revocation. The script deletes the session, project,
secret, and test user in its cleanup path.

```bash
dotenvx run -f apps/api/.env -f apps/web/.env -- \
  node --experimental-strip-types \
  tests/e2e/scripts/secrets-injection-smoke.ts platinum
```

## pnpm Scripts

```bash
pnpm test:flows                                         # Local API + CLI flows
pnpm --filter @kortix/tests test                         # Playwright
pnpm --filter @kortix/tests test:e2e                     # Playwright
pnpm --filter @kortix/tests test:e2e:browser             # Playwright only
pnpm --filter @kortix/tests test:e2e:gate5:local         # Local Gate 5 verifier
pnpm --filter @kortix/tests test:e2e:gate5:target        # Target Gate 5 rehearsal
pnpm --filter @kortix/tests test:e2e:gate5:verify-evidence
pnpm --filter @kortix/tests test:shell:vps               # VPS checks
```

## Environment Variables

| Variable             | Default                     | Description         |
| -------------------- | --------------------------- | ------------------- |
| `E2E_OWNER_EMAIL`    | `test-e2e@kortix.ai`        | Test owner email    |
| `E2E_OWNER_PASSWORD` | `e2e-testpass-123`          | Test owner password |
| `E2E_BASE_URL`       | `http://localhost:13737`    | Frontend URL        |
| `E2E_API_URL`        | `http://localhost:13738/v1` | API URL             |
| `E2E_SUPABASE_URL`   | `http://localhost:13740`    | Supabase URL        |

## Note on Unit Tests

Unit tests that live with their packages (e.g. `apps/api/src/__tests__/`,
`packages/*/test/`) stay in-place. They are run through each package's own pnpm
workspace scripts. This directory only centralises integration, E2E, and
cross-cutting tests.
