import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL || 'http://localhost:3000';
// Lets CI browser tests pass through Vercel deployment protection (SSO) on staging.
const vercelBypass = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;

export default defineConfig({
  testDir: '.',
  testMatch: ['**/*.spec.ts'],
  timeout: 60_000,
  expect: {
    timeout: 15_000,
  },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['list'],
    ['junit', { outputFile: '../../test-results/e2e/junit.xml' }],
    ['html', { open: 'never', outputFolder: '../../test-results/e2e/html' }],
  ],
  outputDir: '../../test-results/e2e/artifacts',
  use: {
    baseURL,
    extraHTTPHeaders: vercelBypass
      ? { 'x-vercel-protection-bypass': vercelBypass }
      : undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
    actionTimeout: 15_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  metadata: {
    baseURL,
  },
});
