import { describe, expect, test } from 'bun:test';

import {
  authOptionsFor,
  checkDeployment,
  fetchSsoEnabled,
  normalizeDeploymentUrl,
  parseRuntimeConfig,
  parseSavedDeployment,
  resolveEndpoints,
  type Deployment,
} from './deployment';

/** The exact shape apps/web serves at /api/runtime-config (serializeRuntimeConfigScript). */
function runtimeScript(env: Record<string, unknown>): string {
  const json = JSON.stringify(env).replace(
    /[<>&]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`
  );
  return `window.__KORTIX_RUNTIME_CONFIG=${json};window.__RUNTIME_ENV=window.__KORTIX_RUNTIME_CONFIG;`;
}

const ORIGIN = 'https://kortix.example.com';
const ENV = {
  SUPABASE_URL: 'https://kortix.example.com',
  SUPABASE_ANON_KEY: 'anon-key-synthetic',
  BACKEND_URL: 'https://api.kortix.example.com/v1',
  AUTH_METHODS: 'password',
  AUTH_PROVIDERS: '',
  APP_URL: 'https://kortix.example.com',
};

const DEPLOYMENT: Deployment = {
  origin: ORIGIN,
  webUrl: ORIGIN,
  backendUrl: 'https://api.kortix.example.com/v1',
  supabaseUrl: 'https://kortix.example.com',
  supabaseAnonKey: 'anon-key-synthetic',
  authMethods: 'password',
  authProviders: '',
};

describe('normalizeDeploymentUrl', () => {
  test('a bare host becomes an https origin', () => {
    expect(normalizeDeploymentUrl(' kortix.example.com ')).toEqual({ ok: true, origin: ORIGIN });
  });

  test('path, query and hash are dropped: the deployment is the origin', () => {
    expect(normalizeDeploymentUrl('https://kortix.example.com/projects?x=1#y')).toEqual({
      ok: true,
      origin: ORIGIN,
    });
  });

  test('http is refused for a public host', () => {
    const result = normalizeDeploymentUrl('http://kortix.example.com');
    expect(result.ok).toBe(false);
  });

  test('http is allowed for loopback and private LAN hosts (local development)', () => {
    expect(normalizeDeploymentUrl('localhost:3000')).toEqual({ ok: true, origin: 'http://localhost:3000' });
    expect(normalizeDeploymentUrl('192.168.1.10:3000')).toEqual({ ok: true, origin: 'http://192.168.1.10:3000' });
    expect(normalizeDeploymentUrl('http://10.0.0.5:3000/')).toEqual({ ok: true, origin: 'http://10.0.0.5:3000' });
    expect(normalizeDeploymentUrl('http://mac.local:3000')).toEqual({ ok: true, origin: 'http://mac.local:3000' });
  });

  test('empty input, other schemes and credentials are refused', () => {
    expect(normalizeDeploymentUrl('').ok).toBe(false);
    expect(normalizeDeploymentUrl('ftp://kortix.example.com').ok).toBe(false);
    expect(normalizeDeploymentUrl('https://user:secret@kortix.example.com').ok).toBe(false);
  });
});

describe('parseRuntimeConfig', () => {
  test('reads the web runtime config into a deployment', () => {
    expect(parseRuntimeConfig(runtimeScript(ENV), ORIGIN)).toEqual({ ok: true, deployment: DEPLOYMENT });
  });

  test('escaped characters in the script still parse', () => {
    const result = parseRuntimeConfig(runtimeScript({ ...ENV, VERSION: '<1&2>' }), ORIGIN);
    expect(result.ok).toBe(true);
  });

  test('a root-relative Supabase URL resolves against the deployment origin', () => {
    const result = parseRuntimeConfig(runtimeScript({ ...ENV, SUPABASE_URL: '/supabase' }), ORIGIN);
    expect(result.ok && result.deployment.supabaseUrl).toBe('https://kortix.example.com/supabase');
  });

  test('the API URL always ends in /v1', () => {
    const noVersion = parseRuntimeConfig(runtimeScript({ ...ENV, BACKEND_URL: 'https://api.kortix.example.com/' }), ORIGIN);
    expect(noVersion.ok && noVersion.deployment.backendUrl).toBe('https://api.kortix.example.com/v1');
    const trailing = parseRuntimeConfig(runtimeScript({ ...ENV, BACKEND_URL: 'https://api.kortix.example.com/v1/' }), ORIGIN);
    expect(trailing.ok && trailing.deployment.backendUrl).toBe('https://api.kortix.example.com/v1');
  });

  test('loopback URLs of a LAN deployment point at the host the user entered', () => {
    const result = parseRuntimeConfig(
      runtimeScript({
        ...ENV,
        SUPABASE_URL: 'http://127.0.0.1:54321',
        BACKEND_URL: 'http://localhost:8008/v1',
      }),
      'http://192.168.1.10:3000'
    );
    expect(result.ok && result.deployment.supabaseUrl).toBe('http://192.168.1.10:54321');
    expect(result.ok && result.deployment.backendUrl).toBe('http://192.168.1.10:8008/v1');
  });

  test('an https deployment that hands out an http public URL is refused', () => {
    const result = parseRuntimeConfig(runtimeScript({ ...ENV, SUPABASE_URL: 'http://auth.kortix.example.com' }), ORIGIN);
    expect(result.ok).toBe(false);
  });

  test('a config without sign-in settings is refused', () => {
    expect(parseRuntimeConfig(runtimeScript({ ...ENV, SUPABASE_ANON_KEY: '' }), ORIGIN).ok).toBe(false);
    expect(parseRuntimeConfig(runtimeScript({ ...ENV, BACKEND_URL: '' }), ORIGIN).ok).toBe(false);
  });

  test('a page that is not the runtime config is refused', () => {
    expect(parseRuntimeConfig('<!doctype html><html></html>', ORIGIN).ok).toBe(false);
  });
});

type FakeRoute = { status?: number; body?: string; throws?: string };

function fakeFetch(routes: Record<string, FakeRoute>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new Error(`unexpected request ${url}`);
    if (route.throws) throw new Error(route.throws);
    return new Response(route.body ?? '', { status: route.status ?? 200 });
  };
  return { fetchImpl, calls };
}

describe('checkDeployment', () => {
  test('reads the runtime config and probes the API before accepting a deployment', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'https://kortix.example.com/api/runtime-config': { body: runtimeScript(ENV) },
      'https://api.kortix.example.com/v1/health': { body: '{"status":"ok"}' },
    });
    expect(await checkDeployment('kortix.example.com', fetchImpl)).toEqual({ ok: true, deployment: DEPLOYMENT });
    expect(calls.map((c) => c.url)).toEqual([
      'https://kortix.example.com/api/runtime-config',
      'https://api.kortix.example.com/v1/health',
    ]);
  });

  test('a host without the runtime config is not a Kortix instance', async () => {
    const { fetchImpl } = fakeFetch({
      'https://kortix.example.com/api/runtime-config': { status: 404, body: 'not found' },
    });
    const result = await checkDeployment(ORIGIN, fetchImpl);
    expect(result).toEqual({ ok: false, error: 'kortix.example.com is not a Kortix instance (HTTP 404).' });
  });

  test('an older API (no client config) is refused with a pointer to the web URL', async () => {
    const { fetchImpl } = fakeFetch({
      'https://api.kortix.example.com/api/runtime-config': { status: 404, body: 'not found' },
      'https://api.kortix.example.com/v1/auth/client-config': { status: 404, body: 'not found' },
      'https://api.kortix.example.com/v1/health': { body: '{"status":"ok"}' },
    });
    expect(await checkDeployment('api.kortix.example.com', fetchImpl)).toEqual({
      ok: false,
      error: 'api.kortix.example.com runs an older Kortix API. Enter the web URL, or update the instance.',
    });
  });

  test('an unreachable host says so', async () => {
    const { fetchImpl } = fakeFetch({
      'https://kortix.example.com/api/runtime-config': { throws: 'Network request failed' },
    });
    expect(await checkDeployment(ORIGIN, fetchImpl)).toEqual({
      ok: false,
      error: 'kortix.example.com could not be reached.',
    });
  });

  test('an unreachable API is refused even when the web answers', async () => {
    const { fetchImpl } = fakeFetch({
      'https://kortix.example.com/api/runtime-config': { body: runtimeScript(ENV) },
      'https://api.kortix.example.com/v1/health': { throws: 'Network request failed' },
    });
    expect(await checkDeployment(ORIGIN, fetchImpl)).toEqual({
      ok: false,
      error: 'The API of this instance (api.kortix.example.com) could not be reached.',
    });
  });

  test('invalid input never makes a request', async () => {
    const { fetchImpl, calls } = fakeFetch({});
    expect((await checkDeployment('http://kortix.example.com', fetchImpl)).ok).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

/** The shape the API serves at GET /v1/auth/client-config (apps/api/src/http/auth/headless.ts). */
const CLIENT_CONFIG = {
  supabase_url: 'https://auth.kortix.example.com',
  supabase_anon_key: 'anon-key-synthetic',
  frontend_url: 'https://kortix.example.com',
  auth_methods: ['password'],
  auth_providers: [],
};
const API_ORIGIN = 'https://api.kortix.example.com';
const API_DEPLOYMENT: Deployment = {
  origin: API_ORIGIN,
  webUrl: ORIGIN,
  backendUrl: 'https://api.kortix.example.com/v1',
  supabaseUrl: 'https://auth.kortix.example.com',
  supabaseAnonKey: 'anon-key-synthetic',
  authMethods: 'password',
  authProviders: '',
};

function apiRoutes(config: unknown, origin = API_ORIGIN): Record<string, FakeRoute> {
  return {
    [`${origin}/api/runtime-config`]: { status: 404, body: 'not found' },
    [`${origin}/v1/auth/client-config`]: { body: JSON.stringify(config) },
    [`${origin}/v1/health`]: { body: '{"status":"ok"}' },
  };
}

describe('checkDeployment with an API URL', () => {
  test('reads the API client config when the host serves no web runtime config', async () => {
    const { fetchImpl, calls } = fakeFetch(apiRoutes(CLIENT_CONFIG));
    expect(await checkDeployment('https://api.kortix.example.com', fetchImpl)).toEqual({
      ok: true,
      deployment: API_DEPLOYMENT,
    });
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.kortix.example.com/api/runtime-config',
      'https://api.kortix.example.com/v1/auth/client-config',
      'https://api.kortix.example.com/v1/health',
    ]);
  });

  test('a /v1 suffix, a trailing slash and a bare host all name the same API', async () => {
    for (const input of ['https://api.kortix.example.com/v1', 'api.kortix.example.com/v1/']) {
      const { fetchImpl } = fakeFetch(apiRoutes(CLIENT_CONFIG));
      expect(await checkDeployment(input, fetchImpl)).toEqual({ ok: true, deployment: API_DEPLOYMENT });
    }
  });

  test('a LAN API: loopback URLs point at the host entered, unset auth lists mean the build defaults', async () => {
    const lan = 'http://192.168.1.10:8008';
    const { fetchImpl } = fakeFetch(
      apiRoutes(
        {
          supabase_url: 'http://127.0.0.1:54321',
          supabase_anon_key: 'anon-key-synthetic',
          frontend_url: 'http://localhost:3000',
          auth_methods: null,
          auth_providers: null,
        },
        lan
      )
    );
    expect(await checkDeployment(lan, fetchImpl)).toEqual({
      ok: true,
      deployment: {
        origin: lan,
        webUrl: 'http://192.168.1.10:3000',
        backendUrl: 'http://192.168.1.10:8008/v1',
        supabaseUrl: 'http://192.168.1.10:54321',
        supabaseAnonKey: 'anon-key-synthetic',
        authMethods: null,
        authProviders: null,
      },
    });
  });

  test('without a frontend URL the web links use the API origin', async () => {
    const { fetchImpl } = fakeFetch(apiRoutes({ ...CLIENT_CONFIG, frontend_url: null }));
    const result = await checkDeployment(API_ORIGIN, fetchImpl);
    expect(result.ok && result.deployment.webUrl).toBe(API_ORIGIN);
  });

  test('an API without the anon key falls back to the runtime config of its web app', async () => {
    const { fetchImpl, calls } = fakeFetch({
      ...apiRoutes({ ...CLIENT_CONFIG, supabase_anon_key: null }),
      'https://kortix.example.com/api/runtime-config': { body: runtimeScript(ENV) },
    });
    expect(await checkDeployment(API_ORIGIN, fetchImpl)).toEqual({
      ok: true,
      deployment: { ...DEPLOYMENT, origin: API_ORIGIN, webUrl: ORIGIN },
    });
    expect(calls.map((c) => c.url)).toContain('https://kortix.example.com/api/runtime-config');
  });

  test('an API without the anon key and an unreadable web app says so', async () => {
    const { fetchImpl } = fakeFetch({
      ...apiRoutes({ ...CLIENT_CONFIG, supabase_anon_key: null }),
      'https://kortix.example.com/api/runtime-config': { status: 401, body: 'protected' },
    });
    expect(await checkDeployment(API_ORIGIN, fetchImpl)).toEqual({
      ok: false,
      error: 'api.kortix.example.com has no sign-in configuration, and kortix.example.com did not provide one.',
    });
  });

  test('an https API that hands out an http Supabase URL is refused', async () => {
    const { fetchImpl } = fakeFetch(apiRoutes({ ...CLIENT_CONFIG, supabase_url: 'http://auth.kortix.example.com' }));
    expect((await checkDeployment(API_ORIGIN, fetchImpl)).ok).toBe(false);
  });
});

describe('fetchSsoEnabled', () => {
  test('reads saml_enabled from the deployment auth settings with its anon key', async () => {
    const { fetchImpl, calls } = fakeFetch({
      'https://kortix.example.com/auth/v1/settings': { body: '{"saml_enabled":true}' },
    });
    expect(await fetchSsoEnabled(DEPLOYMENT, fetchImpl)).toBe(true);
    expect((calls[0].init?.headers as Record<string, string>).apikey).toBe('anon-key-synthetic');
  });

  test('a failure or a disabled flag hides SSO', async () => {
    const off = fakeFetch({ 'https://kortix.example.com/auth/v1/settings': { body: '{"saml_enabled":false}' } });
    expect(await fetchSsoEnabled(DEPLOYMENT, off.fetchImpl)).toBe(false);
    const down = fakeFetch({ 'https://kortix.example.com/auth/v1/settings': { status: 500 } });
    expect(await fetchSsoEnabled(DEPLOYMENT, down.fetchImpl)).toBe(false);
  });
});

describe('parseSavedDeployment', () => {
  test('round-trips a saved deployment', () => {
    expect(parseSavedDeployment(JSON.stringify(DEPLOYMENT))).toEqual(DEPLOYMENT);
  });

  test('unset auth lists survive a round trip; a file saved before webUrl existed links to its origin', () => {
    const unset = { ...API_DEPLOYMENT, authMethods: null, authProviders: null };
    expect(parseSavedDeployment(JSON.stringify(unset))).toEqual(unset);
    const { webUrl: _dropped, ...legacy } = DEPLOYMENT;
    expect(parseSavedDeployment(JSON.stringify(legacy))).toEqual(DEPLOYMENT);
  });

  test('a missing, corrupt or insecure file falls back to the build default', () => {
    expect(parseSavedDeployment(null)).toBeNull();
    expect(parseSavedDeployment('{not json')).toBeNull();
    expect(parseSavedDeployment(JSON.stringify({ ...DEPLOYMENT, supabaseAnonKey: '' }))).toBeNull();
    expect(
      parseSavedDeployment(JSON.stringify({ ...DEPLOYMENT, backendUrl: 'http://api.kortix.example.com/v1' }))
    ).toBeNull();
  });
});

describe('resolveEndpoints', () => {
  const BUILD_ENV = {
    EXPO_PUBLIC_BACKEND_URL: 'https://api.kortix.com/v1',
    EXPO_PUBLIC_SUPABASE_URL: 'https://build.supabase.example.com',
    EXPO_PUBLIC_SUPABASE_ANON_KEY: 'build-anon-key',
  };

  test('no saved deployment keeps every build-time endpoint and kortix.com links', () => {
    expect(resolveEndpoints(null, BUILD_ENV)).toEqual({
      backendUrl: 'https://api.kortix.com/v1',
      supabaseUrl: 'https://build.supabase.example.com',
      supabaseAnonKey: 'build-anon-key',
      webUrl: 'https://kortix.com',
    });
  });

  test('a saved deployment moves the API, sign-in and web links together', () => {
    expect(resolveEndpoints(DEPLOYMENT, BUILD_ENV)).toEqual({
      backendUrl: 'https://api.kortix.example.com/v1',
      supabaseUrl: 'https://kortix.example.com',
      supabaseAnonKey: 'anon-key-synthetic',
      webUrl: 'https://kortix.example.com',
    });
  });

  test('an API-URL deployment links to its web app, not the API host', () => {
    expect(resolveEndpoints(API_DEPLOYMENT, BUILD_ENV).webUrl).toBe(ORIGIN);
  });

  test('the local default API stays the fallback when the build sets none', () => {
    expect(resolveEndpoints(null, {}).backendUrl).toBe('http://localhost:8008/v1');
  });
});

describe('authOptionsFor', () => {
  test('the build default keeps both email methods, Google and Apple', () => {
    expect(authOptionsFor(null, {})).toEqual({ magic: true, password: true, google: true, apple: true, custom: false });
    expect(authOptionsFor(null, { EXPO_PUBLIC_AUTH_METHODS: 'password' })).toMatchObject({
      magic: false,
      password: true,
    });
  });

  test('a self-hosted instance renders only the methods and providers it advertises', () => {
    expect(authOptionsFor(DEPLOYMENT, { EXPO_PUBLIC_AUTH_METHODS: 'magic' })).toEqual({
      magic: false,
      password: true,
      google: false,
      apple: false,
      custom: true,
    });
    expect(
      authOptionsFor({ ...DEPLOYMENT, authMethods: 'magic,password', authProviders: 'google' }, {})
    ).toEqual({ magic: true, password: true, google: true, apple: false, custom: true });
  });

  test('auth lists the instance does not report (null) keep the build defaults', () => {
    expect(
      authOptionsFor({ ...DEPLOYMENT, authMethods: null, authProviders: null }, { EXPO_PUBLIC_AUTH_METHODS: 'magic' })
    ).toEqual({ magic: true, password: false, google: true, apple: true, custom: true });
  });

  test('an empty method list falls back to both email methods', () => {
    expect(authOptionsFor({ ...DEPLOYMENT, authMethods: '' }, {})).toMatchObject({ magic: true, password: true });
  });
});
