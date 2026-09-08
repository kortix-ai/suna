/**
 * Unit tests for the two additions that let self-host configure managed-git
 * WITHOUT the manifest flow (platform/routes/github-app.ts):
 *
 *   - `resolveManagedGitSource` — the pure precedence rule behind
 *     `GET /status`'s `source` field (App-DB > App-env > PAT).
 *   - `verifyPastedGithubAppInstallation` — validates an operator-pasted
 *     GitHub App (app id + private key + installation id) against GitHub
 *     BEFORE it's stored (POST /app), the same "fail loudly here, not at the
 *     first project creation" principle as exchangeManifestCode.
 *
 * No DB access in this file (same "no mock.module" style as
 * unit-github-app-manifest.test.ts) — the PAT DB round-trip itself lives in
 * platform/services/managed-github-app.test.ts, and the DB-first/env-fallback
 * accessor flip lives in unit-github-app-isconfigured.test.ts.
 */
import { describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';
import {
  resolveInstallationOwnerType,
  resolveManagedGitSource,
  verifyPastedGithubAppInstallation,
  verifyRepoAdminToken,
} from '../platform/routes/github-app';

describe('resolveInstallationOwnerType', () => {
  test('"User" -> User (personal-account installs, e.g. a throwaway bot account)', () => {
    expect(resolveInstallationOwnerType('User')).toBe('User');
  });

  test('"Organization" -> Organization', () => {
    expect(resolveInstallationOwnerType('Organization')).toBe('Organization');
  });

  test('missing/unexpected values default to Organization (the historical assumption)', () => {
    expect(resolveInstallationOwnerType(undefined)).toBe('Organization');
    expect(resolveInstallationOwnerType('Bot')).toBe('Organization');
    expect(resolveInstallationOwnerType('')).toBe('Organization');
  });
});

describe('resolveManagedGitSource', () => {
  test('none when nothing is configured', () => {
    expect(
      resolveManagedGitSource({
        dbAppConfigured: false,
        envAppConfigured: false,
        patConfigured: false,
      }),
    ).toBe('none');
  });

  test('pat when only a token is configured', () => {
    expect(
      resolveManagedGitSource({
        dbAppConfigured: false,
        envAppConfigured: false,
        patConfigured: true,
      }),
    ).toBe('pat');
  });

  test('a PAT wins over an env App — it is what the git backend actually uses', () => {
    // managedGithubToken() short-circuits managedAdminAuth/mintManagedWriteToken.
    // Prod 2026-09-07: a PAT stored via POST /pat during the provisioning
    // outage was live, but /status still said "env".
    expect(
      resolveManagedGitSource({
        dbAppConfigured: false,
        envAppConfigured: true,
        patConfigured: true,
      }),
    ).toBe('pat');
  });

  test('a PAT wins over a DB App as well — POST /app clears a stored PAT, but an env PAT still short-circuits a DB App', () => {
    expect(
      resolveManagedGitSource({
        dbAppConfigured: true,
        envAppConfigured: true,
        patConfigured: true,
      }),
    ).toBe('pat');
  });

  test('DB App wins over an env App when no PAT is configured', () => {
    expect(
      resolveManagedGitSource({
        dbAppConfigured: true,
        envAppConfigured: true,
        patConfigured: false,
      }),
    ).toBe('db');
  });
});

describe('verifyPastedGithubAppInstallation', () => {
  function keyPair() {
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  }

  test('signs a JWT with the pasted creds and resolves the installation owner', async () => {
    const pem = keyPair();
    let capturedUrl = '';
    let capturedAuth = '';
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      capturedUrl = String(url);
      capturedAuth = (init?.headers as Record<string, string>)?.Authorization ?? '';
      return new Response(JSON.stringify({ id: 987, account: { login: 'acme-corp' } }), {
        status: 200,
      });
    }) as typeof fetch;

    const result = await verifyPastedGithubAppInstallation('12345', pem, '987', fetchImpl);

    expect(result).toEqual({ owner: 'acme-corp', ownerType: 'Organization' });
    expect(capturedUrl).toBe('https://api.github.com/app/installations/987');
    expect(capturedAuth).toMatch(/^Bearer /);
  });

  test('resolves ownerType: User for a personal-account installation', async () => {
    const pem = keyPair();
    const fetchImpl = (async (_url: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: 987, account: { login: 'agent-kortix', type: 'User' } }), {
        status: 200,
      })) as typeof fetch;

    const result = await verifyPastedGithubAppInstallation('12345', pem, '987', fetchImpl);
    expect(result).toEqual({ owner: 'agent-kortix', ownerType: 'User' });
  });

  test('URL-encodes the installation id', async () => {
    const pem = keyPair();
    let capturedUrl = '';
    const fetchImpl = (async (url: string | URL) => {
      capturedUrl = String(url);
      return new Response(JSON.stringify({ account: { login: 'acme-corp' } }), { status: 200 });
    }) as typeof fetch;

    await verifyPastedGithubAppInstallation('12345', pem, 'weird/id?', fetchImpl);
    expect(capturedUrl).toBe(
      `https://api.github.com/app/installations/${encodeURIComponent('weird/id?')}`,
    );
  });

  test('rejects a malformed private key before ever calling GitHub', async () => {
    let called = false;
    const fetchImpl = (async (_url: string | URL, _init?: RequestInit) => {
      called = true;
      return new Response('{}', { status: 200 });
    }) as typeof fetch;

    await expect(
      verifyPastedGithubAppInstallation('12345', 'not-a-real-pem', '987', fetchImpl),
    ).rejects.toThrow(/private key/i);
    expect(called).toBe(false);
  });

  test('rejects with a clear message on a 404 (bad app id / installation id)', async () => {
    const pem = keyPair();
    const fetchImpl = (async (_url: string | URL, _init?: RequestInit) =>
      new Response('Not Found', { status: 404, statusText: 'Not Found' })) as typeof fetch;

    await expect(verifyPastedGithubAppInstallation('12345', pem, '987', fetchImpl)).rejects.toThrow(
      /App ID, private key, and installation id/,
    );
  });

  test('rejects when GitHub returns no account login to resolve an owner from', async () => {
    const pem = keyPair();
    const fetchImpl = (async (_url: string | URL, _init?: RequestInit) =>
      new Response(JSON.stringify({ id: 987 }), { status: 200 })) as typeof fetch;

    await expect(verifyPastedGithubAppInstallation('12345', pem, '987', fetchImpl)).rejects.toThrow(
      /resolve the installation owner/,
    );
  });
});

