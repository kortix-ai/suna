import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { backendApi, setAdminBypass } from './api-client';
import { ApiError, AuthError, BillingError } from './api/errors';
import { authenticatedFetch } from './auth';
import { configureKortix } from './config';
import { clearImpersonationSession, setImpersonationSession } from './impersonation';
import { send } from './transport';

// `send` is the one request path to the Kortix backend. These tests pin its
// interface: the header policy, token handling, the 401 replay and the deadline
// option. The adapters (`backendApi`, `authenticatedFetch`, `postStream`) are
// asserted at the end: they must all show the same policy.

type Seen = { url: string; headers: Headers; body: string | null; signal: AbortSignal | null };

let seen: Seen[] = [];
let tokens: Array<string | null> = [];
let tokenCalls = 0;
let statuses: number[] = [];

function configure(clientSource?: 'web' | 'cli') {
  configureKortix({
    backendUrl: 'http://backend.test/v1',
    clientSource,
    getToken: async () => {
      tokenCalls++;
      return tokens.length > 1 ? tokens.shift()! : (tokens[0] ?? null);
    },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : null;
      seen.push({
        url: request ? request.url : String(input),
        headers: new Headers(request ? request.headers : init?.headers),
        body: request ? await request.text() : typeof init?.body === 'string' ? init.body : null,
        signal: request ? request.signal : (init?.signal ?? null),
      });
      const status = statuses.length > 1 ? statuses.shift()! : (statuses[0] ?? 200);
      return new Response(JSON.stringify({ ok: status < 400 }), {
        status,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}

beforeEach(() => {
  seen = [];
  tokens = ['tok1'];
  tokenCalls = 0;
  statuses = [200];
  configure('web');
});

afterEach(() => {
  setAdminBypass(false);
  clearImpersonationSession();
  configureKortix({ backendUrl: '', getToken: async () => null });
});

const live = () => ({
  grantId: 'grant-1',
  accountId: 'acct-1',
  expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
});

describe('send: header policy', () => {
  test('attaches the bearer and the client surface', async () => {
    await send('http://backend.test/v1/projects');
    expect(seen[0].headers.get('authorization')).toBe('Bearer tok1');
    expect(seen[0].headers.get('x-kortix-client')).toBe('web');
  });

  test('attaches admin bypass and act-as while they are on', async () => {
    setAdminBypass(true);
    setImpersonationSession(live());
    await send('http://backend.test/v1/p/ext-1/8000/session');
    expect(seen[0].headers.get('x-kortix-admin-bypass')).toBe('1');
    expect(seen[0].headers.get('x-kortix-impersonate')).toBe('grant-1');
  });

  test('never attaches act-as to the admin console', async () => {
    setImpersonationSession(live());
    await send('http://backend.test/v1/admin/api/impersonate/grant-1', { method: 'DELETE' });
    expect(seen[0].headers.has('x-kortix-impersonate')).toBe(false);
  });

  test("keeps a caller's own Authorization and X-Kortix-Client", async () => {
    await send('http://backend.test/v1/x', {
      headers: { Authorization: 'Bearer explicit', 'X-Kortix-Client': 'cli' },
    });
    expect(seen[0].headers.get('authorization')).toBe('Bearer explicit');
    expect(seen[0].headers.get('x-kortix-client')).toBe('cli');
  });

  test('a URL request carries its headers as a plain record with stable names', async () => {
    let raw: HeadersInit | undefined;
    configureKortix({
      backendUrl: 'http://backend.test/v1',
      getToken: async () => 'tok1',
      fetch: async (_input, init) => {
        raw = init?.headers;
        return new Response('{}');
      },
    });
    await send('http://backend.test/v1/x', { headers: { 'Content-Type': 'application/json' } });
    expect(raw).toEqual({ 'Content-Type': 'application/json', Authorization: 'Bearer tok1' });
  });

  test('a Request input keeps its body and gets the headers on the Request', async () => {
    await send(
      new Request('http://backend.test/v1/p/ext/8000/session/s/message', {
        method: 'POST',
        body: '{"text":"hi"}',
        headers: { 'content-type': 'application/json' },
      }),
    );
    expect(seen[0].body).toBe('{"text":"hi"}');
    expect(seen[0].headers.get('authorization')).toBe('Bearer tok1');
    expect(seen[0].headers.get('content-type')).toBe('application/json');
  });
});

describe('send: token', () => {
  test('without a token it throws AuthError and sends nothing', async () => {
    tokens = [null];
    const error = await send('http://backend.test/v1/x').catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AuthError);
    expect(seen).toHaveLength(0);
  });

  test('an explicit token is used without asking getToken', async () => {
    await send('http://backend.test/v1/x', {}, { token: 'given' });
    expect(tokenCalls).toBe(0);
    expect(seen[0].headers.get('authorization')).toBe('Bearer given');
  });

  test('an already aborted signal throws AbortError before asking for a token', async () => {
    const abort = new AbortController();
    abort.abort();
    const error = await send('http://backend.test/v1/x', { signal: abort.signal }).catch((e: unknown) => e);
    expect((error as Error).name).toBe('AbortError');
    expect(tokenCalls).toBe(0);
    expect(seen).toHaveLength(0);
  });
});

describe('send: 401 replay', () => {
  test('a 401 is replayed once with the fresh token and the same body', async () => {
    tokens = ['tok1', 'tok2'];
    statuses = [401, 200];
    const response = await send('http://backend.test/v1/x', { method: 'POST', body: '{"a":1}' });
    expect(response.status).toBe(200);
    expect(seen.map((s) => [s.headers.get('authorization'), s.body])).toEqual([
      ['Bearer tok1', '{"a":1}'],
      ['Bearer tok2', '{"a":1}'],
    ]);
  });

  test('a 401 is returned when the token did not change', async () => {
    statuses = [401];
    const response = await send('http://backend.test/v1/x');
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(1);
  });

  test('retryOnAuthError: false returns the first 401', async () => {
    tokens = ['tok1', 'tok2'];
    statuses = [401, 200];
    const response = await send('http://backend.test/v1/x', {}, { retryOnAuthError: false });
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(1);
  });
});

describe('send: deadline', () => {
  test('timeoutMs: null leaves the caller signal as the only deadline', async () => {
    const abort = new AbortController();
    await send('http://backend.test/v1/x', { signal: abort.signal }, { timeoutMs: null });
    expect(seen[0].signal).toBe(abort.signal);
  });

  test('the default deadline is composed with the caller signal', async () => {
    const abort = new AbortController();
    await send('http://backend.test/v1/x', { signal: abort.signal });
    expect(seen[0].signal).not.toBe(abort.signal);
    abort.abort();
    expect(seen[0].signal?.aborted).toBe(true);
  });
});

describe('every adapter applies the same policy', () => {
  test('authenticatedFetch attaches act-as and admin bypass (it used to drop both)', async () => {
    setAdminBypass(true);
    setImpersonationSession(live());
    await authenticatedFetch('http://backend.test/v1/p/ext-1/8000/file/content?path=a');
    expect(seen[0].headers.get('x-kortix-impersonate')).toBe('grant-1');
    expect(seen[0].headers.get('x-kortix-admin-bypass')).toBe('1');
  });

  test('authenticatedFetch still answers a missing token with a synthetic 401', async () => {
    tokens = [null];
    const response = await authenticatedFetch('http://backend.test/v1/x');
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  test('backendApi replays a 401 once with the fresh token (it used to fail)', async () => {
    tokens = ['tok1', 'tok2'];
    statuses = [401, 200];
    const result = await backendApi.post('/projects', { name: 'n' }, { showErrors: false });
    expect(result.success).toBe(true);
    expect(seen.map((s) => s.headers.get('authorization'))).toEqual(['Bearer tok1', 'Bearer tok2']);
    expect(seen[1].body).toBe('{"name":"n"}');
  });

  test('backendApi without a token returns AuthError and sends nothing', async () => {
    tokens = [null];
    const result = await backendApi.get('/projects');
    expect(result.error).toBeInstanceOf(AuthError);
    expect(seen).toHaveLength(0);
  });

  test('postStream sends through the same policy', async () => {
    setImpersonationSession(live());
    const response = await backendApi.postStream('/projects/p/provision/stream', { a: 1 });
    expect(response.status).toBe(200);
    expect(seen[0].url).toBe('http://backend.test/v1/projects/p/provision/stream');
    expect(seen[0].headers.get('authorization')).toBe('Bearer tok1');
    expect(seen[0].headers.get('accept')).toBe('text/event-stream');
    expect(seen[0].headers.get('x-kortix-impersonate')).toBe('grant-1');
  });

  test('postStream without a token answers 401 and sends nothing unauthenticated', async () => {
    tokens = [null];
    const response = await backendApi.postStream('/projects/p/provision/stream', {});
    expect(response.status).toBe(401);
    expect(seen).toHaveLength(0);
  });
});

describe('error typing', () => {
  test('a 402 is a BillingError that is also an ApiError with the body code', async () => {
    configureKortix({
      backendUrl: 'http://backend.test/v1',
      getToken: async () => 'tok1',
      fetch: async () =>
        new Response(JSON.stringify({ error: 'Budget exceeded', code: 'app_budget_exceeded', balance: 0 }), {
          status: 402,
          headers: { 'content-type': 'application/json' },
        }),
    });
    const { error } = await backendApi.get('/x', { showErrors: false });
    expect(error).toBeInstanceOf(BillingError);
    expect(error).toBeInstanceOf(ApiError);
    expect(error?.status).toBe(402);
    expect(error?.code).toBe('app_budget_exceeded');
    expect(error?.message).toBe('Budget exceeded');
  });

  test('a non-JSON error body is still a typed ApiError with its status', async () => {
    configureKortix({
      backendUrl: 'http://backend.test/v1',
      getToken: async () => 'tok1',
      fetch: async () => new Response('<html>Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
    });
    const { error } = await backendApi.post('/x', {}, { showErrors: false });
    expect(error).toBeInstanceOf(ApiError);
    expect(error?.status).toBe(502);
  });
});

describe('client surface', () => {
  test('tui is sent; an unknown configured surface is not', async () => {
    configureKortix({
      backendUrl: 'http://backend.test/v1',
      clientSource: 'tui',
      getToken: async () => 'tok1',
      fetch: async (_input, init) => {
        seen.push({ url: '', headers: new Headers(init?.headers), body: null, signal: null });
        return new Response('{}');
      },
    });
    await send('http://backend.test/v1/x');
    configureKortix({
      backendUrl: 'http://backend.test/v1',
      clientSource: 'forged-source' as 'web',
      getToken: async () => 'tok1',
      fetch: async (_input, init) => {
        seen.push({ url: '', headers: new Headers(init?.headers), body: null, signal: null });
        return new Response('{}');
      },
    });
    await send('http://backend.test/v1/x');
    expect(seen.map((s) => s.headers.get('x-kortix-client'))).toEqual(['tui', null]);
  });
});
