import { describe, expect, test } from 'bun:test';

import { SCOPE_HELP, parseRedirectUris, summarizeRedirectUris } from './oauth-apps-card';

/**
 * The register form's only real logic: turning the redirect-URI textarea into
 * the list `POST /accounts/{id}/iam/oauth-clients` accepts, or into a sentence
 * that names the offending line. The rules mirror `normalizeRedirectUris` in
 * `apps/api/src/repositories/oauth-clients.ts` so a typo is caught before the
 * round-trip, with the same verdict the server would give.
 */
describe('parseRedirectUris', () => {
  test('one URI per line; blank lines and padding are ignored', () => {
    expect(
      parseRedirectUris(
        '  https://app.example.com/api/kortix/auth/callback  \n\n\r\nhttps://app.example.com/other\n',
      ),
    ).toEqual({
      ok: true,
      value: ['https://app.example.com/api/kortix/auth/callback', 'https://app.example.com/other'],
    });
  });

  test('duplicates collapse silently', () => {
    expect(parseRedirectUris('https://a.example/cb\nhttps://a.example/cb')).toEqual({
      ok: true,
      value: ['https://a.example/cb'],
    });
  });

  test('http is allowed on loopback hosts only', () => {
    for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000', 'app.localhost']) {
      expect(parseRedirectUris(`http://${host}/cb`)).toEqual({
        ok: true,
        value: [`http://${host}/cb`],
      });
    }
    expect(parseRedirectUris('http://app.example.com/cb')).toEqual({
      ok: false,
      error: 'Use https (http is allowed on localhost only): http://app.example.com/cb',
    });
  });

  test('rejects a relative path and names it', () => {
    expect(parseRedirectUris('https://ok.example/cb\n/api/callback')).toEqual({
      ok: false,
      error: 'Not an absolute URL: /api/callback',
    });
  });

  test('rejects non-http schemes and fragments', () => {
    expect(parseRedirectUris('myapp://callback')).toEqual({
      ok: false,
      error: 'Redirect URIs must be http(s): myapp://callback',
    });
    expect(parseRedirectUris('https://a.example/cb#token')).toEqual({
      ok: false,
      error: "Redirect URIs can't carry a #fragment: https://a.example/cb#token",
    });
  });

  test('needs at least one and at most 20', () => {
    expect(parseRedirectUris('')).toEqual({ ok: false, error: 'Add at least one redirect URI.' });
    expect(parseRedirectUris('\n  \n')).toEqual({
      ok: false,
      error: 'Add at least one redirect URI.',
    });
    const twentyOne = Array.from({ length: 21 }, (_, i) => `https://a.example/cb/${i}`).join('\n');
    expect(parseRedirectUris(twentyOne)).toEqual({
      ok: false,
      error: 'At most 20 redirect URIs.',
    });
    const twenty = Array.from({ length: 20 }, (_, i) => `https://a.example/cb/${i}`).join('\n');
    expect(parseRedirectUris(twenty).ok).toBe(true);
  });
});

describe('summarizeRedirectUris', () => {
  test('first URI in full, then a count', () => {
    expect(summarizeRedirectUris([])).toBe('No redirect URI');
    expect(summarizeRedirectUris(['https://a.example/cb'])).toBe('https://a.example/cb');
    expect(summarizeRedirectUris(['https://a.example/cb', 'https://b.example/cb'])).toBe(
      'https://a.example/cb +1 more',
    );
  });
});

describe('SCOPE_HELP', () => {
  test('covers every scope the server supports', () => {
    // `OAUTH_SCOPES` in `apps/api/src/oauth/access-token.ts`.
    expect(Object.keys(SCOPE_HELP).sort()).toEqual(['email', 'kortix', 'profile']);
  });
});
