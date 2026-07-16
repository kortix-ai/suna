/**
 * Unit tests for the "torn config" detection added to
 * platform/routes/github-app.ts's `GET /status`: a stored App-installation
 * config can go stale when the App half (appId/privateKey) and the
 * installation half (owner/installationId) were written by two different
 * manifest-flow runs — `isConfigured()` only checks that all four fields are
 * present, not that installationId actually belongs to the CURRENT app.
 *
 * `checkManagedGithubAppInstallationHealthy` re-proves that belongs-to-app
 * invariant via `GET /app/installations/{id}` signed with the current app's
 * JWT (same call `getGitHubAppInstallation` makes) — GitHub 404s that call
 * outright when the installation doesn't belong to the signing app.
 *
 * Mocks `platform/services/managed-github-app` (for the appId/privateKey the
 * JWT signer reads) + global fetch. Must run in its own `bun test <file>`
 * invocation (mock.module is process-global — same caveat as
 * unit-github-app-isconfigured.test.ts / unit-github-owner-type-routing.test.ts).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import type { ManagedGithubAppConfig } from '../platform/services/managed-github-app';

const TEST_APP_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

let dbConfig: ManagedGithubAppConfig = { appId: '12345', privateKey: TEST_APP_PRIVATE_KEY };

mock.module('../platform/services/managed-github-app', () => ({
  managedGithubAppConfig: () => dbConfig,
  refreshManagedGithubAppConfig: async () => {},
  invalidateManagedGithubAppConfig: () => {},
  updateManagedGithubAppConfig: async (patch: ManagedGithubAppConfig) => {
    dbConfig = { ...dbConfig, ...patch };
    return dbConfig;
  },
  resetManagedGithubAppConfig: async () => {
    dbConfig = {};
  },
}));

const { checkManagedGithubAppInstallationHealthy, resetManagedGithubAppInstallationHealthCache } =
  await import('../platform/routes/github-app');

// Same `.env`-leak concern as unit-github-owner-type-routing.test.ts: clear
// the env fallbacks so only the mocked DB config drives `createGitHubAppJwt`.
const ENV_KEYS = [
  'KORTIX_GITHUB_APP_ID',
  'GITHUB_APP_ID',
  'KORTIX_GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY',
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

const originalFetch = globalThis.fetch;
let fetchCallCount = 0;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  dbConfig = { appId: '12345', privateKey: TEST_APP_PRIVATE_KEY };
  fetchCallCount = 0;
  resetManagedGithubAppInstallationHealthCache();
  for (const k of ENV_KEYS) delete process.env[k];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    const value = savedEnv[k];
    if (value === undefined) delete process.env[k];
    else process.env[k] = value;
  }
});

function mockInstallationLookup(behavior: 'found' | 'not_found') {
  globalThis.fetch = mock(async (url: string | URL | Request) => {
    const href = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
    if (href.endsWith('/app/installations/501')) {
      fetchCallCount += 1;
      return behavior === 'found'
        ? json({ id: 501, account: { login: 'kortix-managed', type: 'Organization' } })
        : json({ message: 'Not Found' }, 404);
    }
    return json({ message: 'not found' }, 404);
  }) as unknown as typeof fetch;
}

describe('checkManagedGithubAppInstallationHealthy', () => {
  test('true when the installation resolves under the current app', async () => {
    mockInstallationLookup('found');
    expect(await checkManagedGithubAppInstallationHealthy('501')).toBe(true);
  });

  test('false when GitHub 404s (installation belongs to a different/older app, or was removed)', async () => {
    mockInstallationLookup('not_found');
    expect(await checkManagedGithubAppInstallationHealthy('501')).toBe(false);
  });

  test('caches the result — a second call within the TTL does not re-hit GitHub', async () => {
    mockInstallationLookup('found');
    expect(await checkManagedGithubAppInstallationHealthy('501')).toBe(true);
    expect(await checkManagedGithubAppInstallationHealthy('501')).toBe(true);
    expect(fetchCallCount).toBe(1);
  });

  test('resetManagedGithubAppInstallationHealthCache forces a fresh check', async () => {
    mockInstallationLookup('found');
    expect(await checkManagedGithubAppInstallationHealthy('501')).toBe(true);
    resetManagedGithubAppInstallationHealthCache();
    expect(await checkManagedGithubAppInstallationHealthy('501')).toBe(true);
    expect(fetchCallCount).toBe(2);
  });

  test('skipCache bypasses the cache without needing an explicit reset', async () => {
    mockInstallationLookup('found');
    expect(await checkManagedGithubAppInstallationHealthy('501')).toBe(true);
    expect(await checkManagedGithubAppInstallationHealthy('501', { skipCache: true })).toBe(true);
    expect(fetchCallCount).toBe(2);
  });

  test("a different installationId is checked independently (not served from another id's cache entry)", async () => {
    mockInstallationLookup('found');
    expect(await checkManagedGithubAppInstallationHealthy('501')).toBe(true);
    fetchCallCount = 0;
    globalThis.fetch = mock(async (url: string | URL | Request) => {
      const href = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
      fetchCallCount += 1;
      if (href.endsWith('/app/installations/999')) return json({ message: 'Not Found' }, 404);
      return json({ message: 'not found' }, 404);
    }) as unknown as typeof fetch;
    expect(await checkManagedGithubAppInstallationHealthy('999')).toBe(false);
    expect(fetchCallCount).toBe(1);
  });
});