/**
 * `POST /pat` used to accept any token `GET /user` liked. That is how a
 * fine-grained PAT without `Administration: write` reached production on
 * 2026-08-30 and every project creation died on `POST /orgs/managed-kortix/repos`
 * → 403 "Resource not accessible by personal access token" for 8 days. The
 * probe now performs the write itself: create a private probe repo under the
 * owner, then delete it.
 */
describe('verifyRepoAdminToken (a managed-git token is verified by the write it authorises)', () => {
  type Call = { method: string; path: string };
  function fakeGitHub(script: {
    user?: number;
    owner?: { status: number; type?: string };
    create?: { status: number; body?: unknown };
    del?: number;
  }): { fetchImpl: typeof fetch; calls: Call[] } {
    const calls: Call[] = [];
    const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, path: url.pathname });
      if (url.pathname === '/user') return new Response('{"login":"bot"}', { status: script.user ?? 200 });
      if (url.pathname.startsWith('/users/')) {
        const o = script.owner ?? { status: 200, type: 'Organization' };
        return new Response(JSON.stringify({ type: o.type ?? 'Organization' }), { status: o.status });
      }
      if (method === 'POST') {
        const c = script.create ?? { status: 201 };
        return new Response(JSON.stringify(c.body ?? { full_name: 'x' }), { status: c.status });
      }
      if (method === 'DELETE') return new Response(null, { status: script.del ?? 204 });
      return new Response('unexpected', { status: 500 });
    }) as typeof fetch;
    return { fetchImpl, calls };
  }

  test('org owner: creates the probe under /orgs/<owner>/repos and deletes it', async () => {
    const gh = fakeGitHub({});
    const verdict = await verifyRepoAdminToken('tok', 'managed-kortix', gh.fetchImpl);
    expect(verdict).toEqual({ ok: true });
    const create = gh.calls.find((c) => c.method === 'POST');
    expect(create?.path).toBe('/orgs/managed-kortix/repos');
    const del = gh.calls.find((c) => c.method === 'DELETE');
    expect(del?.path).toMatch(/^\/repos\/managed-kortix\/kortix-credential-probe-[0-9a-f]{12}$/);
  });

  test('personal owner: creates the probe under /user/repos', async () => {
    const gh = fakeGitHub({ owner: { status: 200, type: 'User' } });
    expect(await verifyRepoAdminToken('tok', 'bot-user', gh.fetchImpl)).toEqual({ ok: true });
    expect(gh.calls.find((c) => c.method === 'POST')?.path).toBe('/user/repos');
  });

  test('the 2026-08-30 prod token: GET /user 200 but create → 403 is REJECTED with GitHub\'s reason', async () => {
    const gh = fakeGitHub({
      create: { status: 403, body: { message: 'Resource not accessible by personal access token' } },
    });
    const verdict = await verifyRepoAdminToken('github_pat_x', 'managed-kortix', gh.fetchImpl);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.message).toContain('cannot create repositories under "managed-kortix"');
    expect(verdict.message).toContain('Resource not accessible by personal access token');
    expect(gh.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  test('expired / wrong token: GET /user 401 short-circuits before any write', async () => {
    const gh = fakeGitHub({ user: 401 });
    const verdict = await verifyRepoAdminToken('bad', 'managed-kortix', gh.fetchImpl);
    expect(verdict.ok).toBe(false);
    expect(gh.calls.map((c) => c.method)).toEqual(['GET']);
  });

  test('create ok but delete refused: rejected and names the leftover repo', async () => {
    const gh = fakeGitHub({ del: 403 });
    const verdict = await verifyRepoAdminToken('tok', 'managed-kortix', gh.fetchImpl);
    expect(verdict.ok).toBe(false);
    if (verdict.ok) throw new Error('unreachable');
    expect(verdict.message).toContain('cannot delete it');
    expect(verdict.message).toMatch(/managed-kortix\/kortix-credential-probe-/);
  });
});
