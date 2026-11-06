import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import * as shared from '../../../../shared/src/workspace-routes';
import { backendApi } from './api-client';
import { authenticatedFetch } from './auth';
import { configureKortix } from './config';
import { send } from './transport';
import {
  WORKSPACE_ACCOUNT_FAMILIES,
  canonicalWorkspaceRoute,
  legacyWorkspaceRoute,
  resetWorkspaceRouteMemory,
  withWorkspaceRouteFallback,
} from './workspace-routes';

// The SDK calls the canonical `/v1/workspaces` names. A server that predates
// them (a self-host API older than the workspace mount) answers the framework's
// unknown-route 404; the SDK then retries the same request once on the legacy
// name and remembers, per API base, to use the legacy names from then on.

const PATHS = [
  '/v1/projects',
  '/v1/projects/p1',
  '/v1/projects/p1/sessions/s1/start',
  '/v1/projects/provision',
  '/v1/projects/p1/audit',
  '/v1/workspaces/p1/audit/events',
  '/v1/workspaces/p1/audit',
  '/v1/webhooks/projects/p1/hook',
  '/v1/webhooks/workspaces/p1/hook',
  '/v1/projects/create-repo',
  '/v1/projects/p1/transfer',
  '/v1/accounts/a1/members',
  '/v1/accounts/a1/iam/groups/g1',
  '/v1/accounts/a1/secret-resources',
  '/v1/accounts/a1/top-up-requests',
  '/v1/accounts/a1',
  '/v1/accounts/a1/billing',
  '/v1/accounts',
  '/v1/accounts/tokens',
  '/v1/accounts/me',
  '/v1/accounts/me/devices',
  '/v1/account-invites',
  '/v1/account-invites/abc/accept',
  '/v1/connectors/projects/p1/connections',
  '/scim/v2/accounts/a1/Users',
  '/v1/workspaces',
  '/v1/workspaces/w1/sessions',
  '/v1/workspaces/w1/members',
  '/v1/workspaces/w1/iam/groups',
  '/v1/me',
  '/v1/me/devices',
  '/v1/invites/abc',
  '/v1/connectors/workspaces/w1/connections',
  '/scim/v2/workspaces/w1/Users',
  '/v1/billing/account-state',
  '/v1/p/ext/8000/kortix/health',
  '/v1/meta',
  '/v1/invitesx',
  '/v1/workspacesx',
];

describe('the SDK copy of the workspace route map', () => {
  test('lists the same account families as @kortix/shared', () => {
    expect([...WORKSPACE_ACCOUNT_FAMILIES]).toEqual([...shared.WORKSPACE_ACCOUNT_FAMILIES]);
  });

  test('maps every path exactly like @kortix/shared', () => {
    for (const path of PATHS) {
      expect({ path, canonical: canonicalWorkspaceRoute(path) }).toEqual({
        path,
        canonical: shared.canonicalWorkspaceRoute(path),
      });
      expect({ path, legacy: legacyWorkspaceRoute(path) }).toEqual({ path, legacy: shared.legacyWorkspaceRoute(path) });
    }
  });
});

// ── The fallback ────────────────────────────────────────────────────────────

type Seen = { method: string; url: string; body: string | null };

/** A server: `/v1/workspaces` and friends exist only when `canonical` is true. */
function server(opts: { canonical: boolean; handler404?: RegExp }) {
  const seen: Seen[] = [];
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : null;
    const url = request ? request.url : String(input);
    const method = (request ? request.method : init?.method) ?? 'GET';
    const body = request ? (request.body ? await request.text() : null) : typeof init?.body === 'string' ? init.body : null;
    seen.push({ method, url, body });
    const path = new URL(url, 'http://origin.test').pathname;
    const v1 = path.slice(path.indexOf('/v1/'));
    if (opts.handler404?.test(v1)) {
      return Response.json({ error: 'Project not found', code: 'project_not_found' }, { status: 404 });
    }
    if (!opts.canonical && legacyWorkspaceRoute(v1) !== null) {
      // The body `app.notFound` answers (apps/api/src/http-errors.ts).
      return Response.json({ error: true, message: 'Not found', status: 404 }, { status: 404 });
    }
    return Response.json({ path: v1, method, body });
  };
  return { seen, fetchImpl };
}

