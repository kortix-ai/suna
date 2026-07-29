# Kortix Test Suite

All tests for the Kortix platform, centralised in one place.

## Quick Start

```bash
cd suna

# Playwright E2E
pnpm --filter @kortix/tests test:e2e

# Browser tests only (stack already running)
pnpm --filter @kortix/tests test:e2e:browser

# Everything
pnpm --filter @kortix/tests test
```

## Structure

```
tests/
  package.json            # scripts + playwright dep
  playwright.config.ts    # unified Playwright config
  tsconfig.json
  README.md

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
      verify-gate5-release-evidence.sh

  shell/                  # Shell-based live checks
    vps/                  #   VPS deployment tests (run on VPS)
      test-vps-e2e.sh

```

## Test Categories

### Playwright E2E Specs (`tests/e2e/specs/`)

| Spec | Tests | What it verifies |
|------|-------|------------------|
| `01-containers` | 6 | All Docker containers running |
| `02-services` | 4 | HTTP health checks on all ports |
| `03-frontend-config` | 4 | Runtime config URLs correct (no placeholders) |
| `04-auth-flow` | 4 | API auth + browser login |
| `08-accounts-project-access` | 4 | Accounts, invites, project access, and no legacy route leaks |
| `09-admin-ops` | 2 | Admin overview and operations dashboard |
| `10-production-golden-paths` | gated | SPEC 10.5 golden paths when enabled |
| `11-production-boundaries` | gated | SPEC 10.6/10.7 boundaries, SLOs, and negative-space probes |
| `12-sandbox-templates` | gated | Sandbox template and snapshot behavior |

### Shell Checks (`tests/shell/`)

| Suite | What it verifies |
|-------|------------------|
| `vps/test-vps-e2e.sh` | Caddy HTTPS, basic auth, firewall (run on VPS) |

## pnpm Scripts

```bash
pnpm --filter @kortix/tests test                         # Playwright
pnpm --filter @kortix/tests test:e2e                     # Playwright
pnpm --filter @kortix/tests test:e2e:browser             # Playwright only
pnpm --filter @kortix/tests test:e2e:gate5:local         # Local Gate 5 verifier
pnpm --filter @kortix/tests test:e2e:gate5:target        # Target Gate 5 rehearsal
pnpm --filter @kortix/tests test:e2e:gate5:verify-evidence
pnpm --filter @kortix/tests test:shell:vps               # VPS checks
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `E2E_OWNER_EMAIL` | `test-e2e@kortix.ai` | Test owner email |
| `E2E_OWNER_PASSWORD` | `e2e-testpass-123` | Test owner password |
| `E2E_BASE_URL` | `http://localhost:13737` | Frontend URL |
| `E2E_API_URL` | `http://localhost:13738/v1` | API URL |
| `E2E_SUPABASE_URL` | `http://localhost:13740` | Supabase URL |

## ACP Multi-Harness Protocol Smoke

Run `tests/e2e/scripts/acp-multi-harness-smoke.ts` against a live API. The
script verifies session creation, the headless prompt, a follow-up prompt,
transcript reload, immutable runtime identity, restart, and a post-restart
prompt. The default harness set is `opencode,claude,codex,pi`.

Start the local stack first. The command below loads the encrypted API
environment and the web Supabase anon key without printing either value:

```bash
pnpm dev
```

In another shell:

```bash
E2E_ACP_MULTI_HARNESS_HARNESSES=codex,pi \
E2E_ACP_MULTI_HARNESS_PROVIDER=daytona \
pnpm exec dotenvx run --ignore=MISSING_ENV_FILE \
  -f apps/api/.env.local -f apps/api/.env -f apps/web/.env \
  -- bun tests/e2e/scripts/acp-multi-harness-smoke.ts
```

The script creates a disposable user and project. It stops every created
session and archives the project in `finally`.

| Variable | Default | Description |
|----------|---------|-------------|
| `E2E_ACP_MULTI_HARNESS_HARNESSES` | All four harnesses | Comma-separated harness subset |
| `E2E_ACP_MULTI_HARNESS_PROVIDER` | Project default | Sandbox provider |
| `E2E_ACP_MULTI_HARNESS_MODEL` | Harness default | Explicit session model |
| `E2E_ACP_MULTI_HARNESS_OPENAI_API_KEY` | Unset | Temporary direct key for the disposable project |
| `E2E_KEEP_ACP_MULTI_HARNESS_FIXTURE` | `0` | Set to `1` to preserve the fixture for debugging |
| `E2E_ACP_MULTI_HARNESS_REUSE_PROJECT_ID` | Unset | Reuse an existing test project |
| `E2E_ACP_MULTI_HARNESS_REUSE_EMAIL` | Unset | Login email for the reused project; both reuse variables are required together |

Do not use the gateway provider verification endpoint as harness acceptance.
Run the exact harness and model. The smoke must receive a real assistant reply
and persist the same runtime identity across restart.

## Note on Unit Tests

Unit tests that live with their packages (e.g. `apps/api/src/__tests__/`,
`packages/*/test/`) stay in-place. They are run through each package's own pnpm
workspace scripts. This directory only centralises integration, E2E, and
cross-cutting tests.
