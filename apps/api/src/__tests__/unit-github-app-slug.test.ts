/**
 * The App slug is DERIVED from the App, not configured beside it.
 *
 * Production ran with `KORTIX_GITHUB_APP_SLUG=kortix-private-repo-access`
 * while `GET /app` reported `kortix-managed`, so `buildGitHubAppInstallUrl`
 * produced `https://github.com/apps/kortix-private-repo-access/...` — a 404
 * for every user, forever, with nothing logged. A configured slug is now a
 * fallback used only when the derivation fails, and a mismatch says so once.
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { generateKeyPairSync } from 'node:crypto';

import {
  buildGitHubAppInstallUrl,
  resetGitHubAppSlugCache,
  resolveGitHubAppSlug,
} from '../projects/github';

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});

const ENV_KEYS = [
  'KORTIX_GITHUB_APP_ID',
  'GITHUB_APP_ID',
  'KORTIX_GITHUB_APP_PRIVATE_KEY',
  'GITHUB_APP_PRIVATE_KEY',
  'KORTIX_GITHUB_APP_SLUG',
  'GITHUB_APP_SLUG',
  'KORTIX_GITHUB_APP_STATE_SECRET',
] as const;
const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

let appCalls = 0;

beforeEach(() => {
  for (const key of ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.KORTIX_GITHUB_APP_ID = '3812697';
  process.env.KORTIX_GITHUB_APP_PRIVATE_KEY = privateKey as string;
  process.env.KORTIX_GITHUB_APP_STATE_SECRET = 'state-secret-for-slug-tests';
  appCalls = 0;
  resetGitHubAppSlugCache();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  resetGitHubAppSlugCache();
});

function serveApp(slug: string | null, status = 200) {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/app')) {
      appCalls += 1;
      if (status !== 200) {
        return new Response(JSON.stringify({ message: 'Bad credentials' }), { status });
      }
      return new Response(JSON.stringify(slug ? { slug } : {}), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`unexpected request: ${url}`);
  }) as typeof fetch;
}

describe('resolveGitHubAppSlug', () => {
  test('derives the slug from GET /app', async () => {
    serveApp('kortix-managed');

    expect(await resolveGitHubAppSlug()).toEqual({ slug: 'kortix-managed', source: 'derived' });
    expect(appCalls).toBe(1);
  });

  test('caches the derived slug per appId', async () => {
    serveApp('kortix-managed');

    await resolveGitHubAppSlug();
    await resolveGitHubAppSlug();
    await resolveGitHubAppSlug();

    expect(appCalls).toBe(1);
  });

  test('falls back to a configured slug when derivation fails', async () => {
    process.env.KORTIX_GITHUB_APP_SLUG = 'kortix-private-repo-access';
    serveApp(null, 401);

    expect(await resolveGitHubAppSlug()).toEqual({
      slug: 'kortix-private-repo-access',
      source: 'configured',
    });
  });

  test('reports no slug when derivation fails and nothing is configured', async () => {
    serveApp(null, 401);

    expect(await resolveGitHubAppSlug()).toEqual({ slug: null, source: 'none' });
  });

  test('logs ONE warning when the configured slug disagrees with the App', async () => {
    process.env.KORTIX_GITHUB_APP_SLUG = 'kortix-private-repo-access';
    serveApp('kortix-managed');
    const warnings: string[] = [];
    const realWarn = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
    try {
      expect((await resolveGitHubAppSlug()).slug).toBe('kortix-managed');
      expect((await resolveGitHubAppSlug()).slug).toBe('kortix-managed');
    } finally {
      console.warn = realWarn;
    }

    const mismatches = warnings.filter((line) => line.includes('does not match'));
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]).toContain('kortix-private-repo-access');
    expect(mismatches[0]).toContain('kortix-managed');
  });

  test('reports no slug when no identity is configured', async () => {
    delete process.env.KORTIX_GITHUB_APP_ID;
    delete process.env.KORTIX_GITHUB_APP_PRIVATE_KEY;

    expect(await resolveGitHubAppSlug()).toEqual({ slug: null, source: 'none' });
  });
});

describe('buildGitHubAppInstallUrl', () => {
  test('uses the derived slug', async () => {
    process.env.KORTIX_GITHUB_APP_SLUG = 'kortix-private-repo-access';
    serveApp('kortix-managed');

    const url = await buildGitHubAppInstallUrl('account-1', 'nonce-1', 'account_link');

    expect(url).toContain('https://github.com/apps/kortix-managed/installations/new');
    expect(url).toContain('state=');
  });

  test('emits nothing for a slug that was neither derived nor configured', async () => {
    serveApp(null, 404);

    expect(await buildGitHubAppInstallUrl('account-1')).toBeNull();
  });
});
