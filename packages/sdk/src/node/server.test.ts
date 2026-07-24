import { test, expect, beforeEach } from 'bun:test';
import { runWithKortix, createScopedKortix } from './server';
import { backendApi } from '../core/http/api-client';

// Importing `./server` pulls in `./platform/config-node`, which registers the
// AsyncLocalStorage resolver as an import-time side effect — this file is
// where that Node-only layer is actually exercised end-to-end (concurrent
// requests, different tokens, real interleaving via a deferred fetch).

let requests: { url: string; auth: string | null }[] = [];

beforeEach(() => {
  requests = [];
});

/** A `fetch` that resolves out of arrival order, so two "requests" genuinely
 *  interleave instead of trivially completing back-to-back. Each call blocks
 *  until `release()` is invoked for its index. */
function deferredFetch() {
  const resolvers: Array<(v: Response) => void> = [];
  const impl = async (input: unknown, init?: RequestInit) => {
    const req = input as Request;
    const auth = init?.headers
      ? new Headers(init.headers).get('Authorization')
      : req.headers?.get?.('Authorization') ?? null;
    const url = req.url ?? String(input);
    requests.push({ url, auth });
    const idx = requests.length - 1;
    return new Promise<Response>((resolve) => {
      resolvers[idx] = resolve;
    });
  };
  return {
    fetch: impl as unknown as typeof fetch,
    release: (idx: number) =>
      resolvers[idx](
        new Response(JSON.stringify({ ok: true, projects: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
  };
}

test('runWithKortix isolates two concurrent, interleaved requests with different tokens', async () => {
  const { fetch: fetchImpl, release } = deferredFetch();
  globalThis.fetch = fetchImpl;

  const results: string[] = [];

  const p1 = runWithKortix(
    { backendUrl: 'http://backend.local/v1', getToken: async () => 'token-ONE' },
    async () => {
      const res = await backendApi.get('/projects');
      results.push(`one:${res.success}`);
    },
  );

  const p2 = runWithKortix(
    { backendUrl: 'http://backend.local/v1', getToken: async () => 'token-TWO' },
    async () => {
      const res = await backendApi.get('/projects');
      results.push(`two:${res.success}`);
    },
  );

  // Let both requests reach the (deferred) fetch call before releasing either
  // — this is the actual concurrency assertion: both contexts are "in flight"
  // on the shared config seam at the same time.
  await new Promise((r) => setTimeout(r, 0));
  expect(requests.length).toBe(2);

  // Release out of arrival order (2 before 1) to prove isolation doesn't
  // depend on completion order either.
  release(1);
  release(0);
  await Promise.all([p1, p2]);

  expect(requests[0].auth).toBe('Bearer token-ONE');
  expect(requests[1].auth).toBe('Bearer token-TWO');
});

test('createScopedKortix never writes to the process-global config — two scoped clients stay isolated', async () => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const req = input as Request;
    const auth = init?.headers ? new Headers(init.headers).get('Authorization') : req.headers?.get?.('Authorization') ?? null;
    requests.push({ url: req.url ?? String(input), auth });
    return new Response(JSON.stringify({ ok: true, projects: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const kortixA = createScopedKortix({ backendUrl: 'http://backend.local/v1', getToken: async () => 'tok-A' });
  const kortixB = createScopedKortix({ backendUrl: 'http://backend.local/v1', getToken: async () => 'tok-B' });

  await Promise.all([kortixA.projects.list(), kortixB.projects.list()]);

  expect(requests.some((r) => r.auth === 'Bearer tok-A')).toBe(true);
  expect(requests.some((r) => r.auth === 'Bearer tok-B')).toBe(true);
});

test('createScopedKortix neutralizes the ambient top-level runtime() — no process-global cross-tenant sandbox bleed', () => {
  // The top-level runtime() resolves the PROCESS-GLOBAL "active" runtime (whatever
  // session most recently called ensureReady()). In a multi-tenant server that is
  // a DIFFERENT request's/end-user's sandbox — a cross-tenant leak. On a scoped
  // client it must throw and steer to the session-scoped handle, never silently
  // hand back a foreign sandbox's client.
  const kortix = createScopedKortix({
    backendUrl: 'http://backend.local/v1',
    getToken: async () => 'tok',
  });
  expect(() => kortix.runtime()).toThrow(/session\(/);
});

test('createScopedKortix leaves the rest of the facade intact (only top-level runtime() is neutralized)', () => {
  const kortix = createScopedKortix({
    backendUrl: 'http://backend.local/v1',
    getToken: async () => 'tok',
  });
  expect(typeof kortix.session).toBe('function');
  expect(typeof kortix.project).toBe('function');
  expect(typeof kortix.projects.list).toBe('function');
});

test('createScopedKortix scopes calls reached through id-bound handles minted at call time (project(id), session(pid, sid))', async () => {
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const req = input as Request;
    const auth = init?.headers ? new Headers(init.headers).get('Authorization') : req.headers?.get?.('Authorization') ?? null;
    requests.push({ url: req.url ?? String(input), auth });
    return new Response(JSON.stringify({ ok: true, secrets: [] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;

  const kortix = createScopedKortix({ backendUrl: 'http://backend.local/v1', getToken: async () => 'scoped-tok' });
  await kortix.project('PID1').secrets.list();

  expect(requests[0].url).toContain('/projects/PID1/secrets');
  expect(requests[0].auth).toBe('Bearer scoped-tok');
});