beforeEach(() => resetWorkspaceRouteMemory());
afterEach(() => resetWorkspaceRouteMemory());

describe('withWorkspaceRouteFallback', () => {
  test('a current server answers the canonical name: one request', async () => {
    const s = server({ canonical: true });
    const res = await withWorkspaceRouteFallback(s.fetchImpl)('http://api.test/v1/workspaces/w1/sessions?limit=5');
    expect(res.status).toBe(200);
    expect(s.seen.map((r) => r.url)).toEqual(['http://api.test/v1/workspaces/w1/sessions?limit=5']);
  });

  test('an old server: one unknown-route 404, then the legacy name, remembered per base', async () => {
    const s = server({ canonical: false });
    const f = withWorkspaceRouteFallback(s.fetchImpl);
    const first = await f('http://old.test/v1/workspaces/w1/sessions?limit=5');
    expect(first.status).toBe(200);
    expect(((await first.json()) as { path: string }).path).toBe('/v1/projects/w1/sessions');
    const second = await f('http://old.test/v1/workspaces/w1/members', { method: 'GET' });
    expect(second.status).toBe(200);
    expect(s.seen.map((r) => r.url)).toEqual([
      'http://old.test/v1/workspaces/w1/sessions?limit=5',
      'http://old.test/v1/projects/w1/sessions?limit=5',
      'http://old.test/v1/accounts/w1/members',
    ]);
  });

  test('the memory is per API base: another base still tries the canonical name', async () => {
    const old = server({ canonical: false });
    await withWorkspaceRouteFallback(old.fetchImpl)('http://old.test/v1/me');
    const current = server({ canonical: true });
    await withWorkspaceRouteFallback(current.fetchImpl)('http://new.test/v1/me');
    expect(old.seen.map((r) => r.url)).toEqual(['http://old.test/v1/me', 'http://old.test/v1/accounts/me']);
    expect(current.seen.map((r) => r.url)).toEqual(['http://new.test/v1/me']);
  });

  test('a handler 404 (resource not found) never retries', async () => {
    const s = server({ canonical: false, handler404: /^\/v1\/workspaces\/missing/ });
    const res = await withWorkspaceRouteFallback(s.fetchImpl)('http://old.test/v1/workspaces/missing');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { code: string }).code).toBe('project_not_found');
    expect(s.seen).toHaveLength(1);
    // …and does not mark the server legacy.
    const next = server({ canonical: true });
    await withWorkspaceRouteFallback(next.fetchImpl)('http://old.test/v1/workspaces');
    expect(next.seen.map((r) => r.url)).toEqual(['http://old.test/v1/workspaces']);
  });

  test('a 404 on a path with no legacy name never retries', async () => {
    const s = server({ canonical: false });
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      await s.fetchImpl(input, init);
      return Response.json({ error: true, message: 'Not found', status: 404 }, { status: 404 });
    };
    const res = await withWorkspaceRouteFallback(fetchImpl)('http://old.test/v1/billing/account-state');
    expect(res.status).toBe(404);
    expect(s.seen).toHaveLength(1);
  });

  test('a sandbox proxy path is never rewritten, even with /v1/me inside', async () => {
    const s = server({ canonical: false });
    await withWorkspaceRouteFallback(s.fetchImpl)('http://old.test/v1/p/ext/3000/v1/me');
    expect(s.seen.map((r) => r.url)).toEqual(['http://old.test/v1/p/ext/3000/v1/me']);
  });

  test('the retry resends the method and the body, for a URL and for a Request', async () => {
    const s = server({ canonical: false });
    const f = withWorkspaceRouteFallback(s.fetchImpl);
    await f('http://old.test/v1/workspaces/provision', { method: 'POST', body: '{"name":"a"}' });
    resetWorkspaceRouteMemory();
    await f(new Request('http://old.test/v1/invites/abc/accept', { method: 'POST', body: '{"x":1}' }));
    expect(s.seen).toEqual([
      { method: 'POST', url: 'http://old.test/v1/workspaces/provision', body: '{"name":"a"}' },
      { method: 'POST', url: 'http://old.test/v1/projects/provision', body: '{"name":"a"}' },
      { method: 'POST', url: 'http://old.test/v1/invites/abc/accept', body: '{"x":1}' },
      { method: 'POST', url: 'http://old.test/v1/account-invites/abc/accept', body: '{"x":1}' },
    ]);
  });

  test('a current server: a legacy-only route under the canonical prefix retries once and the base stays canonical', async () => {
    // The current API serves `/provision` (and quota, transfer, …) on `/v1/projects` only:
    // the unknown-route 404 there says nothing about the rest of the canonical names.
    const s = server({ canonical: true });
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : String(input);
      if (url.endsWith('/v1/workspaces/provision')) {
        await s.fetchImpl(input, init);
        return Response.json({ error: true, message: 'Not found', status: 404 }, { status: 404 });
      }
      return s.fetchImpl(input, init);
    };
    const f = withWorkspaceRouteFallback(fetchImpl);
    await f('http://new.test/v1/workspaces/provision', { method: 'POST', body: '{"name":"a"}' });
    await f('http://new.test/v1/workspaces');
    expect(s.seen.map((r) => r.url)).toEqual([
      'http://new.test/v1/workspaces/provision',
      'http://new.test/v1/projects/provision',
      'http://new.test/v1/workspaces',
    ]);
  });

  test('a path-only base (a Kortix App gate) is remembered too', async () => {
    const s = server({ canonical: false });
    const f = withWorkspaceRouteFallback(s.fetchImpl);
    await f('/_kortix/api/v1/workspaces/w1');
    await f('/_kortix/api/v1/workspaces/w1/secrets');
    expect(s.seen.map((r) => r.url)).toEqual([
      '/_kortix/api/v1/workspaces/w1',
      '/_kortix/api/v1/projects/w1',
      '/_kortix/api/v1/projects/w1/secrets',
    ]);
  });
});

