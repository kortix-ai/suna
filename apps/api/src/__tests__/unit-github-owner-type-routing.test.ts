/**
 * Regression coverage for the self-host personal-owner incident: a managed GitHub
 * App installed on a PERSONAL (User) account instead of an Organization made
 * every managed-git repo create/list 404 on `/orgs/{owner}/repos`, because
 * `managedAdminAuth()` (projects/git-backends/github.ts) used to hardcode
 * `ownerType: 'Organization'` for the App-installation path (and gated the
 * PAT path's live detection behind `INTERNAL_KORTIX_ENV !== 'prod'`, which is
 * also wrong — a self-host box runs the "prod" build but is not the hosted
 * multi-tenant SaaS, so "prod always means org" never held there).
 *
 * This proves `githubBackend.createRepo()` routes to `/user/repos` for a
 * personal owner and `/orgs/{owner}/repos` for an org owner, via BOTH:
 *  - the stored `ownerType` install-callback now writes to the DB config, and
 *  - the live `isOrgAccount` fallback for configs that don't have it yet.
 *
 * Seeds the two instance resolvers (platform/services/github-app-identity.ts
 * and platform/services/managed-git-backend.ts) — everything downstream runs
 * for real. The seeds are per-process, so this file owns its process
 * (`bun test --isolate`).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import { __setStoredAppIdentityForTests } from '../platform/services/github-app-identity';
import { __setStoredGitBackendForTests } from '../platform/services/managed-git-backend';

// A throwaway RSA key — only used to produce a JWT `createInstallationToken`
// can sign; the fetch mock below never verifies the signature.
const TEST_APP_PRIVATE_KEY = generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

interface StoredConfig {
  appId?: string;
  privateKey?: string;
  owner?: string;
  ownerType?: 'User' | 'Organization';
  installationId?: string;
}

/** Seed the stored identity + the stored App backend, the way the in-app
 *  setup flow writes them. */
function setConfig(config: StoredConfig) {
  __setStoredAppIdentityForTests({ appId: config.appId, privateKey: config.privateKey });
  __setStoredGitBackendForTests(
    config.owner && config.installationId
      ? {
          kind: 'app',
          owner: config.owner,
          ownerType: config.ownerType,
          installationId: config.installationId,
        }
      : {},
  );
}

const { githubBackend } = await import('../projects/git-backends/github');

// This repo's local `.env` (loaded automatically by `bun test`) sets real
// MANAGED_GIT_GITHUB_*/KORTIX_GITHUB_APP_* values for interactive dev use —
// left in place, they silently win over the DB-mocked config below (env is
// the documented fallback), making every case here exercise the env path
// instead of the DB-config path under test. Clear them for the duration of
// this file, same convention as unit-github-app-isconfigured.test.ts.
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

const originalFetch = globalThis.fetch;
let requests: Array<{ url: string; init?: RequestInit }> = [];

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function repoResponse(owner: string) {
  return {
    id: 7,
    name: 'demo',
    full_name: `${owner}/demo`,
    private: true,
    html_url: `https://github.com/${owner}/demo`,
    clone_url: `https://github.com/${owner}/demo.git`,
    ssh_url: `git@github.com:${owner}/demo.git`,
    default_branch: 'main',
    description: null,
  };
}

beforeEach(() => {
  setConfig({});
  requests = [];
  for (const k of ENV_KEYS) delete process.env[k];
  globalThis.fetch = mock(async (url: string | URL | Request, init?: RequestInit) => {
    const href = typeof url === 'string' || url instanceof URL ? String(url) : url.url;
    requests.push({ url: href, init });

    if (href.endsWith('/app/installations/501/access_tokens')) {
      return json({ token: 'installation-token', expires_at: '2026-01-01T00:00:00Z' });
    }
    if (href.match(/\/users\/[^/]+$/)) {
      const login = href.split('/').pop()!;
      if (login === 'org-owner-live') return json({ type: 'Organization' });
      if (login === 'user-owner-live') return json({ type: 'User' });
      return json({ message: 'not found' }, 404);
    }
    if (href.endsWith('/user/repos') && init?.method === 'POST') {
      return json(repoResponse('whoever'));
    }
    const orgReposMatch = href.match(/\/orgs\/([^/]+)\/repos$/);
    if (orgReposMatch && init?.method === 'POST') {
      return json(repoResponse(orgReposMatch[1]!));
    }
    return json({ message: 'not found' }, 404);
  }) as unknown as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    const value = savedEnv[k];
    if (value === undefined) delete process.env[k];
    else process.env[k] = value;
  }
});

