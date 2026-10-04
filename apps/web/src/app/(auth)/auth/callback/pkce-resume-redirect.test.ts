import { beforeEach, describe, expect, mock, test } from 'bun:test';


/**
 * A PKCE exchange whose verifier cookie never made it back to the server must
 * hand the code back to the browser that started the flow, not tell the user
 * their fresh link expired.
 *
 * Live failure (prod, 2026-10-03): every FIRST magic-link sign-in in a fresh
 * browser profile lost the verifier cookie between the `sendEmailCode` server
 * action and the callback, and the visitor landed on `/auth?expired=true` with
 * no session while the link was minutes old. A retry in the same profile
 * worked, which is why the dogfood prod runs failed three times in a row while
 * the same flow passed on dev.
 *
 * The exchange for a missing verifier throws `pkce_code_verifier_not_found`
 * BEFORE any request leaves the server, so the auth code is untouched and the
 * same browser can still complete the flow (lib/auth/pkce-resume.ts). A
 * genuinely expired or used code carries an expiry code from GoTrue and keeps
 * the expired redirect.
 */

const EXCHANGE_ERROR: { code?: string; status?: number; message: string } = {
  code: 'pkce_code_verifier_not_found',
  status: 400,
  message: 'Auth PKCE code verifier missing',
};

let exchangeError: typeof EXCHANGE_ERROR | null = EXCHANGE_ERROR;

mock.module('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      exchangeCodeForSession: async () => ({
        data: { user: null, session: null },
        error: exchangeError,
      }),
      getSession: async () => ({ data: { session: null } }),
    },
  }),
}));

mock.module('@/lib/public-env-server', () => ({
  getServerPublicEnv: () => ({
    APP_URL: 'https://kortix.com',
    BACKEND_URL: '',
    BILLING_ENABLED: false,
  }),
  // The refactor moved the backend-URL normalization into this helper; the
  // empty value keeps the billing-aware landing skipped exactly as before.
  serverBackendUrl: () => '',
}));

const { GET } = await import('./route');

function callbackRequest(search: string) {
  const url = new URL(`https://kortix.com/auth/callback${search}`);
  return {
    url: url.toString(),
    nextUrl: url,
    cookies: { get: () => undefined },
  } as never;
}

function locationOf(response: Response): string {
  return new URL(response.headers.get('location') as string).pathname + new URL(response.headers.get('location') as string).search;
}

beforeEach(() => {
  exchangeError = { ...EXCHANGE_ERROR };
});

describe('auth callback resumes a verifier-less PKCE exchange', () => {
  test('a missing verifier bounces the fresh code back to /auth for the browser to re-seed', async () => {
    const response = await GET(callbackRequest('?code=fresh-code&returnUrl=%2Fprojects%2Fstart&terms_accepted=true'));
    expect(response.status).toBe(307);
    const location = new URL(response.headers.get('location') as string);
    expect(location.pathname).toBe('/auth');
    expect(location.searchParams.get('pkce_code')).toBe('fresh-code');
    expect(location.searchParams.get('returnUrl')).toBe('/projects/start');
    expect(location.searchParams.get('expired')).toBeNull();
  });

  test("a GoTrue otp_expired rejection keeps today's expired/error behavior", async () => {
    exchangeError = { code: 'otp_expired', status: 400, message: 'OTP token expired' };
    const response = await GET(callbackRequest('?code=old-code&returnUrl=%2Fprojects%2Fstart'));
    expect(locationOf(response)).toBe('/auth?expired=true&returnUrl=%2Fprojects%2Fstart');
  });
  test("a GoTrue expired_token rejection keeps today's expired/error behavior", async () => {
    exchangeError = { code: 'expired_token', status: 400, message: 'token expired' };
    const response = await GET(callbackRequest('?code=old-code&returnUrl=%2Fprojects%2Fstart'));
    expect(locationOf(response)).toBe('/auth?expired=true&returnUrl=%2Fprojects%2Fstart');
  });
  test("a GoTrue token_expired rejection keeps today's expired/error behavior", async () => {
    exchangeError = { code: 'token_expired', status: 400, message: 'token expired' };
    const response = await GET(callbackRequest('?code=old-code&returnUrl=%2Fprojects%2Fstart'));
    expect(locationOf(response)).toBe('/auth?expired=true&returnUrl=%2Fprojects%2Fstart');
  });
  test("a GoTrue flow_state_expired rejection keeps today's expired/error behavior", async () => {
    exchangeError = { code: 'flow_state_expired', status: 400, message: 'flow state expired' };
    const response = await GET(callbackRequest('?code=old-code&returnUrl=%2Fprojects%2Fstart'));
    expect(locationOf(response)).toBe('/auth?expired=true&returnUrl=%2Fprojects%2Fstart');
  });
  test("a GoTrue bad_code_verifier rejection keeps today's expired/error behavior", async () => {
    exchangeError = { code: 'bad_code_verifier', status: 400, message: 'code verifier mismatch' };
    const response = await GET(callbackRequest('?code=old-code&returnUrl=%2Fprojects%2Fstart'));
    expect(locationOf(response)).toBe('/auth?expired=true&returnUrl=%2Fprojects%2Fstart');
  });

  test('a successful exchange keeps the existing redirect behavior', async () => {
    exchangeError = null;
    // The route continues past the exchange with a null user; it redirects to
    // the return destination with auth_event params either way.
    const response = await GET(callbackRequest('?code=fresh-code&returnUrl=%2Fprojects%2Fstart'));
    const location = new URL(response.headers.get('location') as string);
    expect(location.pathname).toBe('/projects/start');
    expect(location.searchParams.get('auth_event')).toBe('login');
  });
});
