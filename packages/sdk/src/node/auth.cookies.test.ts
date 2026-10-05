import { describe, expect, test } from 'bun:test';

import { createKortixAuth } from './auth';

/**
 * The cookie policy decides whether an EMBEDDED App can sign anyone in.
 *
 * A `Lax` cookie is not sent on a cross-site frame request, so a dashboard
 * running inside another origin fails its callback with `state_mismatch` no
 * matter how correct the rest of the flow is. `None` fixes that — and is only
 * legal beside `Secure`, which is why an insecure origin must keep `Lax`
 * rather than emit a cookie every browser silently drops.
 */
function makeAuth(cookieSameSite?: 'lax' | 'none', redirectUri = 'https://app.example/api/auth/callback') {
  return createKortixAuth({
    backendUrl: 'https://api.example/v1',
    clientId: 'client-1',
    redirectUri,
    cookieSecret: 'x'.repeat(48),
    ...(cookieSameSite ? { cookieSameSite } : {}),
  });
}

async function txnCookie(auth: ReturnType<typeof makeAuth>, url: string): Promise<string> {
  const res = await auth.handler(new Request(url));
  return res.headers.getSetCookie().find((c) => c.includes('kortix_oauth_txn')) ?? '';
}

describe('createKortixAuth cookie policy', () => {
  test('defaults to Lax — the safe choice for an ordinary top-level app', async () => {
    const cookie = await txnCookie(makeAuth(), 'https://app.example/api/auth/signin');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('SameSite=None');
  });

  test('cookieSameSite "none" lets an embedded App complete its callback', async () => {
    const cookie = await txnCookie(makeAuth('none'), 'https://app.example/api/auth/signin');
    expect(cookie).toContain('SameSite=None');
    // None without Secure is rejected by every browser, so they travel together.
    expect(cookie).toContain('Secure');
  });

  test('an insecure origin keeps Lax even when "none" is asked for', async () => {
    // Emitting `SameSite=None` without `Secure` produces a cookie the browser
    // drops on arrival — a sign-in that fails with no error anywhere.
    //
    // "Secure" is decided by the REDIRECT URI's scheme, not the request's: the
    // redirect URI is the App's real public origin, while an inbound request
    // behind a proxy routinely arrives as http regardless.
    const cookie = await txnCookie(
      makeAuth('none', 'http://app.localhost/api/auth/callback'),
      'http://app.localhost/api/auth/signin',
    );
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
  });
});
