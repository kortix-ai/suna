import { afterEach, describe, expect, test } from 'bun:test';

process.env.ALLOWED_SANDBOX_PROVIDERS = 'e2b';
process.env.E2B_API_KEY = 'e2b_test_key';
process.env.KORTIX_URL = 'https://api.example.com';
process.env.INTERNAL_KORTIX_ENV = 'dev';
process.env.SUPABASE_URL = 'http://supabase.test';
process.env.FRONTEND_URL = 'https://app.example.com';

const { config } = await import('../../config');
const { e2bDomain } = await import('./e2b-domain');

const original = config.E2B_DOMAIN;
afterEach(() => {
  (config as { E2B_DOMAIN: string }).E2B_DOMAIN = original;
});

function setDomain(value: string) {
  (config as { E2B_DOMAIN: string }).E2B_DOMAIN = value;
}

describe('E2B cluster resolution', () => {
  test('the configured cluster is the one both halves use', () => {
    // The bug this pins: the SDK defaults `domain` to `e2b.app` while Kortix
    // config defaults E2B_DOMAIN to `e2b.dev`. Whichever value wins, template
    // builds and sandbox creation must agree on it — passing it explicitly is
    // the only way that holds when an operator has not exported the variable.
    expect(e2bDomain()).toBe(config.E2B_DOMAIN);
  });

  test('accepts a self-hosted cluster with a scheme or a trailing slash', () => {
    setDomain('https://e2b.acme.internal/');
    expect(e2bDomain()).toBe('e2b.acme.internal');

    setDomain('  http://e2b.acme.internal  ');
    expect(e2bDomain()).toBe('e2b.acme.internal');

    setDomain('e2b.acme.internal');
    expect(e2bDomain()).toBe('e2b.acme.internal');
  });

  test('refuses an empty cluster rather than silently using the vendor default', () => {
    setDomain('   ');
    expect(() => e2bDomain()).toThrow('E2B_DOMAIN is empty');
  });
});
