/**
 * `GET /status`'s installation health check.
 *
 * A stored App backend can go stale for a reason no write-time check can
 * prevent: somebody uninstalls the App on github.com, or the instance identity
 * is replaced. `GET /app/installations/{id}` signed with the CURRENT identity's
 * JWT answers that in one call — GitHub 404s it outright when the installation
 * does not belong to the signing App.
 *
 * Seeds the stored identity (platform/services/github-app-identity.ts) for the
 * appId/privateKey the JWT signer reads, and drives global fetch.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { __setStoredAppIdentityForTests } from '../platform/services/github-app-identity';

const TEST_APP_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

const { checkManagedGithubAppInstallationHealthy, resetManagedGithubAppInstallationHealthCache } =
  await import('../platform/routes/github-app');

// Clear the env identity so only the seeded stored identity drives
// `createGitHubAppJwt` — env wins whole, by design.
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
  __setStoredAppIdentityForTests({ appId: '12345', privateKey: TEST_APP_PRIVATE_KEY });
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
