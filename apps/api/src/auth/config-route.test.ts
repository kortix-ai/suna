/**
 * GET /v1/auth/config is the one Kortix route @kortix/sdk calls WITHOUT a
 * credential, and it is served with `Cache-Control: public`. Both of those are
 * only defensible while three things hold, so all three are asserted here
 * rather than reasoned about in a comment:
 *
 *   1. the body never varies per caller (byte-identical with and without an
 *      Authorization header),
 *   2. the body never contains a secret (explicit negative assertion against
 *      SUPABASE_SERVICE_ROLE_KEY's live value),
 *   3. the route is reachable anonymously while its sibling POST /v1/auth/logout
 *      stays gated — the mount-ordering guard, driven against the real app.
 *
 * The field-source and 503 matrix runs against `resolveAuthConfig`, which is
 * pure, so every case is hermetic without mutating process.env or rebuilding
 * the config singleton.
 */
import { describe, expect, test } from 'bun:test';

import { config } from '../config';
import { app } from '../index';
import {
  createAuthConfigRouter,
  isBrowserReachableUrl,
  parseAuthMethods,
  parseAuthProviders,
  resolveAuthConfig,
  type AuthConfigEnv,
} from './config-route';

const BASE: AuthConfigEnv = {
  supabaseUrl: 'https://internal.supabase.co',
  supabasePublicUrl: '',
  // Deliberately low-entropy: gitleaks flags realistic JWT-shaped fixtures.
  anonKey: 'test-anon-key-not-a-secret',
  authMethods: '',
  authProviders: '',
  signupsEnabled: true,
};

const env = (overrides: Partial<AuthConfigEnv> = {}): AuthConfigEnv => ({ ...BASE, ...overrides });

function routerFor(e: AuthConfigEnv) {
  return createAuthConfigRouter(() => e);
}

describe('resolveAuthConfig — payload shape', () => {
  test('200 body carries exactly the six contract keys', () => {
    const payload = resolveAuthConfig(env());
    expect(payload).not.toBeNull();
    expect(Object.keys(payload!).sort()).toEqual([
      'anon_key',
      'methods',
      'provider',
      'providers',
      'signups_enabled',
      'url',
    ]);
    expect(payload!.provider).toBe('supabase');
    expect(payload!.signups_enabled).toBe(true);
  });

  test('signups_enabled mirrors the caller-independent platform setting', () => {
    expect(resolveAuthConfig(env({ signupsEnabled: false }))!.signups_enabled).toBe(false);
  });
});

describe('resolveAuthConfig — url resolution', () => {
  test('SUPABASE_PUBLIC_URL wins over SUPABASE_URL', () => {
    const payload = resolveAuthConfig(
      env({ supabaseUrl: 'http://supabase-kong:8000', supabasePublicUrl: 'https://supa.kortix.com' }),
    );
    expect(payload!.url).toBe('https://supa.kortix.com');
  });

  test('a trailing slash is stripped — the value is an ORIGIN, not a path', () => {
    expect(resolveAuthConfig(env({ supabasePublicUrl: 'https://supa.kortix.com/' }))!.url).toBe(
      'https://supa.kortix.com',
    );
    expect(resolveAuthConfig(env({ supabaseUrl: 'https://supa.kortix.com///' }))!.url).toBe(
      'https://supa.kortix.com',
    );
  });

  test('localhost and 127.0.0.1 are served — a dev box is browser-reachable', () => {
    expect(resolveAuthConfig(env({ supabaseUrl: 'http://127.0.0.1:54321' }))!.url).toBe(
      'http://127.0.0.1:54321',
    );
    expect(resolveAuthConfig(env({ supabaseUrl: 'http://localhost:54321' }))!.url).toBe(
      'http://localhost:54321',
    );
  });
});

describe('resolveAuthConfig — 503 conditions', () => {
  test('a bare container name with no public URL is refused, not served', () => {
    // The self-host shape: kortix-compose.yml gives kortix-api
    // SUPABASE_URL=http://supabase-kong:8000, which no browser can resolve.
    expect(
      resolveAuthConfig(env({ supabaseUrl: 'http://supabase-kong:8000', supabasePublicUrl: '' })),
    ).toBeNull();
  });

  test('SUPABASE_ANON_KEY unset (or whitespace) is refused', () => {
    expect(resolveAuthConfig(env({ anonKey: '' }))).toBeNull();
    expect(resolveAuthConfig(env({ anonKey: '   ' }))).toBeNull();
  });

  test('no Supabase URL at all is refused', () => {
    expect(resolveAuthConfig(env({ supabaseUrl: '', supabasePublicUrl: '' }))).toBeNull();
  });

  test('isBrowserReachableUrl rejects bare names and non-http schemes', () => {
    expect(isBrowserReachableUrl('http://supabase-kong:8000')).toBe(false);
    expect(isBrowserReachableUrl('http://kong')).toBe(false);
    expect(isBrowserReachableUrl('not-a-url')).toBe(false);
    expect(isBrowserReachableUrl('ftp://supa.kortix.com')).toBe(false);
    expect(isBrowserReachableUrl('https://supa.kortix.com')).toBe(true);
  });
});

