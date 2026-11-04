import { describe, expect, test } from 'bun:test';

import { withDomainAlias } from './domain-alias-env';

const ENV = {
  SUPABASE_URL: 'https://kortix.acme.cloud',
  BACKEND_URL: 'https://api.kortix.acme.cloud/v1',
  APP_URL: 'https://kortix.acme.cloud',
  WEBHOOK_BASE_URL: 'https://api.kortix.acme.cloud',
  BILLING_ENABLED: false,
};

describe('withDomainAlias', () => {
  test('a page on a configured alias gets every instance URL on that alias', () => {
    expect(withDomainAlias(ENV, 'kortix.acme.com:443', 'kortix.acme.com')).toEqual({
      ...ENV,
      SUPABASE_URL: 'https://kortix.acme.com',
      BACKEND_URL: 'https://api.kortix.acme.com/v1',
      APP_URL: 'https://kortix.acme.com',
    });
  });

  test('webhook URLs stay on the primary domain: outside services call them, not the browser', () => {
    expect(withDomainAlias(ENV, 'kortix.acme.com', 'kortix.acme.com').WEBHOOK_BASE_URL).toBe(
      'https://api.kortix.acme.cloud',
    );
  });

  test('the primary host, an unknown host and a missing host leave the config untouched', () => {
    for (const host of ['kortix.acme.cloud', 'evil.example', '', null, undefined]) {
      expect(withDomainAlias(ENV, host, 'kortix.acme.com')).toBe(ENV);
    }
  });

  test('without aliases nothing moves, whatever the Host header says', () => {
    expect(withDomainAlias(ENV, 'kortix.acme.com', '')).toBe(ENV);
    expect(withDomainAlias(ENV, 'kortix.acme.com', undefined)).toBe(ENV);
  });

  test('a URL outside the primary domain is kept as it is', () => {
    const env = { ...ENV, SUPABASE_URL: 'https://auth.other.net' };
    expect(withDomainAlias(env, 'kortix.acme.com', 'kortix.acme.com').SUPABASE_URL).toBe('https://auth.other.net');
  });
});
