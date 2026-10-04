import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * Pins the callback's redirect contracts the refactor must not bend:
 *
 *  - an expired/invalid link lands on `/auth?expired=true&returnUrl=<next>`
 *    byte-identically, whether Supabase reports it through the callback's
 *    query params or through the code-exchange failure;
 *  - any other error lands on `/auth?error=<message>`;
 *  - the billing-aware landing override: with billing on, a reachable
 *    backend, and an account WITHOUT app access, the sign-in lands on
 *    `/settings/billing` (the one destination that must not get a project —
 *    see `accountHasAppAccess`); an invite return URL is still honored
 *    verbatim, and an account WITH app access keeps its return URL.
 *
 * The demotion and signup rules have their own suites (bounce-attribution,
 * signup-destination). This file exists so the expired/error URL shapes and
 * the billing override are pinned by behavior before the handler's structure
 * is flattened.
 */

let exchangeError: { message: string; status?: number; code?: string } | null = null;
let accountState: Record<string, unknown> | null = null;

const MOCK_ENV = {
  APP_URL: 'https://dev.kortix.com',
  BACKEND_URL: 'https://api.dev.kortix.com/v1',
  BILLING_ENABLED: true,
};

mock.module('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      exchangeCodeForSession: async () => ({
        data: {
          user: exchangeError
            ? null
            : {
                id: '11111111-1111-1111-1111-111111111111',
                created_at: new Date().toISOString(),
                app_metadata: { provider: 'google' },
                user_metadata: {},
              },
        },
        error: exchangeError,
      }),
      getSession: async () => ({ data: { session: { access_token: 'tok' } } }),
      updateUser: async () => ({ data: {}, error: null }),
    },
  }),
}));

mock.module('@/lib/public-env-server', () => ({
  getServerPublicEnv: () => MOCK_ENV,
  serverBackendUrl: (fallback = '') => MOCK_ENV.BACKEND_URL || fallback,
}));

mock.module('@kortix/sdk', () => ({
  ACTIVE_INSTANCE_COOKIE: 'kortix-instance',
  fetchAccountStateWithToken: async () => accountState,
}));

const { GET } = await import('./route');

/** The three things the handler actually reads off a NextRequest. */
function callbackRequest(params: Record<string, string>) {
  const url = new URL('https://dev.kortix.com/auth/callback');
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  return {
    url: url.toString(),
    nextUrl: url,
    cookies: { get: () => undefined },
  } as never;
}

async function locationOf(params: Record<string, string>): Promise<string> {
  const response = await GET(callbackRequest(params));
  return response.headers.get('location') as string;
}

describe('auth callback redirect contracts', () => {
  beforeEach(() => {
    exchangeError = null;
    accountState = null;
  });

  describe('expired and invalid links', () => {
    test('an otp_expired param lands on /auth?expired=true with the return URL kept', async () => {
      expect(
        await locationOf({ error: 'invalid_request', error_code: 'otp_expired', returnUrl: '/projects/p1' }),
      ).toBe('https://dev.kortix.com/auth?expired=true&returnUrl=%2Fprojects%2Fp1');
    });

    test('an expired error string lands the same way (the default landing URL rides along)', async () => {
      // `next` is the SANITIZED return URL: with none given it is the landing
      // door, so the expired redirect always carries a returnUrl.
      expect(await locationOf({ error: 'expired_token' })).toBe(
        'https://dev.kortix.com/auth?expired=true&returnUrl=%2Fprojects%2Fstart',
      );
    });

    test('an expired code-exchange failure lands the same way', async () => {
      exchangeError = { message: 'email link expired', code: 'otp_expired' };

      expect(await locationOf({ code: 'auth-code', returnUrl: '/marketplace' })).toBe(
        'https://dev.kortix.com/auth?expired=true&returnUrl=%2Fmarketplace',
      );
    });

    test('a non-expired error param keeps its message on /auth?error=', async () => {
      expect(await locationOf({ error: 'access_denied' })).toBe(
        'https://dev.kortix.com/auth?error=access_denied',
      );
    });

    test('a non-expired exchange failure keeps its message on /auth?error=', async () => {
      exchangeError = { message: 'server exploded', status: 500 };

      expect(await locationOf({ code: 'auth-code' })).toBe(
        'https://dev.kortix.com/auth?error=server%20exploded',
      );
    });

    test('no code and no token lands on the bare auth page', async () => {
      expect(await locationOf({})).toBe('https://dev.kortix.com/auth');
    });
  });

  describe('billing-aware landing override', () => {
    test('an account without app access lands on /settings/billing', async () => {
      // plan none and no runnable credits → accountHasAppAccess is false.
      accountState = { plan: { key: 'none' }, credits: { can_run: false } };

      expect(await locationOf({ code: 'auth-code' })).toContain('/settings/billing');
    });

    test('an account with app access keeps its return URL', async () => {
      accountState = { plan: { key: 'pro' } };

      expect(await locationOf({ code: 'auth-code', returnUrl: '/marketplace' })).toStartWith(
        'https://dev.kortix.com/marketplace',
      );
    });

    test('an invite return URL is honored verbatim even without app access', async () => {
      // Bouncing an invited user to the billing page skips the accept/decline
      // dialog and leaves the invite unaccepted.
      accountState = { plan: { key: 'none' }, credits: { can_run: false } };

      expect(await locationOf({ code: 'auth-code', returnUrl: '/invites/abc-123' })).toStartWith(
        'https://dev.kortix.com/invites/abc-123',
      );
    });
  });
});
