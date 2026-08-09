import { defineConfig, devices } from '@playwright/test';

const baseURL = process.env.E2E_BASE_URL || 'http://localhost:13737';
const apiURL = process.env.E2E_API_URL || 'http://localhost:13738/v1';
const environmentProtectionPassword = process.env.WEB_PROTECTION_PASSWORD;

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
