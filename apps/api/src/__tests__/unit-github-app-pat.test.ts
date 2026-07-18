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

  test('env App wins over a PAT', () => {
    expect(
      resolveManagedGitSource({
        dbAppConfigured: false,
        envAppConfigured: true,
        patConfigured: true,
      }),
    ).toBe('env');
  });

  test('DB App (manifest flow or pasted) wins over both an env App and a PAT', () => {
    expect(
      resolveManagedGitSource({
        dbAppConfigured: true,
        envAppConfigured: true,
        patConfigured: true,
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
