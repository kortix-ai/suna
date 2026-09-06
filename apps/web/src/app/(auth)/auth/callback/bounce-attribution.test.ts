import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * An existing account must not inherit somebody else's bounce.
 *
 * Live report: A's session ends on `/projects/<A>`; anything returns the
 * browser there logged out (Back, a bookmark, a second tab), so middleware
 * writes `/auth?redirect=/projects/<A>`. B signs in on that screen and lands on
 * A's "Request access" page — B is an EXISTING user, which is precisely the
 * population the signup-only guard excludes, and the project shell's 403
 * self-heal is ownership-scoped so it parks B there instead of bouncing home.
 *
 * `bounce-attribution.test.ts` (lib/auth) proves the decision. This proves the
 * callback actually makes it, on the real route handler — the same reason
 * `signup-destination.test.ts` exists beside it.
 */

const A_PROJECT = '/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c';
const USER_A = '11111111-1111-1111-1111-111111111111';
const USER_B = '22222222-2222-2222-2222-222222222222';

let signedInUserId = USER_B;
let userCreatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

mock.module('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      exchangeCodeForSession: async () => ({
        data: {
          user: {
            id: signedInUserId,
            created_at: userCreatedAt,
            app_metadata: { provider: 'google' },
            user_metadata: {},
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
const { AUTH_BOUNCE_COOKIE, PROJECT_LANDING_PATH, serializeAuthBounce } =
  await import('@/lib/onboarding/landing-destination');

/** A magic-link/OAuth callback carrying whatever bounce cookie the browser holds. */
function callbackRequest(returnUrl: string, bounceCookie?: string) {
  const url = new URL('https://dev.kortix.com/auth/callback');
  url.searchParams.set('code', 'auth-code');
  url.searchParams.set('returnUrl', returnUrl);
  return {
    url: url.toString(),
    nextUrl: url,
    cookies: {
      get: (name: string) =>
        name === AUTH_BOUNCE_COOKIE && bounceCookie !== undefined
          ? { value: bounceCookie }
          : undefined,
    },
  } as never;
}

async function destinationFor(returnUrl: string, bounceCookie?: string): Promise<string> {
  const response = await GET(callbackRequest(returnUrl, bounceCookie));
  const location = new URL(response.headers.get('location') as string);
  return `${location.pathname}${location.search}`;
}

describe('auth callback honors who was bounced', () => {
  beforeEach(() => {
    signedInUserId = USER_B;
    // An hour old: an EXISTING account, so no signup rule is in play. The bug
    // lives entirely in this case.
    userCreatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  });

  test('bounced as A, signed in as B → demoted to the landing door', async () => {
    const destination = await destinationFor(A_PROJECT, serializeAuthBounce(USER_A, A_PROJECT));

    expect(destination.startsWith(PROJECT_LANDING_PATH)).toBe(true);
    expect(destination).not.toContain('319395c1-9c3f-41b4-ac6c-9539a12dbb7c');
    // Still a login for analytics — this is a destination rule, not an identity
    // downgrade.
    expect(destination).toContain('auth_event=login');
  });

  test('bounced as A, signed in as A → keeps the path', async () => {
    signedInUserId = USER_A;

    const destination = await destinationFor(A_PROJECT, serializeAuthBounce(USER_A, A_PROJECT));

    expect(destination).toStartWith(A_PROJECT);
  });

  test('an UNATTRIBUTED bounce keeps the path', async () => {
    // Middleware could not name an owner (the self-heal had already dropped the
    // session, and nothing remembered a project). Treating unknown as foreign
    // would demote every one of these — including the user's own return.
    const destination = await destinationFor(A_PROJECT, serializeAuthBounce(null, A_PROJECT));

    expect(destination).toStartWith(A_PROJECT);
  });

  test('no bounce cookie at all keeps the path — a pasted or bookmarked link', async () => {
    expect(await destinationFor(A_PROJECT)).toStartWith(A_PROJECT);
  });

  test('a bounce cookie whose owner is not a user id attributes nobody', async () => {
    expect(await destinationFor(A_PROJECT, 'not-a-user:%2Fx')).toStartWith(A_PROJECT);
  });

  test('the bounce is cleared on the way out, so it cannot demote the next sign-in', async () => {
    const response = await GET(callbackRequest(A_PROJECT, serializeAuthBounce(USER_A, A_PROJECT)));
    const cleared = response.headers
      .getSetCookie()
      .find((value: string) => value.startsWith(`${AUTH_BOUNCE_COOKIE}=`));

    expect(cleared).toBeDefined();
    expect(cleared).toContain('Max-Age=0');
  });

  test('a signup is still demoted regardless of attribution', async () => {
    userCreatedAt = new Date().toISOString();

    expect(await destinationFor(A_PROJECT)).toStartWith(PROJECT_LANDING_PATH);
  });
});
