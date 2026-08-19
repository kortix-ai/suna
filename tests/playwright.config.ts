import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL || 'http://localhost:3000';
const apiURL = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const environmentProtectionPassword = process.env.WEB_PROTECTION_PASSWORD;
// Staging/preview is behind Vercel SSO deployment protection (ssoProtection,
// passwordProtection is null). Basic-auth httpCredentials does NOT satisfy it —
// every navigation 302s to vercel.com/sso-api. The automation bypass is the
// `x-vercel-protection-bypass` header; `x-vercel-set-bypass-cookie` makes Vercel
// set a cookie so the bypass persists across the app's client-side navigations
// and fetches. Verified against staging: without the header /auth 302s to SSO,
// with it returns 200. Empty locally (no protection there) — headers are no-ops.
const vercelBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
const vercelBypassHeaders: Record<string, string> = vercelBypass
  ? {
      'x-vercel-protection-bypass': vercelBypass,
      'x-vercel-set-bypass-cookie': 'samesitenone',
    }
  : {};
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

// A deployed target (staging/preview) shares one origin with the concurrent
// REST lane, so transient overload (5xx laundered into MAINTENANCE_MODE by the
// edge) shows up as slow/empty page loads. Give deployed runs more retries and
// longer element/action timeouts so a transient blip self-heals; local stays
// tight and fast. Signalled by KE2E_TARGET, which local-runner sets only for
// deployed lanes.
const deployedTarget = Boolean(process.env.KE2E_TARGET);

export default defineConfig({
  testDir: './e2e/specs',
  timeout: 300_000,
  expect: {
    timeout: deployedTarget ? 45_000 : 30_000,
  },
  fullyParallel: true,
  retries: deployedTarget ? 3 : process.env.CI ? 2 : 0,
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
    extraHTTPHeaders: vercelBypassHeaders,
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
