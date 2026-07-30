import { defineConfig, devices } from '@playwright/test';
import { FIXTURE_PORT } from './fixture-origin';

// Two targets live in this config:
//   roobert.spec.ts            -> the running app, via baseURL
//   descriptor-support.spec.ts -> a static fixture, via FIXTURE_ORIGIN
// The fixture needs a real HTTP origin: @font-face fetches are blocked under
// file://, which yields a fallback face and measurements that look plausible
// and mean nothing. webServer serves the repo root so the fixture page and the
// font binary are both reachable by absolute path.
const baseURL = process.env.E2E_BASE_URL || 'http://localhost:3000';

export default defineConfig({
  testDir: '.',
  testMatch: ['**/*.spec.ts'],
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: [
    ['list'],
    ['junit', { outputFile: '../test-results/typography/junit.xml' }],
  ],
  outputDir: '../test-results/typography/artifacts',
  // cwd defaults to this config's directory, so ../.. is the repo root.
  webServer: {
    command: `python3 -m http.server ${FIXTURE_PORT} --bind 127.0.0.1 --directory ../..`,
    url: `http://127.0.0.1:${FIXTURE_PORT}/apps/mobile/assets/font/Roobert/RoobertCollectionVF.woff2`,
    reuseExistingServer: true,
    timeout: 30_000,
  },
  use: {
    baseURL,
    trace: 'retain-on-failure',
    navigationTimeout: 30_000,
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
});
