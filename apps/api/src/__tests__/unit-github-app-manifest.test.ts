/**
 * Unit tests for the in-app self-host GitHub App setup flow's pure/network
 * pieces (platform/routes/github-app.ts): manifest construction, the
 * create-app URL, the signed manifest-start state (sign/verify, tamper +
 * expiry rejection), and the manifest-conversion API call (fetch mocked via
 * the function's own `fetchImpl` param — no `mock.module` needed here).
 *
 * No DB access in this file — see managed-github-app.test.ts for the
 * platform_settings round trip, and unit-github-app-isconfigured.test.ts for
 * the DB-first/env-fallback accessor flip (that one needs `mock.module`, kept
 * in its own file/test-run per the cross-file mock-leakage caveat documented
 * in platform/services/session-sandbox.test.ts).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  buildGithubAppManifest,
  buildManifestCreateUrl,
  exchangeManifestCode,
  signManifestStartState,
  verifyManifestStartState,
} from '../platform/routes/github-app';

const ORIG_SECRET = process.env.SUPABASE_JWT_SECRET;
beforeEach(() => {
  process.env.SUPABASE_JWT_SECRET = 'test-supabase-jwt-secret';
});
afterEach(() => {
  if (ORIG_SECRET === undefined) delete process.env.SUPABASE_JWT_SECRET;
  else process.env.SUPABASE_JWT_SECRET = ORIG_SECRET;
});

describe('buildGithubAppManifest', () => {
  test('points redirect_url/setup_url at this API, sets public:false and the required permissions', () => {
    const manifest = buildGithubAppManifest({ apiBaseUrl: 'https://api.kortix.example', homepageUrl: 'https://kortix.ai', appName: 'Kortix Self-Host test' });
    expect(manifest.name).toBe('Kortix Self-Host test');
    // Homepage URL is separate from the API base — GitHub validates it as a
    // public FQDN, so it is never the (possibly localhost) API origin.
    expect(manifest.url).toBe('https://kortix.ai');
    expect(manifest.redirect_url).toBe('https://api.kortix.example/v1/platform/github-app/manifest-callback');
    expect(manifest.setup_url).toBe('https://api.kortix.example/v1/platform/github-app/install-callback');
    expect(manifest.public).toBe(false);
    expect(manifest.hook_attributes).toEqual({ url: 'https://kortix.ai', active: false });
    expect(manifest.default_events).toEqual([]);
    expect(manifest.default_permissions).toEqual({
      administration: 'write',
      contents: 'write',
      pull_requests: 'write',
      metadata: 'read',
    });
  });

  test('strips a trailing slash from apiBaseUrl before appending route paths', () => {
    const manifest = buildGithubAppManifest({ apiBaseUrl: 'https://api.kortix.example/', homepageUrl: 'https://kortix.ai' });
    expect(manifest.redirect_url).toBe('https://api.kortix.example/v1/platform/github-app/manifest-callback');
  });

  test('generates a unique-ish name when none is given', () => {
    const a = buildGithubAppManifest({ apiBaseUrl: 'https://api.kortix.example', homepageUrl: 'https://kortix.ai' });
    const b = buildGithubAppManifest({ apiBaseUrl: 'https://api.kortix.example', homepageUrl: 'https://kortix.ai' });
    expect(a.name).toMatch(/^Kortix Self-Host [0-9a-f]+$/);
    expect(a.name).not.toBe(b.name);
  });
});

describe('buildManifestCreateUrl', () => {
  test('no org -> the unscoped personal-account create URL', () => {
    expect(buildManifestCreateUrl()).toBe('https://github.com/settings/apps/new');
    expect(buildManifestCreateUrl('  ')).toBe('https://github.com/settings/apps/new');
  });

  test('org given -> the org-scoped create URL, URL-encoded', () => {
    expect(buildManifestCreateUrl('acme corp')).toBe(
      'https://github.com/organizations/acme%20corp/settings/apps/new',
    );
  });

  test('never bakes a `state` query param into the URL itself (the frontend appends it)', () => {
    expect(buildManifestCreateUrl('acme')).not.toContain('?');
  });
});

describe('signManifestStartState / verifyManifestStartState', () => {
  test('round-trips accountId + org', () => {
    const token = signManifestStartState({ accountId: 'acct-1', org: 'acme' });
    const parsed = verifyManifestStartState(token);
    expect(parsed?.accountId).toBe('acct-1');
    expect(parsed?.org).toBe('acme');
  });

  test('rejects a tampered payload', () => {
    const token = signManifestStartState({ accountId: 'acct-1' });
    const [body, mac] = token.split('.');
    const tamperedPayload = JSON.parse(Buffer.from(body!, 'base64url').toString('utf8'));
    tamperedPayload.accountId = 'acct-attacker';
    const tamperedBody = Buffer.from(JSON.stringify(tamperedPayload)).toString('base64url');
    expect(verifyManifestStartState(`${tamperedBody}.${mac}`)).toBeNull();
  });

  test('rejects a tampered signature', () => {
    const token = signManifestStartState({ accountId: 'acct-1' });
    const [body] = token.split('.');
    expect(verifyManifestStartState(`${body}.not-a-real-signature`)).toBeNull();
  });

  test('rejects an expired token (~10min TTL)', () => {
    const longAgo = Date.now() - 60 * 60 * 1000;
    const token = signManifestStartState({ accountId: 'acct-1' }, longAgo);
    expect(verifyManifestStartState(token, Date.now())).toBeNull();
  });

  test('accepts a token still inside the TTL', () => {
    const justNow = Date.now() - 60 * 1000; // 1 minute ago, well under 10min
    const token = signManifestStartState({ accountId: 'acct-1' }, justNow);
    expect(verifyManifestStartState(token, Date.now())?.accountId).toBe('acct-1');
  });

  test('rejects malformed/empty tokens', () => {
    expect(verifyManifestStartState(undefined)).toBeNull();
    expect(verifyManifestStartState('')).toBeNull();
    expect(verifyManifestStartState('not-two-parts')).toBeNull();
    expect(verifyManifestStartState('a.b.c')).toBeNull();
  });
});

describe('exchangeManifestCode', () => {
  test('POSTs to the conversions endpoint and maps the response', async () => {
    let capturedUrl = '';
    let capturedInit: RequestInit | undefined;
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      capturedUrl = url;
      capturedInit = init;
      return new Response(
        JSON.stringify({
          id: 12345,
          slug: 'kortix-self-host-abc',
          pem: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
          client_id: 'client-id-1',
          client_secret: 'client-secret-1',
          webhook_secret: 'webhook-secret-1',
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    const result = await exchangeManifestCode('the-code', fetchImpl);

    expect(capturedUrl).toBe('https://api.github.com/app-manifests/the-code/conversions');
    expect(capturedInit?.method).toBe('POST');
    expect(result).toEqual({
      id: 12345,
      slug: 'kortix-self-host-abc',
      pem: '-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----',
      client_id: 'client-id-1',
      client_secret: 'client-secret-1',
      webhook_secret: 'webhook-secret-1',
    });
  });

  test('URL-encodes the code', async () => {
    let capturedUrl = '';
    const fetchImpl = (async (url: string) => {
      capturedUrl = url;
      return new Response(JSON.stringify({}), { status: 200 });
    }) as typeof fetch;
    await exchangeManifestCode('a code/with?special&chars', fetchImpl);
    expect(capturedUrl).toBe(
      `https://api.github.com/app-manifests/${encodeURIComponent('a code/with?special&chars')}/conversions`,
    );
  });

  test('throws with the GitHub error detail on a non-OK response', async () => {
    const fetchImpl = (async (_url: string, _init?: RequestInit) =>
      new Response('bad manifest code', { status: 404, statusText: 'Not Found' })) as typeof fetch;
    await expect(exchangeManifestCode('expired-code', fetchImpl)).rejects.toThrow(/404/);
  });
});