describe('methods / providers parsing', () => {
  test("AUTH_METHODS='password, MAGIC ,junk' → ['password','magic']", () => {
    expect(parseAuthMethods('password, MAGIC ,junk')).toEqual(['password', 'magic']);
  });

  test("unset AUTH_METHODS → ['magic','password'] (never an empty login form)", () => {
    expect(parseAuthMethods('')).toEqual(['magic', 'password']);
    expect(parseAuthMethods(undefined)).toEqual(['magic', 'password']);
    expect(parseAuthMethods('junk,only')).toEqual(['magic', 'password']);
  });

  test("AUTH_PROVIDERS='Google, ,google' → ['google'] (lowercased, deduped)", () => {
    expect(parseAuthProviders('Google, ,google')).toEqual(['google']);
  });

  test('unset AUTH_PROVIDERS → [] — no fallback, or the SDK renders a dead button', () => {
    expect(parseAuthProviders('')).toEqual([]);
    expect(parseAuthProviders(undefined)).toEqual([]);
  });

  test('both lists reach the payload', () => {
    const payload = resolveAuthConfig(
      env({ authMethods: 'password', authProviders: 'google,github' }),
    );
    expect(payload!.methods).toEqual(['password']);
    expect(payload!.providers).toEqual(['google', 'github']);
  });
});

describe('GET /config — HTTP contract', () => {
  test('200 with the public cache headers and an ETag', async () => {
    const res = await routerFor(env()).request('/config');
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=60, must-revalidate');
    expect(res.headers.get('etag')).toMatch(/^"[0-9a-f]{64}"$/);
    // `public` with no `Vary: Authorization` — adding one would be an admission
    // that the payload varies per caller, which the next test forbids.
    expect(res.headers.get('vary')).toBeNull();
    await expect(res.json()).resolves.toMatchObject({ provider: 'supabase' });
  });

  test('the response is byte-identical with and without an Authorization header', async () => {
    const router = routerFor(env());
    const anon = await router.request('/config');
    const bearer = await router.request('/config', {
      headers: { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.someones-real-jwt.sig' },
    });
    expect(bearer.status).toBe(anon.status);
    expect(await bearer.text()).toBe(await anon.text());
    expect(bearer.headers.get('etag')).toBe(anon.headers.get('etag'));
  });

  test('the body never contains the service-role key', async () => {
    // The anon key is public by definition; the service-role key is the one
    // value whose presence here would be a real breach. Assert on the live
    // config value, not a literal, so it keeps working if the fixture changes.
    const serviceRoleKey = config.SUPABASE_SERVICE_ROLE_KEY;
    expect(serviceRoleKey.length).toBeGreaterThan(0);
    const body = await (await routerFor(env()).request('/config')).text();
    expect(body).not.toContain(serviceRoleKey);
    expect(body).not.toContain('service_role');
  });

  test('the ETag is stable across calls and If-None-Match returns an empty 304', async () => {
    const router = routerFor(env());
    const first = await router.request('/config');
    const second = await router.request('/config');
    const etag = first.headers.get('etag')!;
    expect(second.headers.get('etag')).toBe(etag);

    const revalidated = await router.request('/config', { headers: { 'If-None-Match': etag } });
    expect(revalidated.status).toBe(304);
    expect(await revalidated.text()).toBe('');
  });

  test('a changed payload changes the ETag', async () => {
    const a = await routerFor(env({ authProviders: 'google' })).request('/config');
    const b = await routerFor(env({ authProviders: '' })).request('/config');
    expect(a.headers.get('etag')).not.toBe(b.headers.get('etag'));
  });

  test('503 auth_config_unavailable when the deployment cannot answer', async () => {
    const res = await routerFor(env({ anonKey: '' })).request('/config');
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({
      error: true,
      code: 'auth_config_unavailable',
      status: 503,
    });
  });

  test('503 for the unreachable self-host URL shape', async () => {
    const res = await routerFor(
      env({ supabaseUrl: 'http://supabase-kong:8000', supabasePublicUrl: '' }),
    ).request('/config');
    expect(res.status).toBe(503);
    expect((await res.json()).code).toBe('auth_config_unavailable');
  });
});

describe('mount ordering on the real app', () => {
  // This is the guard for the two adjacent app.route('/v1/auth', …) lines in
  // src/index.ts. Reordering them makes exactly one of these two assertions
  // fail, which is the whole point of asserting both against one app instance.
  test('ANON GET /v1/auth/config is NOT gated', async () => {
    const res = await app.request('/v1/auth/config');
    // 200 on a configured deployment, 503 on the hermetic unit env (no
    // SUPABASE_ANON_KEY there on purpose — scripts/test.env carries only what
    // config.ts hard-requires). 401 means the supabaseAuth gate swallowed it.
    expect(res.status).not.toBe(401);
    expect([200, 503]).toContain(res.status);
  });

  test('ANON POST /v1/auth/logout IS still gated', async () => {
    const res = await app.request('/v1/auth/logout', { method: 'POST' });
    expect(res.status).toBe(401);
  });

  test('GET /v1/auth/config is registered exactly once in the route table', () => {
    const routes = (app as unknown as { routes: Array<{ method: string; path: string }> }).routes;
    const matches = routes.filter(
      (r) => r.method.toUpperCase() === 'GET' && r.path === '/v1/auth/config',
    );
    expect(matches.length).toBe(1);
  });
});
