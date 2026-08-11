import { beforeEach, describe, expect, mock, test } from 'bun:test';

/**
 * A signup must not land on somebody else's project.
 *
 * Live report: opening a private project link while logged out sends the path
 * through `/auth` as `?redirect=`. Creating an account from there replayed that
 * path verbatim, so the first screen a brand-new user saw was "Request access
 * to this workspace" — a stranger's locked door, on an account that could not
 * possibly own it.
 *
 * This drives the real route handler, because the rule is only as good as its
 * wiring: `return-url.test.ts` proves the decision, this proves the callback
 * actually makes it.
 */

const FOREIGN_LEGACY_PATH = '/projects/319395c1-9c3f-41b4-ac6c-9539a12dbb7c';
const NEW_USER_ID = '44444444-4444-4444-4444-444444444444';

let userCreatedAt = new Date().toISOString();
let exchangeError: { message: string; status?: number } | null = null;

mock.module('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      exchangeCodeForSession: async () => ({
        data: {
          user: {
            id: NEW_USER_ID,
            created_at: userCreatedAt,
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
  getServerPublicEnv: () => ({
    APP_URL: 'https://dev.kortix.com',
    BACKEND_URL: '',
    BILLING_ENABLED: false,
  }),
}));

const { GET } = await import('./route');
const { WORKSPACE_LANDING_PATH } = await import('@/lib/onboarding/landing-destination');

/** The three things the handler actually reads off a NextRequest. */
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

async function destinationFor(returnUrl: string): Promise<string> {
  const response = await GET(callbackRequest(returnUrl));
  const location = new URL(response.headers.get('location') as string);
  return `${location.pathname}${location.search}`;
}

describe('auth callback destination for a brand-new account', () => {
  beforeEach(() => {
    userCreatedAt = new Date().toISOString(); // created just now → this is a signup
    exchangeError = null;
  });

  test('does not send a signup to a workspace it cannot open', async () => {
    const destination = await destinationFor(FOREIGN_LEGACY_PATH);

    expect(destination.startsWith(WORKSPACE_LANDING_PATH)).toBe(true);
    expect(destination).not.toContain('319395c1-9c3f-41b4-ac6c-9539a12dbb7c');
  });

  test('still marks it as a signup for analytics', async () => {
    expect(await destinationFor(FOREIGN_LEGACY_PATH)).toContain('auth_event=signup');
  });

  test('an invite still survives — the signup happened for it', async () => {
    // Bouncing an invited user to their own first project skips the
    // accept/decline dialog and leaves the invite unaccepted.
    expect(await destinationFor('/invites/abc-123')).toStartWith('/invites/abc-123');
  });

  test('an existing user keeps the deep link — request-access is a real surface', async () => {
    // Only signups are redirected away. Someone who was legitimately sent a
    // project link must still reach the page where they can ask for access.
    userCreatedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString();

    const destination = await destinationFor(FOREIGN_LEGACY_PATH);

    expect(destination).toStartWith(FOREIGN_LEGACY_PATH);
    expect(destination).toContain('auth_event=login');
  });
});
