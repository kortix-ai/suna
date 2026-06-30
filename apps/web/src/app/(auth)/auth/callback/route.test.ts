import { beforeEach, describe, expect, mock, test } from 'bun:test';

const supabase = {
  auth: {
    exchangeCodeForSession: mock(async () => ({
      data: {
        user: {
          created_at: new Date().toISOString(),
          app_metadata: { provider: 'email' },
          user_metadata: {},
        },
      },
      error: null,
    })),
    getSession: mock(async () => ({
      data: { session: { access_token: 'access-token' } },
    })),
    updateUser: mock(async () => ({ error: null })),
  },
};

const resolveFirstProjectPathForNewUser = mock(async () => '/projects/provisioned');
const accountHasAppAccess = mock(() => true);

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

const { GET } = await import('./route');

function request(url: string) {
  return {
    url,
    nextUrl: new URL(url),
    cookies: { get: () => undefined },
  } as any;
}

beforeEach(() => {
  supabase.auth.exchangeCodeForSession.mockClear();
  supabase.auth.getSession.mockClear();
  supabase.auth.updateUser.mockClear();
  resolveFirstProjectPathForNewUser.mockClear();
  accountHasAppAccess.mockClear();
});

describe('auth callback invite return handling', () => {
  test('preserves an invite return URL after code exchange and skips billing-aware landing', async () => {
    const originalFetch = globalThis.fetch;
    const fetchCalls: string[] = [];
    globalThis.fetch = mock(async (input: RequestInfo | URL) => {
      fetchCalls.push(String(input));
      return new Response(JSON.stringify({ can_run: false }), { status: 200 });
    }) as typeof fetch;

    try {
      const response = await GET(request('http://localhost:3000/auth/callback?code=abc&returnUrl=/invites/invite-789'));

      const location = response.headers.get('location') ?? '';
      expect(response.status).toBe(307);
      expect(location).toStartWith('http://localhost:3000/invites/invite-789?');
      expect(location).toContain('auth_event=signup');
      expect(location).toContain('auth_method=email');
      expect(fetchCalls).toEqual([]);
      expect(resolveFirstProjectPathForNewUser).not.toHaveBeenCalled();
      expect(accountHasAppAccess).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
