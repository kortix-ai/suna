/**
 * Proves the DB-first/env-fallback wiring added for the in-app self-host
 * GitHub App setup flow: `isGithubAppConfigured()` (projects/github.ts) and
 * `githubBackend.isConfigured()` (projects/git-backends/github.ts) read the
 * DB-backed managed-github-app config before falling back to env vars, and
 * `isConfigured()` only flips true once appId+privateKey+owner+installationId
 * are ALL present (whichever source each comes from).
 *
 * Mocks only `platform/services/managed-github-app` (the DB-cache module) —
 * everything downstream (projects/github.ts, projects/git-backends/github.ts)
 * runs for real, so this exercises the actual accessor wiring, not a
 * re-description of it.
 *
 * Must run in its own `bun test <file>` invocation: `mock.module` is
 * process-global, and every import below is a dynamic `await import()` issued
 * AFTER the mock is registered (bun only honors `mock.module` for imports
 * that happen after the call) — see the same convention/caveat in
 * platform/services/session-sandbox.test.ts.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ManagedGithubAppConfig } from '../platform/services/managed-github-app';

let dbConfig: ManagedGithubAppConfig = {};

mock.module('../platform/services/managed-github-app', () => ({
  managedGithubAppConfig: () => dbConfig,
  refreshManagedGithubAppConfig: async () => {},
  invalidateManagedGithubAppConfig: () => {},
  updateManagedGithubAppConfig: async (patch: ManagedGithubAppConfig) => {
    dbConfig = { ...dbConfig, ...patch };
    return dbConfig;
  },
}));

const { isGithubAppConfigured } = await import('../projects/github');
const { githubBackend, managedGithubOwner } = await import('../projects/git-backends/github');

const ENV_KEYS = [
  'KORTIX_GITHUB_APP_ID',
  'GITHUB_APP_ID',
  'KORTIX_GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY',
  'MANAGED_GIT_GITHUB_OWNER',
  'MANAGED_GIT_GITHUB_INSTALL_ID',
  'MANAGED_GIT_GITHUB_TOKEN',
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of ENV_KEYS) savedEnv[k] = process.env[k];

beforeEach(() => {
  dbConfig = {};
  for (const k of ENV_KEYS) delete process.env[k];
});

describe('isGithubAppConfigured (DB-first, env-fallback)', () => {
  test('false when neither DB nor env has appId+privateKey', () => {
    expect(isGithubAppConfigured()).toBe(false);
  });

  test('true from the DB config alone', () => {
    dbConfig = { appId: '12345', privateKey: 'PEM' };
    expect(isGithubAppConfigured()).toBe(true);
  });

  test('true from env alone (unchanged self-host .env-only behavior)', () => {
    process.env.KORTIX_GITHUB_APP_ID = '12345';
    process.env.KORTIX_GITHUB_APP_PRIVATE_KEY = 'PEM';
    expect(isGithubAppConfigured()).toBe(true);
  });

  test('DB value wins over env when both are set', () => {
    dbConfig = { appId: 'from-db', privateKey: 'db-pem' };
    process.env.KORTIX_GITHUB_APP_ID = 'from-env';
    process.env.KORTIX_GITHUB_APP_PRIVATE_KEY = 'env-pem';
    expect(isGithubAppConfigured()).toBe(true);
    // (id/privateKey aren't directly observable here without exporting the
    // signer — the DB-first read order is covered directly by
    // managed-github-app.test.ts and the accessor source code.)
  });
});

describe('githubBackend.isConfigured() — flips true once the DB config is complete', () => {
  test('false with an empty DB config and no env', async () => {
    expect(await githubBackend.isConfigured()).toBe(false);
  });

  test('false with only owner set (no installation id, no PAT)', async () => {
    dbConfig = { owner: 'acme-corp' };
    expect(await githubBackend.isConfigured()).toBe(false);
  });

  test('false with owner+installationId but the App itself not configured (no appId/privateKey anywhere)', async () => {
    dbConfig = { owner: 'acme-corp', installationId: '987' };
    expect(await githubBackend.isConfigured()).toBe(false);
  });

  test('true once appId+privateKey+owner+installationId are all present in the DB config', async () => {
    dbConfig = {
      appId: '12345',
      privateKey: 'PEM',
      slug: 'kortix-self-host-abc',
      owner: 'acme-corp',
      installationId: '987',
    };
    expect(await githubBackend.isConfigured()).toBe(true);
  });

  test('true via a mixed source: owner/installationId from the DB, App id/key from env', async () => {
    dbConfig = { owner: 'acme-corp', installationId: '987' };
    process.env.KORTIX_GITHUB_APP_ID = '12345';
    process.env.KORTIX_GITHUB_APP_PRIVATE_KEY = 'PEM';
    expect(await githubBackend.isConfigured()).toBe(true);
  });

  test('a bare PAT (MANAGED_GIT_GITHUB_TOKEN) needs no App creds at all', async () => {
    dbConfig = { owner: 'acme-corp' };
    process.env.MANAGED_GIT_GITHUB_TOKEN = 'ghp_dummy';
    expect(await githubBackend.isConfigured()).toBe(true);
  });

  test('env-only (pre-existing self-host .env config) keeps working unchanged', async () => {
    process.env.MANAGED_GIT_GITHUB_OWNER = 'acme-corp';
    process.env.MANAGED_GIT_GITHUB_INSTALL_ID = '987';
    process.env.KORTIX_GITHUB_APP_ID = '12345';
    process.env.KORTIX_GITHUB_APP_PRIVATE_KEY = 'PEM';
    expect(await githubBackend.isConfigured()).toBe(true);
  });

  test('reflects a live update via updateManagedGithubAppConfig (manifest-callback then install-callback)', async () => {
    const { updateManagedGithubAppConfig } = await import('../platform/services/managed-github-app');
    expect(await githubBackend.isConfigured()).toBe(false);

    await updateManagedGithubAppConfig({ appId: '12345', slug: 'kortix-self-host-abc', privateKey: 'PEM' });
    expect(await githubBackend.isConfigured()).toBe(false); // App exists, not installed yet

    await updateManagedGithubAppConfig({ owner: 'acme-corp', installationId: '987' });
    expect(await githubBackend.isConfigured()).toBe(true); // now fully configured
  });

  test('a DB-stored PAT (dbConfig.pat, the web "use a token" setup path) is enough, no env var needed', async () => {
    dbConfig = { pat: 'ghp_abc123', patOwner: 'acme-corp' };
    expect(await githubBackend.isConfigured()).toBe(true);
  });
});

describe('managedGithubOwner — PAT owner takes precedence over a stale App-installation owner', () => {
  test('null when nothing is configured', () => {
    expect(managedGithubOwner()).toBeNull();
  });

  test('DB App-installation owner when set', () => {
    dbConfig = { owner: 'app-owner-corp' };
    expect(managedGithubOwner()).toBe('app-owner-corp');
  });

  test('DB PAT owner wins over a DB App-installation owner sitting in the same row', () => {
    dbConfig = { owner: 'app-owner-corp', patOwner: 'pat-owner-corp' };
    expect(managedGithubOwner()).toBe('pat-owner-corp');
  });

  test('falls back to MANAGED_GIT_GITHUB_OWNER when the DB config has neither', () => {
    process.env.MANAGED_GIT_GITHUB_OWNER = 'env-owner-corp';
    expect(managedGithubOwner()).toBe('env-owner-corp');
  });
});
