import { afterEach, describe, expect, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import React from 'react';
import { act, create } from 'react-test-renderer';
import { configureKortix } from '../core/http/config';
import {
  clearImpersonationSession,
  getImpersonationSession,
  setImpersonationSession,
} from '../core/http/impersonation';
import {
  ADMIN_IMPERSONATE_ACTIVE_PATH,
  ADMIN_IMPERSONATE_PATH,
  adminImpersonateRevokePath,
  useAdminImpersonate,
  useImpersonation,
  useStopImpersonation,
  type AdminImpersonateResponse,
} from './use-impersonation';

describe('act-as wire contract', () => {
  // The three paths are the entire server contract these hooks depend on, so
  // they are pinned here rather than inside a rendered hook.
  test('mint, revoke and active-list paths match the admin router', () => {
    expect(ADMIN_IMPERSONATE_PATH).toBe('/admin/api/impersonate');
    expect(ADMIN_IMPERSONATE_ACTIVE_PATH).toBe('/admin/api/impersonate/active');
    expect(adminImpersonateRevokePath('grant-1')).toBe('/admin/api/impersonate/grant-1');
  });

  test('a grant id is URL-encoded, so a malformed one cannot reshape the path', () => {
    expect(adminImpersonateRevokePath('../accounts')).toBe(
      '/admin/api/impersonate/..%2Faccounts',
    );
  });

  test('the hooks are exported as hooks', () => {
    expect(typeof useAdminImpersonate).toBe('function');
    expect(typeof useStopImpersonation).toBe('function');
    expect(typeof useImpersonation).toBe('function');
  });

  test('the mint response type carries the server-chosen expiry', () => {
    const response: AdminImpersonateResponse = {
      grant_id: 'g',
      account_id: 'a',
      account_name: null,
      expires_at: '2026-08-11T13:00:00.000Z',
    };
    expect(response.expires_at).toBe('2026-08-11T13:00:00.000Z');
  });
});

describe('useAdminImpersonate', () => {
  Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', { value: true, configurable: true });

  const expiresAt = new Date(Date.now() + 30 * 60_000).toISOString();
  let calls: Array<{ method: string; path: string; body: unknown }> = [];

  function mountMint() {
    calls = [];
    configureKortix({
      backendUrl: 'http://backend.test/v1',
      getToken: async () => 'tok',
      fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : null;
        const url = new URL(request ? request.url : String(input));
        const text = request ? await request.text() : typeof init?.body === 'string' ? init.body : '';
        calls.push({
          method: (request?.method ?? init?.method ?? 'GET').toUpperCase(),
          path: url.pathname,
          body: text ? JSON.parse(text) : null,
        });
        const payload =
          (request?.method ?? init?.method) === 'POST'
            ? { grant_id: 'grant-new', account_id: 'acct-of-project', account_name: 'Acme', expires_at: expiresAt }
            : { ok: true };
        return new Response(JSON.stringify(payload), { headers: { 'content-type': 'application/json' } });
      },
    });
    let mint!: ReturnType<typeof useAdminImpersonate>;
    function Probe() {
      mint = useAdminImpersonate();
      return null;
    }
    const client = new QueryClient();
    act(() => {
      create(React.createElement(QueryClientProvider, { client }, React.createElement(Probe)));
    });
    return () => mint;
  }

  afterEach(() => {
    clearImpersonationSession();
    configureKortix({ backendUrl: '', getToken: async () => null });
  });

  test('mints by project id and stores the session for the project account', async () => {
    const mint = mountMint();
    await act(async () => {
      await mint().mutateAsync({ projectId: 'proj-1', reason: 'Open as admin' });
    });
    expect(calls).toEqual([
      { method: 'POST', path: '/v1/admin/api/impersonate', body: { project_id: 'proj-1', reason: 'Open as admin' } },
    ]);
    expect(getImpersonationSession()).toMatchObject({ grantId: 'grant-new', accountId: 'acct-of-project' });
  });

  test('a new grant revokes the one it replaces, so the old one does not stay live for its hour', async () => {
    setImpersonationSession({ grantId: 'grant-old', accountId: 'acct-old', expiresAt });
    const mint = mountMint();
    await act(async () => {
      await mint().mutateAsync({ projectId: 'proj-1' });
    });
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/admin/api/impersonate',
      'DELETE /v1/admin/api/impersonate/grant-old',
    ]);
    expect(getImpersonationSession()?.grantId).toBe('grant-new');
  });
});
