import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL || 'http://localhost:13737';
const apiURL = process.env.E2E_API_URL || 'http://localhost:13738/v1';
// Lets CI browser tests pass through Vercel deployment protection (SSO) on staging.
const vercelBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

export default defineConfig({
  testDir: './e2e/specs',
  timeout: 300_000,
  expect: {
    timeout: 30_000,
  },
  fullyParallel: false,
  retries: process.env.CI ? 2 : 0,
  workers: 1, // sequential — tests depend on prior state
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../test-results/html' }]],
  outputDir: '../test-results/artifacts',
  use: {
    baseURL,
    extraHTTPHeaders: vercelBypass
      ? { 'x-vercel-protection-bypass': vercelBypass }
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
