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

  test('an empty method list falls back to both email methods', () => {
    expect(authOptionsFor({ ...DEPLOYMENT, authMethods: '' }, {})).toMatchObject({ magic: true, password: true });
  });
});
