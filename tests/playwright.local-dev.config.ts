/**
 * Playwright config for local-dev e2e (Next at :3000, kortix-sandbox at
 * :14000, Supabase at :54321). Separate from playwright.config.ts (which
 * targets the self-hosted bundle on :13737).
 */
import { defineConfig, devices } from '@playwright/test';

process.env.E2E_BASE_URL ||= 'http://localhost:3000';
process.env.E2E_API_URL ||= 'http://localhost:8008/v1';
process.env.E2E_SUPABASE_URL ||= 'http://127.0.0.1:54321';

export default defineConfig({
  testDir: './e2e/specs',
  testMatch: [
    '**/08-accounts-project-access.spec.ts',
    '**/09-admin-ops.spec.ts',
  ],
  timeout: 180_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  retries: 0,
  workers: 1,
  reporter: [['list']],
  outputDir: '../test-results/artifacts-local-dev',
  use: {
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:3000',
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
});
