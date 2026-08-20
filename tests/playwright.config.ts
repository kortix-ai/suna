import { defineConfig, devices } from '@playwright/test';

import {
  DEPLOYMENT_BYPASS_STATE_PATH,
  deploymentBypassSecret,
} from './e2e/helpers/deployment-bypass';

const baseURL = process.env.E2E_BASE_URL || 'http://localhost:3000';
const apiURL = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const environmentProtectionPassword = process.env.WEB_PROTECTION_PASSWORD;
// Staging/preview is behind Vercel SSO deployment protection (ssoProtection,
// passwordProtection is null). Basic-auth httpCredentials does NOT satisfy it —
// every navigation 302s to vercel.com/sso-api. The automation bypass is the
// `x-vercel-protection-bypass` header, which Vercel exchanges for a `_vercel_jwt`
// cookie.
//
// That header used to sit in `use.extraHTTPHeaders`, which applies it to EVERY
// request the browser makes. Two defects came out of that: the cross-origin API
// calls then carried it into `Access-Control-Request-Headers`, which the API's
// fixed allow-list rejects (`net::ERR_FAILED` on every browser API call), and the
// secret itself reached 16 third-party hosts. The bypass is a cookie now, minted
// once against the deployment origin by `global-setup.ts`. See
// `e2e/helpers/deployment-bypass.ts` for the full incident.
const vercelBypass = deploymentBypassSecret();

export function resolveBrowserWorkers(value: string | undefined, ci: boolean): number {
  const configuredWorkers = Number.parseInt(value ?? '', 10);
  if (Number.isFinite(configuredWorkers) && configuredWorkers > 0) return configuredWorkers;
  // The warm Daytona lane has 6 vCPU and 12 GiB RAM. One worker keeps cold
  // Next.js route compilation below the guest memory limit. Two local workers
  // keep cold compilation below the full-suite deadline on development Macs.
  if (ci) return 1;
  return 2;
}

const workers = resolveBrowserWorkers(process.env.E2E_BROWSER_WORKERS, Boolean(process.env.CI));

export interface GrepFilters {
  grep?: RegExp;
  grepInvert?: RegExp;
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

function union(sources: string[]): RegExp | undefined {
  if (sources.length === 0) return undefined;
  return new RegExp(sources.join('|'));
}

/**
 * Tag and title filters for the browser lane, read from the environment.
 *
 * A journey that cannot be made deterministic against a deployed target is
 * tagged `@quarantine` at its `test.describe`. The blocking release gate
 * excludes that tag; `tests-browser-nightly.yml` runs exactly that tag and
 * nothing else. Both directions come from here so neither lane needs a custom
 * command line.
 *
 * - `E2E_EXCLUDE_TAGS` / `E2E_INCLUDE_TAGS` — comma-separated tag or title
 *   fragments. Each entry is escaped, so `@quarantine` matches literally and
 *   cannot be read as a regex by accident.
 * - `E2E_GREP_INVERT` / `E2E_GREP` — raw regex escape hatches, unioned with the
 *   tag lists in the same direction.
 *
 * Playwright appends a test's tags to the title it matches `grep`/`grepInvert`
 * against, and it applies both BEFORE `--shard`, so an excluded journey is
 * never loaded, never counted, and never lands in a shard. That is what keeps
 * `strict-skip-reporter.ts` coherent: the reporter fails the lane on a
 * `status === 'skipped'` result, and a grep-excluded test produces no result at
 * all — it is absent, not skipped.
 */
export function resolveGrepFilters(env: NodeJS.ProcessEnv = process.env): GrepFilters {
  const includes = [
    ...splitList(env.E2E_INCLUDE_TAGS).map(escapeForRegExp),
    ...splitList(env.E2E_GREP),
  ];
  const excludes = [
    ...splitList(env.E2E_EXCLUDE_TAGS).map(escapeForRegExp),
    ...splitList(env.E2E_GREP_INVERT),
  ];
  const filters: GrepFilters = {};
  const grep = union(includes);
  const grepInvert = union(excludes);
  if (grep) filters.grep = grep;
  if (grepInvert) filters.grepInvert = grepInvert;
  return filters;
}

const grepFilters = resolveGrepFilters(process.env);

// A deployed target (staging/preview) shares one origin with the concurrent
// REST lane, so transient overload (5xx laundered into MAINTENANCE_MODE by the
// edge) shows up as slow/empty page loads. Give deployed runs more retries and
// longer element/action timeouts so a transient blip self-heals; local stays
// tight and fast. Signalled by KE2E_TARGET, which local-runner sets only for
// deployed lanes.
const deployedTarget = Boolean(process.env.KE2E_TARGET);

// A deployed journey used to get 300s × 4 attempts, so ONE bad journey could eat
// 20 minutes of a worker — enough to explain the whole 40-58 min browser lane by
// itself. The gate is sharded now, so a shard's wall clock is set by its slowest
// journey: cap a deployed attempt at 120s and retry once. Journeys that
// legitimately need longer already declare their own `test.setTimeout(...)`
// (10-billing 300s, 13-sdk-only 12m, 01-account-auth 180s), which overrides this.
// Local and non-deployed CI keep the old 300s/2-retry budget.
const deployedTimeoutMs = Number(process.env.E2E_DEPLOYED_TIMEOUT_MS ?? 120_000);
const deployedRetries = Number(process.env.E2E_DEPLOYED_RETRIES ?? 1);

export default defineConfig({
  testDir: './e2e/specs',
  ...grepFilters,
  // Fails the strict deployed lane in seconds when a required capability is
  // missing, instead of skipping mid-run and reporting it ~50 min later. No-op
  // when E2E_REQUIRE_ALL_BROWSER is unset. See e2e/global-setup.ts.
  globalSetup: './e2e/global-setup.ts',
  timeout: deployedTarget ? deployedTimeoutMs : 300_000,
  expect: {
    timeout: deployedTarget ? 45_000 : 30_000,
  },
  fullyParallel: true,
  retries: deployedTarget ? deployedRetries : process.env.CI ? 2 : 0,
  workers,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: './test-results/html' }],
    ['./e2e/strict-skip-reporter.ts'],
  ],
  outputDir: './test-results/artifacts',
  use: {
    baseURL,
    httpCredentials: environmentProtectionPassword
      ? { username: 'kortix', password: environmentProtectionPassword }
      : undefined,
    // Deployment-protection bypass, scoped to the deployment origin. Written by
    // `global-setup.ts` whenever the secret is set; unset locally, where nothing
    // protects the target.
    storageState: vercelBypass ? DEPLOYMENT_BYPASS_STATE_PATH : undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: deployedTarget ? 30_000 : 20_000,
    navigationTimeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  metadata: {
    baseURL,
    apiURL,
  },
});
