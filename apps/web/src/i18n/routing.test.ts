import { describe, expect, test } from 'bun:test';

import { isNonPagePath, localizedPathname, unverifiedSessionLocale } from './routing';

const COOKIE = 'sb-kortix-auth-token';

function b64url(value: string): string {
  return Buffer.from(value).toString('base64url');
}

function jwt(claims: object): string {
  return `${b64url('{"alg":"none"}')}.${b64url(JSON.stringify(claims))}.sig`;
}

describe('locale routing', () => {
  test('maps public paths onto the [locale] segment', () => {
    expect(localizedPathname('en', '/')).toBe('/en');
    expect(localizedPathname('de', '/pricing')).toBe('/de/pricing');
    expect(localizedPathname('en', '/de/projects')).toBe('/en/de/projects');
  });

  test('never rewrites Route Handlers, rewrite sources, files, or docs', () => {
    for (const path of [
      '/api/health',
      '/v1/accounts',
      '/scim/v2/Users',
      '/ingest/e',
      '/docs',
      '/docs/quickstart',
      '/mcp',
      '/mcp/server-card',
      '/markdown-negotiation',
      '/markdown/pricing.md',
      '/install',
      '/download/macos',
      '/download/cli/linux-x64',
      '/auth/callback',
      '/auth/mobile/callback',
      '/robots.txt',
      '/.well-known/api-catalog',
    ]) {
      expect(isNonPagePath(path)).toBe(true);
    }
    for (const path of [
      '/',
      '/pricing',
      '/download',
      '/auth',
      '/auth/signup',
      '/projects',
      '/docsearch',
    ]) {
      expect(isNonPagePath(path)).toBe(false);
    }
  });

  test('reads the profile locale from a plain, base64, or chunked session cookie', () => {
    const session = JSON.stringify({ user: { user_metadata: { locale: 'de-DE' } } });
    expect(unverifiedSessionLocale([{ name: COOKIE, value: session }], COOKIE)).toBe('de');
    const encoded = `base64-${b64url(session)}`;
    expect(unverifiedSessionLocale([{ name: COOKIE, value: encoded }], COOKIE)).toBe('de');
    expect(
      unverifiedSessionLocale(
        [
          { name: `${COOKIE}.0`, value: encoded.slice(0, 20) },
          { name: `${COOKIE}.1`, value: encoded.slice(20) },
        ],
        COOKIE,
      ),
    ).toBe('de');
  });

  test('falls back to the access token claims when the session omits the user', () => {
    const session = JSON.stringify({ access_token: jwt({ user_metadata: { locale: 'ja' } }) });
    expect(unverifiedSessionLocale([{ name: COOKIE, value: session }], COOKIE)).toBe('ja');
  });

  test('returns null for no cookie, garbage, or an unsupported locale', () => {
    expect(unverifiedSessionLocale([], COOKIE)).toBeNull();
    expect(unverifiedSessionLocale([{ name: COOKIE, value: 'base64-%%%' }], COOKIE)).toBeNull();
    const nl = JSON.stringify({ user: { user_metadata: { locale: 'nl' } } });
    expect(unverifiedSessionLocale([{ name: COOKIE, value: nl }], COOKIE)).toBeNull();
  });
});
