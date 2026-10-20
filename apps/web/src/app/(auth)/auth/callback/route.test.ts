import { beforeEach, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';

// Only the Supabase transport is replaced; redirect and identity policy run for real.
mock.module('server-only', () => ({}));
const user = { id: '11111111-1111-4111-8111-111111111111', created_at: '2020-01-01', app_metadata: {}, user_metadata: {} };
type AuthResult = { data: { user?: typeof user }; error: { message?: string; code?: string; status?: number } | null };
const verifyOtp = mock(async (_args: unknown): Promise<AuthResult> => ({ data: { user }, error: null }));
const exchangeCodeForSession = mock(async (_code: string): Promise<AuthResult> => ({ data: { user }, error: null }));
const updateUser = mock(async (_args: unknown) => ({ error: null }));
mock.module('@/lib/supabase/server', () => ({ createClient: async () => ({ auth: {
  verifyOtp, exchangeCodeForSession, updateUser,
  getSession: async () => ({ data: { session: null } }),
} }) }));
const { GET } = await import('./route');
const { AUTH_BOUNCE_COOKIE } = await import('@kortix/ui/internal/lib/onboarding/landing-destination');
const request = (query: string, cookie = '') => new NextRequest(`http://localhost:13000/auth/callback?${query}`, { headers: { cookie } });
const location = (response: Response) => {
  const url = response.headers.get('location');
  if (!url) throw new Error('expected a redirect response');
  return new URL(url);
};
beforeEach(() => {
  verifyOtp.mockClear(); exchangeCodeForSession.mockClear(); updateUser.mockClear();
  verifyOtp.mockImplementation(async () => ({ data: { user }, error: null }));
  exchangeCodeForSession.mockImplementation(async () => ({ data: { user }, error: null }));
});
for (const type of ['signup', 'invite', 'magiclink', 'recovery', 'email_change', 'email']) {
  test(`verifies ${type} token hash through identity-aware success`, async () => {
    const response = await GET(request(`token_hash=synthetic&type=${type}&returnUrl=/projects/other`, `${AUTH_BOUNCE_COOKIE}=22222222-2222-4222-8222-222222222222:ignored`));
    expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'synthetic', type });
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
    expect(location(response).pathname).toBe('/projects/start');
    expect(location(response).searchParams.get('auth_event')).toBe('login');
    expect(response.headers.get('set-cookie')).toContain(`${AUTH_BOUNCE_COOKIE}=`);
  });
}
test('legacy token uses the same path, keeps invites and stamps terms', async () => {
  const response = await GET(request('token=synthetic&type=signup&returnUrl=/invites/synthetic&terms_accepted=true'));
  expect(verifyOtp).toHaveBeenCalledWith({ token_hash: 'synthetic', type: 'signup' });
  expect(location(response).pathname).toBe('/invites/synthetic');
  expect(updateUser).toHaveBeenCalled();
});
for (const type of ['', 'sms', 'phone_change', 'untrusted']) {
  test(`rejects unsupported OTP type ${type}`, async () => {
    const response = await GET(request(`token_hash=synthetic&type=${type}`));
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(location(response).pathname).toBe('/auth');
    expect(location(response).search).not.toContain('synthetic');
  });
}
test('expired OTP uses resend destination without leaking token', async () => {
  verifyOtp.mockImplementation(async () => ({ data: {}, error: { message: 'expired', code: 'otp_expired' } }));
  const response = await GET(request('token_hash=synthetic&type=email&returnUrl=/invites/synthetic'));
  expect(location(response).searchParams.get('expired')).toBe('true');
  expect(location(response).searchParams.get('returnUrl')).toBe('/invites/synthetic');
  expect(location(response).searchParams.has('token_hash')).toBe(false);
});
test('PKCE resume is unchanged', async () => {
  exchangeCodeForSession.mockImplementation(async () => ({ data: {}, error: { code: 'pkce_code_verifier_not_found' } }));
  expect(location(await GET(request('code=synthetic'))).searchParams.get('pkce_code')).toBe('synthetic');
});
for (const query of ['desktop=true', 'mobile_callback=1&state=synthetic']) {
  test(`native bounce stays ahead of verification: ${query}`, async () => {
    const response = await GET(request(`${query}&token_hash=synthetic&type=signup`));
    expect(response.headers.get('content-type')).toContain('text/html');
    expect(verifyOtp).not.toHaveBeenCalled();
    expect(exchangeCodeForSession).not.toHaveBeenCalled();
  });
}
test('code success keeps explicit recovery destination', async () => {
  expect(location(await GET(request('code=synthetic&returnUrl=/auth/reset-password'))).pathname).toBe('/auth/reset-password');
});
test('provider error with CR/LF logs one line and keeps the redirect', async () => {
  const errorLog = mock((..._args: unknown[]) => {});
  const original = console.error;
  console.error = errorLog;
  try {
    const forged = encodeURIComponent('bad\r\n[INFO] forged line');
    const response = await GET(request(`error=access_denied&error_code=x&error_description=${forged}`));
    expect(location(response).pathname).toBe('/auth');
    expect(location(response).searchParams.get('error')).toBe('access_denied');
    const logged = errorLog.mock.calls.flat().map(String).join(' ');
    expect(logged).toContain('forged line');
    expect(logged).not.toMatch(/[\r\n]/);
  } finally {
    console.error = original;
  }
});
