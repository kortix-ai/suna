import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL || 'http://localhost:3000';
const apiURL = process.env.E2E_API_URL || 'http://localhost:8008/v1';
const environmentProtectionPassword = process.env.WEB_PROTECTION_PASSWORD;
export function resolveBrowserWorkers(value: string | undefined, ci: boolean): number {
  const configuredWorkers = Number.parseInt(value ?? '', 10);
  if (Number.isFinite(configuredWorkers) && configuredWorkers > 0) return configuredWorkers;
  // Daytona provides the organization maximum of 12 GiB. Two browsers can
  // make Next dev compile separate project routes concurrently and kill the
  // web process. One worker keeps the local black-box stack stable. Deployed
  // target runs set E2E_BROWSER_WORKERS explicitly.
  if (ci) return 1;
  return 4;
}

const workers = resolveBrowserWorkers(process.env.E2E_BROWSER_WORKERS, Boolean(process.env.CI));

export default defineConfig({
  testDir: './e2e/specs',
  timeout: 300_000,
  expect: {
    timeout: 30_000,
  },
  fullyParallel: true,
  retries: process.env.CI ? 2 : 0,
  workers,
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: '../test-results/html' }],
    ['./e2e/strict-skip-reporter.ts'],
  ],
  outputDir: '../test-results/artifacts',
  use: {
    baseURL,
    httpCredentials: environmentProtectionPassword
      ? { username: 'kortix', password: environmentProtectionPassword }
      : undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 20_000,
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
