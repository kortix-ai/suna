import { afterEach, describe, expect, test } from 'bun:test';

process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.FRONTEND_URL = 'https://app.example.com';
delete process.env.KORTIX_APPS_BASE_DOMAIN;
delete process.env.KORTIX_APPS_LOCAL;

const { config } = await import('../config');
const { appPublicUrl, appsBaseDomain, resolveAppHost } = await import('./hostnames');

const ROW = { slug: 'store', routeKey: 'aaaaaaaaaaaaaaaa' };
const originalUrl = config.KORTIX_URL;

afterEach(() => {
  (config as { KORTIX_URL: string }).KORTIX_URL = originalUrl;
  delete process.env.KORTIX_APPS_BASE_DOMAIN;
  delete process.env.KORTIX_APPS_LOCAL;
});

function setApiOrigin(url: string) {
  (config as { KORTIX_URL: string }).KORTIX_URL = url;
}

describe('App hostnames', () => {
  test('managed cloud keeps the exact hostnames it publishes today', () => {
    for (const origin of ['https://api.kortix.com', 'https://dev-api.kortix.com']) {
      setApiOrigin(origin);
      expect(appsBaseDomain()).toBe('apps.kortix.com');
      expect(appPublicUrl(ROW)).toBe('https://dev-store-aaaaaaaaaaaaaaaa.apps.kortix.com');
    }
  });

  test('a self-host publishes on ITS OWN domain, never on kortix.com', () => {
    // The defect: the fallback was a hard-coded 'apps.kortix.com', so a
    // self-hosted deployment handed its users a hostname on Kortix's domain,
    // pointing at Kortix's Cloudflare Worker, for an App running on the
    // operator's hardware. They could neither serve it nor own it.
    setApiOrigin('https://api.acme.com');
    expect(appsBaseDomain()).toBe('apps.acme.com');
    expect(appPublicUrl(ROW)).toBe('https://dev-store-aaaaaaaaaaaaaaaa.apps.acme.com');
    expect(appPublicUrl(ROW)).not.toContain('kortix.com');

    // ...and it accepts inbound traffic on that same domain, and only there.
    expect(resolveAppHost('dev-store-aaaaaaaaaaaaaaaa.apps.acme.com')).toEqual({
      routeKey: 'aaaaaaaaaaaaaaaa', local: false,
    });
    expect(resolveAppHost('dev-store-aaaaaaaaaaaaaaaa.apps.kortix.com')).toBeNull();
  });

  test('an explicit base domain always wins, scheme and dots tolerated', () => {
    setApiOrigin('https://api.acme.com');
    process.env.KORTIX_APPS_BASE_DOMAIN = 'https://serve.acme.io/';
    expect(appsBaseDomain()).toBe('serve.acme.io');
    expect(appPublicUrl(ROW)).toBe('https://dev-store-aaaaaaaaaaaaaaaa.serve.acme.io');
    expect(resolveAppHost('dev-store-aaaaaaaaaaaaaaaa.serve.acme.io')).toEqual({
      routeKey: 'aaaaaaaaaaaaaaaa', local: false,
    });
  });

  test('the URL Kortix hands out and the host it accepts are the same domain', () => {
    // These were two independent copies of the fallback. A drift between them
    // is an App whose published URL the API refuses to route.
    for (const origin of ['https://api.kortix.com', 'https://api.acme.com', 'https://kortix.example']) {
      setApiOrigin(origin);
      const url = new URL(appPublicUrl(ROW));
      expect(resolveAppHost(url.hostname)).toEqual({ routeKey: ROW.routeKey, local: false });
    }
  });

  test('local development is unchanged', () => {
    process.env.KORTIX_APPS_LOCAL = 'true';
    expect(appPublicUrl(ROW)).toContain('http://aaaaaaaaaaaaaaaa.apps.localhost:');
    expect(resolveAppHost('aaaaaaaaaaaaaaaa.apps.localhost')).toEqual({
      routeKey: 'aaaaaaaaaaaaaaaa', local: true,
    });
  });

  test('refuses to invent a hostname when no domain can be resolved', () => {
    setApiOrigin('not-a-url');
    expect(appsBaseDomain()).toBeNull();
    expect(() => appPublicUrl(ROW)).toThrow('no base domain');
    expect(resolveAppHost('dev-store-aaaaaaaaaaaaaaaa.apps.kortix.com')).toBeNull();
  });

  test('routing stays keyed on the environment and the immutable route key', () => {
    setApiOrigin('https://api.acme.com');
    // Wrong environment prefix, extra label, and a non-route-key label.
    expect(resolveAppHost('prod-store-aaaaaaaaaaaaaaaa.apps.acme.com')).toBeNull();
    expect(resolveAppHost('a.dev-store-aaaaaaaaaaaaaaaa.apps.acme.com')).toBeNull();
    expect(resolveAppHost('dev-store-nothex.apps.acme.com')).toBeNull();
    expect(resolveAppHost('anything.example.com')).toBeNull();
  });
});