function findRequest(pathSuffix: string) {
  return requests.find((r) => r.url.endsWith(pathSuffix));
}

describe('managed GitHub App createRepo — owner-type routing', () => {
  test('stored ownerType "User" (install-callback resolved a personal account) -> POST /user/repos', async () => {
    setConfig({
      appId: '12345',
      privateKey: TEST_APP_PRIVATE_KEY,
      owner: 'agent-kortix',
      ownerType: 'User',
      installationId: '501',
    });

    const repo = await githubBackend.createRepo({
      accountId: 'acct-1',
      projectId: 'proj-1',
      slug: 'demo',
      defaultBranch: 'main',
      isPrivate: true,
    });

    // /user/repos ignores the owner param (it's always "the authenticated
    // account's repos" on GitHub's side) — the mock reflects that by always
    // returning a fixed clone_url, independent of the configured owner.
    expect(repo.upstreamUrl).toBe('https://github.com/whoever/demo.git');
    expect(findRequest('/user/repos')).toBeTruthy();
    expect(findRequest('/orgs/agent-kortix/repos')).toBeUndefined();
  });

  test('stored ownerType "Organization" -> POST /orgs/{owner}/repos (regression guard)', async () => {
    setConfig({
      appId: '12345',
      privateKey: TEST_APP_PRIVATE_KEY,
      owner: 'kortix-managed',
      ownerType: 'Organization',
      installationId: '501',
    });

    const repo = await githubBackend.createRepo({
      accountId: 'acct-1',
      projectId: 'proj-1',
      slug: 'demo',
      defaultBranch: 'main',
      isPrivate: true,
    });

    expect(repo.upstreamUrl).toBe('https://github.com/kortix-managed/demo.git');
    expect(findRequest('/orgs/kortix-managed/repos')).toBeTruthy();
    expect(findRequest('/user/repos')).toBeUndefined();
  });

  test('no stored ownerType (older config) falls back to a live account-type lookup — User', async () => {
    setConfig({
      appId: '12345',
      privateKey: TEST_APP_PRIVATE_KEY,
      owner: 'user-owner-live',
      installationId: '501',
    });

    const repo = await githubBackend.createRepo({
      accountId: 'acct-1',
      projectId: 'proj-1',
      slug: 'demo',
      defaultBranch: 'main',
      isPrivate: true,
    });

    expect(repo.upstreamUrl).toBe('https://github.com/whoever/demo.git');
    expect(findRequest('/user/repos')).toBeTruthy();
  });

  test('no stored ownerType, live lookup says Organization -> org path (regression guard)', async () => {
    setConfig({
      appId: '12345',
      privateKey: TEST_APP_PRIVATE_KEY,
      owner: 'org-owner-live',
      installationId: '501',
    });

    const repo = await githubBackend.createRepo({
      accountId: 'acct-1',
      projectId: 'proj-1',
      slug: 'demo',
      defaultBranch: 'main',
      isPrivate: true,
    });

    expect(repo.upstreamUrl).toBe('https://github.com/org-owner-live/demo.git');
    expect(findRequest('/orgs/org-owner-live/repos')).toBeTruthy();
  });

  test('token backend also routes off a live account-type lookup, not a hardcoded assumption', async () => {
    __setStoredAppIdentityForTests({});
    __setStoredGitBackendForTests({ kind: 'pat', token: 'ghp_dummy', owner: 'user-owner-live' });

    const repo = await githubBackend.createRepo({
      accountId: 'acct-1',
      projectId: 'proj-1',
      slug: 'demo',
      defaultBranch: 'main',
      isPrivate: true,
    });

    expect(repo.upstreamUrl).toBe('https://github.com/whoever/demo.git');
    expect(findRequest('/user/repos')).toBeTruthy();
    // Never minted an installation token — the PAT is used directly.
    expect(findRequest('/access_tokens')).toBeUndefined();
  });
});
