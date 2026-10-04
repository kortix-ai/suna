import { beforeEach, describe, expect, mock, test } from 'bun:test';

import type { MaintenanceConfig } from '@/lib/maintenance-store';
import { NextRequest } from 'next/server';

// The supabase server client is the only way this route sees a session when
// no bearer token is presented; every branch is driven from these handles.
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

// Spread the real SDK so unrelated imports keep working; only the role
// endpoint is faked, with the exact call it received.
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

const CURRENT: MaintenanceConfig = {
  level: 'none',
  title: '',
  message: '',
  startTime: null,
  endTime: null,
  statusUrl: null,
  affectedServices: [],
  updatedAt: '2026-01-01T00:00:00.000Z',
};
let saved: MaintenanceConfig | null = null;
let savedWithToken: string | null = null;
mock.module('@/lib/maintenance-store', () => ({
  getMaintenanceConfig: async () => CURRENT,
  readDatabaseMaintenanceConfig: async () => CURRENT,
  reconcileMaintenanceEdgeConfig: async () => {},
  setMaintenanceConfig: async (config: MaintenanceConfig, accessToken: string) => {
    saved = config;
    savedWithToken = accessToken;
    return config;
  },
}));

const { PUT } = await import('./route');

function put(body: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/maintenance', {
    method: 'PUT',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  user = undefined;
  sessionToken = null;
  roles = null;
  roleCalls.length = 0;
  saved = null;
  savedWithToken = null;
});

describe('PUT /api/maintenance', () => {
  test('401 when the request carries no credential at all', async () => {
    const response = await PUT(put({ level: 'warning' }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Unauthorized' });
    expect(roleCalls).toEqual([]);
  });

  test('403 when the bearer token does not name an admin', async () => {
    roles = { isAdmin: false };
    const response = await PUT(put({ level: 'warning' }, { authorization: 'Bearer tok_viewer' }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'Forbidden: admin access required' });
    expect(roleCalls).toHaveLength(1);
    expect(roleCalls[0]?.accessToken).toBe('tok_viewer');
  });

  test('403 when the role backend is unreachable (fail closed)', async () => {
    roles = new Error('backend down');
    const response = await PUT(put({ level: 'warning' }, { authorization: 'Bearer tok_admin' }));
    expect(response.status).toBe(403);
    expect(roleCalls).toHaveLength(1);
    expect(roleCalls[0]?.accessToken).toBe('tok_admin');
  });

  test('200 for an admin: the merged config is stored with the same token', async () => {
    roles = { isAdmin: true };
    const response = await PUT(
      put({ level: 'warning', title: 'Rolling restart' }, { authorization: 'Bearer tok_admin' }),
    );
    expect(response.status).toBe(200);
    expect(roleCalls).toHaveLength(1);
    expect(roleCalls[0]?.accessToken).toBe('tok_admin');
    expect(savedWithToken).toBe('tok_admin');
    expect(saved).toMatchObject({
      level: 'warning',
      title: 'Rolling restart',
      message: '',
      startTime: null,
      endTime: null,
      statusUrl: null,
      affectedServices: [],
    });
    expect((saved as MaintenanceConfig).updatedAt).not.toBe(CURRENT.updatedAt);
  });

  test('400 for a level outside the enum', async () => {
    roles = { isAdmin: true };
    const response = await PUT(put({ level: 'silver' }, { authorization: 'Bearer tok_admin' }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: 'Invalid level. Must be one of: none, info, warning, critical, blocking',
    });
  });
});
