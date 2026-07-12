// The SP values (Entity ID / ACS) are what admins paste into their IdP — a
// wrong join here means federation fails at the IdP with an opaque error.
import { describe, expect, test } from 'bun:test';
import { buildSamlSpUrls, resolveSupabaseOrigin } from './saml-sp';

describe('resolveSupabaseOrigin', () => {
  test('absolute URLs pass through with trailing slash stripped', () => {
    expect(resolveSupabaseOrigin('https://abc.supabase.co')).toBe('https://abc.supabase.co');
    expect(resolveSupabaseOrigin('https://abc.supabase.co/')).toBe('https://abc.supabase.co');
  });

  test('missing/malformed values resolve to null (block hidden, not broken)', () => {
    expect(resolveSupabaseOrigin(undefined)).toBeNull();
    expect(resolveSupabaseOrigin('')).toBeNull();
    expect(resolveSupabaseOrigin('not-a-url')).toBeNull();
  });
});

describe('buildSamlSpUrls', () => {
  test('derives the Entity ID and ACS from the auth origin', () => {
    expect(buildSamlSpUrls('https://abc.supabase.co/')).toEqual({
      entityId: 'https://abc.supabase.co/auth/v1/sso/saml/metadata',
      acsUrl: 'https://abc.supabase.co/auth/v1/sso/saml/acs',
    });
  });

  test('returns null when the origin is unresolvable', () => {
    expect(buildSamlSpUrls(undefined)).toBeNull();
  });
});
