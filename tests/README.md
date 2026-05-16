# Kortix Test Suite

All tests for the Kortix platform, centralised in one place.

## Quick Start

```bash
cd computer/tests

# Full A-Z E2E (build images -> install -> browser tests)
bash e2e/self-hosted-e2e.sh

# Browser tests only (stack already running)
bash e2e/self-hosted-e2e.sh --browser-only

# Shell tests only (installer structure, CLI, security)
npm run test:shell

# Everything
npm test
```

## Structure

```
tests/
  package.json            # scripts + playwright dep
  playwright.config.ts    # unified Playwright config
  tsconfig.json
  README.md

  e2e/                    # End-to-end (Playwright + orchestrator)
    self-hosted-e2e.sh    #   Master: clean -> build -> install -> browser tests
    test-self-hosted-install.sh  # Shell-based install + verify
    test-auth-flow.sh     #   Quick auth smoke test
    specs/                #   Playwright specs (run in order)
      01-containers.spec.ts
      02-services.spec.ts
      03-frontend-config.spec.ts
      04-auth-flow.spec.ts
      08-accounts-project-access.spec.ts
      09-admin-ops.spec.ts
      10-production-golden-paths.spec.ts
      11-production-boundaries.spec.ts
    legacy-specs/         #   Quarantined pre-v1 specs, not run by configs
    helpers/              #   Shared TS utilities
      auth.ts
      wait.ts
    scripts/              #   Helper scripts
      reset-self-hosted-state.sh
      run-full-self-hosted-e2e.sh

  shell/                  # Shell-based tests (no browser)
    run-all.sh            #   Runs installer + CLI + security
    installer/            #   get-kortix.sh structure validation
      test-install.sh
      test-e2e-install.sh
    cli/                  #   Embedded CLI verification
      test-cli.sh
    security/             #   Auth, CORS, key sync validation
      test-security.sh
      test-auth-e2e.sh
    vps/                  #   VPS deployment tests (run on VPS)
      test-vps-e2e.sh

  docs/                   # Test documentation
    AUTH_TESTING.md        #   Auth E2E test guide
    E2E_MANUAL_CHECKLIST.md  # Manual verification checklist
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

### Shell Tests (`tests/shell/`)

| Suite | What it verifies |
|-------|------------------|
| `installer/test-install.sh` | get-kortix.sh has correct structure, functions, compose |
| `cli/test-cli.sh` | Embedded CLI has all commands, correct syntax |
| `security/test-security.sh` | INTERNAL_SERVICE_KEY, CORS, port bindings, secrets |
| `security/test-auth-e2e.sh` | Full auth chain: sandbox <-> API <-> frontend |
| `vps/test-vps-e2e.sh` | Caddy HTTPS, basic auth, firewall (run on VPS) |

## npm Scripts

```bash
npm test                    # Shell + Playwright
npm run test:e2e            # Full A-Z orchestrator
npm run test:e2e:browser    # Playwright only
npm run test:shell          # All shell suites
npm run test:shell:installer  # Installer structure
npm run test:shell:cli      # CLI commands
npm run test:shell:security # Security features
npm run test:shell:auth     # Auth E2E (needs running stack)
```

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `E2E_OWNER_EMAIL` | `test-e2e@kortix.ai` | Test owner email |
| `E2E_OWNER_PASSWORD` | `e2e-testpass-123` | Test owner password |
| `E2E_BASE_URL` | `http://localhost:13737` | Frontend URL |
| `E2E_API_URL` | `http://localhost:13738/v1` | API URL |
| `E2E_SUPABASE_URL` | `http://localhost:13740` | Supabase URL |

## Note on Unit Tests

Unit tests that live with their packages (e.g. `apps/api/src/__tests__/`,
`core/kortix-master/tests/`, `packages/*/test/`) stay in-place. They are
run via each package's own `npm test` command. This directory only centralises
integration, E2E, and cross-cutting tests.
