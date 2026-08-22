// The identity-mismatch notice is a three-part wiring: /auth records the
// address it is ASKING the IdP for, the callback compares it to who came back,
// and the notice says so. Any one of the three silently missing puts the flow
// back to where it started — signed in as somebody else with nothing on screen
// to say so — and none of the three fails loudly on its own. So they are
// pinned here together.
//
// The comparison itself is unit-tested in lib/auth/sso-identity.test.ts; these
// are wiring assertions, deliberately about the source text.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const authPage = readFileSync(join(import.meta.dir, 'page.tsx'), 'utf8');
const callback = readFileSync(join(import.meta.dir, 'callback', 'route.ts'), 'utf8');
const notice = readFileSync(
  join(import.meta.dir, '..', '..', '..', 'features', 'auth', 'sso-identity-notice.tsx'),
  'utf8',
);
const layout = readFileSync(join(import.meta.dir, '..', '..', 'layout.tsx'), 'utf8');

describe('/auth records the identity it asked for', () => {
  test('EVERY navigation to the IdP is preceded by recording the typed address', () => {
    // Both doors reach the IdP: the enforced-SSO path navigates straight to
    // data.url, and the interstitial navigates to ssoUrl on click. A door added
    // later that forgets this simply reports no mismatch, which is the failure
    // this test exists to catch.
    const hops = authPage.match(/window\.location\.href = (data\.url|ssoUrl);/g) ?? [];
    expect(hops.length).toBe(2);

    const calls = authPage.match(/rememberSsoExpectedEmail\(/g) ?? [];
    expect(calls.length).toBe(2);

    for (const target of ['data.url', 'ssoUrl']) {
      const at = authPage.indexOf(`window.location.href = ${target};`);
      expect(at).toBeGreaterThan(-1);
      // The recording must happen BEFORE the navigation, not after it — after
      // is never reached, and a browser is under no obligation to finish it.
      const preceding = authPage.slice(Math.max(0, at - 400), at);
      expect(preceding).toContain('rememberSsoExpectedEmail(');
    }
  });
});

describe('the callback compares who came back', () => {
  test('it compares the recorded address against the authenticated user', () => {
    expect(callback).toContain('isSsoIdentityMismatch(');
    expect(callback).toContain(
      'readSsoExpectedEmail(request.cookies.get(SSO_EXPECTED_EMAIL_COOKIE)',
    );
    expect(callback).toContain('data.user.email');
  });

  test('the marker travels on the redirect, and the address does NOT', () => {
    expect(callback).toContain(
      'redirectUrl.searchParams.set(SSO_IDENTITY_PARAM, SSO_IDENTITY_MISMATCH)',
    );
    // Putting the signed-in address in the URL would persist it in history and
    // leak it in the Referer of anything the landing page requests.
    expect(callback).not.toContain(`searchParams.set(SSO_IDENTITY_PARAM, data.user.email`);
  });

  test('the expectation cookie is cleared unconditionally, not only on a mismatch', () => {
    // A leftover expectation would mislabel the NEXT sign-in on this browser.
    expect(callback).toContain(
      `response.cookies.set(SSO_EXPECTED_EMAIL_COOKIE, '', { maxAge: 0, path: '/' })`,
    );
    const clearAt = callback.indexOf('response.cookies.set(SSO_EXPECTED_EMAIL_COOKIE');
    const guardAt = callback.indexOf('if (ssoIdentityMismatch)');
    expect(clearAt).toBeGreaterThan(-1);
    // The clear sits outside the mismatch branch: it comes after the branch
    // closes, on the response rather than inside the conditional.
    expect(clearAt).toBeGreaterThan(guardAt);
    const branch = callback.slice(
      guardAt,
      callback.indexOf('const response = NextResponse.redirect'),
    );
    expect(branch).not.toContain('SSO_EXPECTED_EMAIL_COOKIE');
  });

  test('the TODO it closes is gone', () => {
    expect(callback).not.toContain('TODO(sso-identity-mismatch-notice)');
  });
});

describe('the notice reaches the user', () => {
  test('it is mounted globally, because the landing page is not a fixed route', () => {
    // finalDestination can be a project, /settings/billing, an invite, or a
    // last-project cookie path. Mounting on any one of them would miss the rest.
    expect(layout).toContain('SsoIdentityNotice');
    expect(layout).toContain("import('@/features/auth/sso-identity-notice')");
  });

  test('it names the account from the SESSION, not from the URL', () => {
    expect(notice).toContain('useAuth()');
    expect(notice).toContain('user?.email');
  });

  test('it does not expire on its own', () => {
    expect(notice).toContain('Number.POSITIVE_INFINITY');
  });

  test('it waits for the session before naming the account', () => {
    expect(notice).toContain('if (isLoading) return;');
  });

  test('it removes the marker from the URL so a reload does not re-notify', () => {
    expect(notice).toContain('params.delete(SSO_IDENTITY_PARAM)');
    expect(notice).toContain('window.history.replaceState');
  });
});
