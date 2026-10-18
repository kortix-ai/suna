import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { NextRequest } from 'next/server';

import { KORTIX_SUPABASE_AUTH_COOKIE } from '@/lib/supabase/constants';
import { getMaintenanceConfig, setMaintenanceConfig } from '@/lib/maintenance-store';
import type { MiddlewareAuth } from '@/lib/supabase/middleware-identity';

const user = { id: '11111111-1111-4111-8111-111111111111', user_metadata: { locale: 'de' } };
const getClaims = mock<MiddlewareAuth['getClaims']>(async () => ({
  data: { claims: { sub: user.id } }, error: null,
}));
const getUser = mock<MiddlewareAuth['getUser']>(async () => ({ data: { user }, error: null }));
const createServerClient = mock(() => ({ auth: { getClaims, getUser } }));
// Only the external auth collaborator is replaced; middleware and its identity
// resolver execute normally. No session_id means liveness is checked every time.
mock.module('@supabase/ssr', () => ({ createServerClient }));
const { middleware } = await import('./middleware');

beforeEach(() => {
  createServerClient.mockClear();
  getClaims.mockReset();
  getUser.mockReset();
  getClaims.mockResolvedValue({ data: { claims: { sub: user.id } }, error: null });
  getUser.mockResolvedValue({ data: { user }, error: null });
});
afterAll(() => mock.restore());

function sessionRequest(secondsUntilExpiry: number) {
  const value = `base64-${Buffer.from(JSON.stringify({
    access_token: 'synthetic-access-token',
    refresh_token: 'synthetic-refresh-token',
    expires_at: Math.floor(Date.now() / 1000) + secondsUntilExpiry,
  })).toString('base64url')}`;
  const request = new NextRequest('https://example.test/projects');
  request.cookies.set(KORTIX_SUPABASE_AUTH_COOKIE, value);
  return { request, value };
}

function expectAuthBounce(response: Response) {
  expect(response.status).toBe(307);
  const location = new URL(response.headers.get('location') ?? '');
  expect(location.pathname).toBe('/auth');
  expect(location.searchParams.get('redirect')).toBe('/projects');
}

function expectRetained(request: NextRequest, value: string, response: Response) {
  expect(request.cookies.get(KORTIX_SUPABASE_AUTH_COOKIE)?.value).toBe(value);
  expect(response.headers.getSetCookie().filter((cookie) =>
    cookie.startsWith(`${KORTIX_SUPABASE_AUTH_COOKIE}=`),
  )).toEqual([]);
}

describe('middleware leaves session refresh to the browser', () => {
  for (const [state, seconds] of [['stale', 30], ['expired', -60]] as const) {
    test(`${state} cookie: no client or auth reads, bounce retains the refresh credential`, async () => {
      const { request, value } = sessionRequest(seconds);
      const response = await middleware(request);

      expect(createServerClient).not.toHaveBeenCalled();
      expect(getClaims).not.toHaveBeenCalled();
      expect(getUser).not.toHaveBeenCalled();
      expectAuthBounce(response);
      expectRetained(request, value, response);
    });
  }

  test('fresh cookie resolves a verified live user and renders the protected route', async () => {
    const { request, value } = sessionRequest(3600);
    const response = await middleware(request);

    expect(createServerClient).toHaveBeenCalledTimes(1);
    expect(getClaims).toHaveBeenCalledTimes(1);
    expect(getUser).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(200);
    expect(response.headers.get('location')).toBeNull();
    // The accepted user's verified profile, not the cookie, picks the locale.
    expect(new URL(response.headers.get('x-middleware-rewrite') ?? '').pathname).toBe('/de/projects');
    expectRetained(request, value, response);
  });

  for (const [code, message, clearsCookie] of [
    ['session_not_found', 'Session not found', true],
    ['bad_jwt', 'Invalid JWT: token is expired', false],
  ] as const) {
    test(`${code}: ${clearsCookie ? 'clears dead session' : 'retains refreshable expired JWT'}`, async () => {
      const { request, value } = sessionRequest(3600);
      getUser.mockResolvedValue({
        data: { user: null },
        error: Object.assign(new Error(message), { code, status: code === 'session_not_found' ? 403 : 401 }),
      });
      const response = await middleware(request);

      expect(createServerClient).toHaveBeenCalledTimes(1);
      expect(getClaims).toHaveBeenCalledTimes(1);
      expect(getUser).toHaveBeenCalledTimes(1);
      expectAuthBounce(response);
      if (clearsCookie) {
        const cleared = response.cookies.get(KORTIX_SUPABASE_AUTH_COOKIE);
        expect(cleared?.value).toBe('');
        expect(cleared?.expires?.getTime()).toBe(0);
      } else {
        expectRetained(request, value, response);
      }
    });
  }
});

test('blocking maintenance redirects signed-in locale-prefixed app routes', async () => {
  const original = await getMaintenanceConfig();
  await setMaintenanceConfig({ ...original, level: 'blocking' }, 'synthetic-token');
  try {
    for (const path of ['/en/settings?tab=profile', '/fr/projects']) {
      const { request } = sessionRequest(3600);
      request.nextUrl.pathname = path.split('?')[0];
      request.nextUrl.search = path.includes('?') ? '?tab=profile' : '';
      const response = await middleware(request);
      expect(response.status).toBe(307);
      const location = new URL(response.headers.get('location') ?? '');
      expect(location.pathname).toBe('/maintenance');
      expect(location.searchParams.get('from')).toBe(path.slice(3));
      expect(response.headers.get('x-middleware-rewrite')).toBeNull();
    }
  } finally {
    await setMaintenanceConfig(original, 'synthetic-token');
  }
});
