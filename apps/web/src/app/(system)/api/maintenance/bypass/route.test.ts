import { beforeEach, describe, expect, mock, test } from 'bun:test';

import {
  MAINTENANCE_BYPASS_COOKIE,
  MAINTENANCE_BYPASS_TTL_SECONDS,
} from '@/lib/maintenance-bypass';
import { NextRequest } from 'next/server';

// The bypass route reads the session cookie itself (it accepts no bearer
// header); every branch is driven from these handles.
let user: { id: string } | null | undefined = undefined;
let sessionToken: string | null = null;

mock.module('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () =>
        user === undefined
          ? { data: { user: null }, error: { message: 'no session' } }
          : { data: { user }, error: null },
      getSession: async () => ({
        data: { session: sessionToken ? { access_token: sessionToken } : null },
      }),
    },
  }),
}));

const sdk = await import('@kortix/sdk');
let roles: { isAdmin?: boolean } | Error | null = null;
const roleCalls: Array<{ accessToken: string }> = [];
mock.module('@kortix/sdk', () => ({
  ...sdk,
  getUserRolesWithToken: async (input: { accessToken: string }) => {
    roleCalls.push(input);
    if (roles instanceof Error) throw roles;
    return roles ?? {};
  },
}));

const { DELETE, POST } = await import('./route');

beforeEach(() => {
  user = undefined;
  sessionToken = null;
  roles = null;
  roleCalls.length = 0;
});

describe('POST /api/maintenance/bypass', () => {
  test('401 when the request has no session', async () => {
    const response = await POST(
      new NextRequest('http://localhost/api/maintenance/bypass', { method: 'POST' }),
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(roleCalls).toEqual([]);
  });

  test('403 when the session does not name an admin', async () => {
    user = { id: '11111111-1111-4111-8111-111111111111' };
    sessionToken = 'tok_viewer';
    roles = { isAdmin: false };
    const response = await POST(
      new NextRequest('http://localhost/api/maintenance/bypass', { method: 'POST' }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden: admin access required' });
    expect(roleCalls).toHaveLength(1);
    expect(roleCalls[0]?.accessToken).toBe('tok_viewer');
  });

  test('403 when the role backend is unreachable (fail closed)', async () => {
    user = { id: '11111111-1111-4111-8111-111111111111' };
    sessionToken = 'tok_admin';
    roles = new Error('backend down');
    const response = await POST(
      new NextRequest('http://localhost/api/maintenance/bypass', { method: 'POST' }),
    );
    expect(response.status).toBe(403);
  });

  test('200 for an admin: mints the signed httpOnly bypass cookie', async () => {
    user = { id: '11111111-1111-4111-8111-111111111111' };
    sessionToken = 'tok_admin';
    roles = { isAdmin: true };
    const response = await POST(
      new NextRequest('http://localhost/api/maintenance/bypass', { method: 'POST' }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(roleCalls).toHaveLength(1);
    expect(roleCalls[0]?.accessToken).toBe('tok_admin');
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${MAINTENANCE_BYPASS_COOKIE}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain(`Max-Age=${MAINTENANCE_BYPASS_TTL_SECONDS}`);
    expect(setCookie).toContain('SameSite=lax');
  });
});

describe('DELETE /api/maintenance/bypass', () => {
  test('any caller may clear their own bypass cookie', async () => {
    const response = await DELETE();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${MAINTENANCE_BYPASS_COOKIE}=;`);
    expect(setCookie).toContain('Max-Age=0');
  });
});
