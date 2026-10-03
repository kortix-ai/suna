import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * A session with an enrolled, verified TOTP factor owes the challenge before
 * the app.
 *
 * Live finding (dogfood journey `auth-mfa-enroll`): a fresh magic-link
 * sign-in landed on /projects with a verified factor enrolled, and
 * `/auth/v1/factors/{id}/challenge` + `/verify` were never called — the
 * second factor protected nothing. The magic link proves the mailbox, not
 * the factor. The callback is where that first-factor session is minted, so
 * this drives the REAL route handler: with a verified TOTP factor the
 * sign-in must land on the challenge with the destination riding along, and
 * without one it must land exactly where it did before.
 */

let userFactors: Array<Record<string, string>> = [];

mock.module('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      exchangeCodeForSession: async () => ({
        data: {
          user: {
            id: '33333333-3333-3333-3333-333333333333',
            created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
            app_metadata: { provider: 'email' },
            user_metadata: {},
            factors: userFactors,
          },
        },
        error: null,
      }),
      getSession: async () => ({ data: { session: { access_token: 'tok' } } }),
      updateUser: async () => ({ data: {}, error: null }),
    },
  }),
}));

mock.module('@/lib/public-env-server', () => ({
  getServerPublicEnv: () => ({
    APP_URL: 'https://dev.kortix.com',
    BACKEND_URL: '',
    BILLING_ENABLED: false,
  }),
}));

const { GET } = await import('./route');

const MFA_PENDING_COOKIE = 'kortix-mfa-pending';

function callbackRequest(returnUrl: string) {
  const url = new URL('https://dev.kortix.com/auth/callback');
  url.searchParams.set('code', 'auth-code');
  url.searchParams.set('returnUrl', returnUrl);
  return {
    url: url.toString(),
    nextUrl: url,
    cookies: { get: () => undefined },
  } as never;
}

function setCookieFor(response: Response, name: string): string | undefined {
  return response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
}

async function destinationFor(returnUrl: string): Promise<string> {
  const response = await GET(callbackRequest(returnUrl));
  return new URL(response.headers.get('location') as string).pathname;
}

describe('auth callback enforces the TOTP challenge', () => {
  beforeEach(() => {
    userFactors = [];
  });

  test('a verified TOTP factor sends the sign-in to the challenge, not the app', async () => {
    userFactors = [{ factor_type: 'totp', status: 'verified' }];

    const response = await GET(callbackRequest('/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c'));
    const location = new URL(response.headers.get('location') as string);

    expect(location.pathname).toBe('/auth/mfa');
    expect(location.searchParams.get('returnUrl')).toBe(
      '/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c',
    );
    // The middleware holds every app path behind the challenge until the
    // code verifies — the cookie is the pending flag it reads.
    expect(setCookieFor(response, MFA_PENDING_COOKIE)).toBeDefined();
  });

  test('a session without factors lands where it was going', async () => {
    expect(await destinationFor('/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c')).toBe(
      '/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c',
    );
  });

  test('an unverified TOTP enrollment does not gate the sign-in', async () => {
    userFactors = [{ factor_type: 'totp', status: 'unverified' }];
    expect(await destinationFor('/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c')).toBe(
      '/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c',
    );
  });

  test('a phone factor does not gate the sign-in (TOTP scope)', async () => {
    userFactors = [{ factor_type: 'phone', status: 'verified' }];
    expect(await destinationFor('/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c')).toBe(
      '/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c',
    );
  });
});
