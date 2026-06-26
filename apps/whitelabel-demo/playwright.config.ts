import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 45_000,
  expect: { timeout: 10_000 },
  fullyParallel: true,
  webServer: process.env.WHITELABEL_SKIP_WEB_SERVER
    ? undefined
    : {
        command: 'node tests/e2e/dev-server.mjs',
        url: process.env.WHITELABEL_BASE_URL ?? 'http://127.0.0.1:3010',
        reuseExistingServer: false,
        timeout: 120_000,
      },
  use: {
    baseURL: process.env.WHITELABEL_BASE_URL ?? 'http://127.0.0.1:3010',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