describe('every SDK transport falls back', () => {
  let s: ReturnType<typeof server>;
  beforeEach(() => {
    s = server({ canonical: false });
    configureKortix({ backendUrl: 'http://old.test/v1', getToken: async () => 'tok', fetch: s.fetchImpl });
  });

  test('send()', async () => {
    const res = await send('http://old.test/v1/workspaces/w1/members');
    expect(res.status).toBe(200);
    expect(s.seen.map((r) => r.url)).toEqual([
      'http://old.test/v1/workspaces/w1/members',
      'http://old.test/v1/accounts/w1/members',
    ]);
  });

  test('backendApi', async () => {
    const res = await backendApi.post<{ path: string; body: string }>('/workspaces/w1/sessions', { title: 't' });
    expect(res.data).toEqual({ path: '/v1/projects/w1/sessions', method: 'POST', body: '{"title":"t"}' } as never);
  });

  test('authenticatedFetch', async () => {
    const res = await authenticatedFetch('http://old.test/v1/me');
    expect(res.status).toBe(200);
    expect(s.seen.map((r) => r.url)).toEqual(['http://old.test/v1/me', 'http://old.test/v1/accounts/me']);
  });
});

describe('a backendUrl with no /v1 segment (a same-origin proxy)', () => {
  test('backendApi falls back under the configured base', async () => {
    const seen: string[] = [];
    configureKortix({
      backendUrl: 'http://app.test/api/kortix',
      getToken: async () => 'tok',
      fetch: async (input: RequestInfo | URL) => {
        const url = String(input);
        seen.push(url);
        return url.includes('/api/kortix/workspaces/')
          ? Response.json({ error: true, message: 'Not found', status: 404 }, { status: 404 })
          : Response.json({ ok: true });
      },
    });
    const first = await backendApi.get('/workspaces/w1/sessions');
    const second = await backendApi.get('/me');
    expect(first.success && second.success).toBe(true);
    expect(seen).toEqual([
      'http://app.test/api/kortix/workspaces/w1/sessions',
      'http://app.test/api/kortix/projects/w1/sessions',
      'http://app.test/api/kortix/accounts/me',
    ]);
  });
});

