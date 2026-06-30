import { beforeEach, describe, expect, mock, test } from 'bun:test';

const supabase = {
  auth: {
    signUp: mock(async () => ({ error: null })),
    signInWithPassword: mock(async () => ({
      data: {
        session: {
          access_token: 'access-token',
          refresh_token: 'refresh-token',
        },
      },
      error: null,
    })),
    verifyOtp: mock(async () => ({
      data: {
        user: { created_at: new Date().toISOString() },
        session: {
          access_token: 'otp-access-token',
          refresh_token: 'otp-refresh-token',
        },
      },
      error: null,
    })),
  },
};

const resolveFirstProjectPathForNewUser = mock(async () => '/projects/provisioned');
const accountHasAppAccess = mock(() => true);
const buildMobileSessionHandoffUrl = mock(() => null);

mock.module('@/lib/supabase/server', () => ({
  createClient: async () => supabase,
}));
mock.module('@/lib/public-env-server', () => ({
  getServerPublicEnv: () => ({
    APP_URL: 'http://localhost:3000',
    BACKEND_URL: 'http://localhost:8008/v1',
    BILLING_ENABLED: true,
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_ANON_KEY: 'test-anon-key',
    WEBHOOK_BASE_URL: 'http://localhost:8008',
    SANDBOX_ID: '',
    AUTH_PROVIDERS: '',
    AUTH_METHODS: 'magic,password',
    VERSION: 'test',
  }),
}));
mock.module('@/lib/auth/bootstrap-first-project', () => ({
  resolveFirstProjectPathForNewUser,
}));
mock.module('@/lib/auth/account-access', () => ({ accountHasAppAccess }));
mock.module('@/lib/auth/mobile-handoff', () => ({ buildMobileSessionHandoffUrl }));

const { signUpWithPassword, verifyOtp } = await import('./actions');

function formData(entries: Record<string, string>): FormData {
  const data = new FormData();
  for (const [key, value] of Object.entries(entries)) data.set(key, value);
  return data;
}

beforeEach(() => {
  supabase.auth.signUp.mockClear();
  supabase.auth.signInWithPassword.mockClear();
  supabase.auth.verifyOtp.mockClear();
  resolveFirstProjectPathForNewUser.mockClear();
  accountHasAppAccess.mockClear();
  buildMobileSessionHandoffUrl.mockClear();
});

describe('invite return handling in auth actions', () => {
  test('signUpWithPassword preserves an invite return URL instead of provisioning a first project', async () => {
    const result = await signUpWithPassword(null, formData({
      email: 'invitee@example.com',
      password: 'strong-password',
      confirmPassword: 'strong-password',
      returnUrl: '/invites/invite-123',
      origin: 'http://localhost:3000',
    }));

    expect(result).toMatchObject({
      success: true,
      redirectTo: '/invites/invite-123',
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
    });
    expect(resolveFirstProjectPathForNewUser).not.toHaveBeenCalled();
  });

  test('verifyOtp preserves an invite return URL instead of applying billing-aware landing', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return new Response(JSON.stringify({ can_run: false }), { status: 200 });
    }) as typeof fetch;

    try {
      const result = await verifyOtp(null, formData({
        email: 'invitee@example.com',
        token: '123456',
        returnUrl: '/invites/invite-456',
        origin: 'http://localhost:3000',
      }));

      expect(result).toMatchObject({
        success: true,
        redirectTo: '/invites/invite-456',
        accessToken: 'otp-access-token',
        refreshToken: 'otp-refresh-token',
      });
      expect(fetchCalls).toEqual([]);
      expect(resolveFirstProjectPathForNewUser).not.toHaveBeenCalled();
      expect(accountHasAppAccess).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
