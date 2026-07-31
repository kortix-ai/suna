import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { platformConfig } from '@kortix/sdk';

import { ApiError, clientFromAuth, createApiClient } from './client.ts';
import type { Auth } from './auth.ts';

const originalFetch = globalThis.fetch;

interface Captured {
  url: string;
  method: string;
  authorization: string | null;
  contentType: string | null;
  body: string | null;
  backendUrlInScope: string;
}

let captured: Captured[] = [];

function stubFetch(status: number, payload: unknown): void {
  captured = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers as HeadersInit | undefined);
    captured.push({
      url: typeof input === 'string' ? input : String(input),
      method: init?.method ?? 'GET',
      authorization: headers.get('authorization'),
      contentType: headers.get('content-type'),
      body: typeof init?.body === 'string' ? init.body : null,
      backendUrlInScope: platformConfig().backendUrl,
    });
    return new Response(typeof payload === 'string' ? payload : JSON.stringify(payload), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}

function auth(overrides: Partial<Auth> = {}): Auth {
  return {
    api_base: 'https://api.kortix.com',
    token: 'kortix_pat_test',
    user_id: 'u1',
    user_email: 'u@example.com',
    account_id: 'a1',
    logged_in_at: '2026-07-30T00:00:00.000Z',
    ...overrides,
  };
}

describe('createApiClient transport', () => {
  beforeEach(() => {
    globalThis.fetch = originalFetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('routes every request through the SDK platform seam', async () => {
    stubFetch(200, { ok: true });
    await createApiClient({ apiBase: 'https://api.kortix.com', token: 't' }).get('/accounts/me');
    expect(captured[0]!.backendUrlInScope).toBe('https://api.kortix.com/v1');
  });

  test('mounts a bare path under the version prefix exactly once', async () => {
    stubFetch(200, { ok: true });
    await createApiClient({ apiBase: 'https://api.kortix.com', token: 't' }).get('/accounts/me');
    expect(captured[0]!.url).toBe('https://api.kortix.com/v1/accounts/me');
  });

  test('does not double the version prefix for a sandbox-injected base', async () => {
    stubFetch(200, { ok: true });
    await createApiClient({ apiBase: 'https://tunnel.example.com/v1', token: 't' }).get('/projects');
    expect(captured[0]!.url).toBe('https://tunnel.example.com/v1/projects');
  });

  test('sends the auth token as a bearer', async () => {
    stubFetch(200, { ok: true });
    await createApiClient({ apiBase: 'https://api.kortix.com', token: 'kortix_pat_x' }).get('/projects');
    expect(captured[0]!.authorization).toBe('Bearer kortix_pat_x');
  });

  test('returns the parsed payload', async () => {
    stubFetch(200, { project_id: 'p1' });
    const out = await createApiClient({ apiBase: 'https://api.kortix.com', token: 't' }).get<{
      project_id: string;
    }>('/projects/p1');
    expect(out).toEqual({ project_id: 'p1' });
  });

  test('serializes a POST body as json', async () => {
    stubFetch(200, { ok: true });
    await createApiClient({ apiBase: 'https://api.kortix.com', token: 't' }).post('/projects', {
      name: 'demo',
    });
    expect(captured[0]!.method).toBe('POST');
    expect(captured[0]!.body).toBe('{"name":"demo"}');
    expect(captured[0]!.contentType).toBe('application/json');
  });

  test('appends account_id when the client is account-scoped', async () => {
    stubFetch(200, []);
    await createApiClient({ apiBase: 'https://api.kortix.com', token: 't', accountId: 'acc_1' }).get(
      '/projects',
    );
    expect(captured[0]!.url).toBe('https://api.kortix.com/v1/projects?account_id=acc_1');
  });

  test('merges account_id into an existing query string', async () => {
    stubFetch(200, []);
    await createApiClient({ apiBase: 'https://api.kortix.com', token: 't', accountId: 'acc_1' }).get(
      '/projects?limit=5',
    );
    expect(captured[0]!.url).toBe('https://api.kortix.com/v1/projects?limit=5&account_id=acc_1');
  });

  test('never overrides an account_id the caller already set', async () => {
    stubFetch(200, []);
    await createApiClient({ apiBase: 'https://api.kortix.com', token: 't', accountId: 'acc_1' }).get(
      '/projects?account_id=acc_explicit',
    );
    expect(captured[0]!.url).toBe('https://api.kortix.com/v1/projects?account_id=acc_explicit');
  });

  test('preserves the http status on the thrown ApiError', async () => {
    stubFetch(404, { error: 'Session not found' });
    const client = createApiClient({ apiBase: 'https://api.kortix.com', token: 't' });
    await expect(client.get('/projects/p/sessions/missing')).rejects.toMatchObject({
      status: 404,
      message: 'Session not found',
    });
  });

  test('surfaces a message field error body', async () => {
    stubFetch(402, { message: 'Out of credits' });
    const client = createApiClient({ apiBase: 'https://api.kortix.com', token: 't' });
    await expect(client.get('/projects')).rejects.toMatchObject({ status: 402, message: 'Out of credits' });
  });

  test('throws an ApiError instance so existing status branching keeps working', async () => {
    stubFetch(409, { error: 'conflict' });
    const client = createApiClient({ apiBase: 'https://api.kortix.com', token: 't' });
    const err = (await client.get('/projects').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(409);
  });

  test('reports a network failure as status 0', async () => {
    captured = [];
    globalThis.fetch = (async () => {
      throw new TypeError('connect ECONNREFUSED');
    }) as unknown as typeof fetch;
    const client = createApiClient({ apiBase: 'https://api.kortix.com', token: 't' });
    const err = (await client.get('/projects').catch((e: unknown) => e)) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.status).toBe(0);
  });

  test('clientFromAuth binds the stored host base and token', async () => {
    stubFetch(200, { ok: true });
    await clientFromAuth(auth({ api_base: 'http://localhost:14108' })).get('/accounts/me');
    expect(captured[0]!.url).toBe('http://localhost:14108/v1/accounts/me');
    expect(captured[0]!.authorization).toBe('Bearer kortix_pat_test');
  });
});
